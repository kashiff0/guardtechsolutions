-- ============================================================================
-- GTS — Phase 3 shared database (Supabase / Postgres)
-- One migration: extensions, tables, role helper, triggers, and RLS.
-- Run this once in the Supabase SQL Editor (Dashboard → SQL → New query → Run).
-- Idempotent-ish: safe to re-run during setup (uses IF NOT EXISTS / OR REPLACE).
-- ============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ----------------------------------------------------------------------------
-- profiles : one row per auth user; carries role + display info for the portal
-- ----------------------------------------------------------------------------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text,
  title       text,
  role        text not null default 'employee' check (role in ('admin','employee')),
  pay_rate    numeric not null default 18,
  created_at  timestamptz not null default now()
);

-- admin check used by every RLS policy. SECURITY DEFINER so it can read
-- profiles without recursing into profiles' own RLS.
create or replace function public.is_admin()
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p where p.id = auth.uid() and p.role = 'admin'
  );
$$;

-- auto-create a profile when a new auth user signs up; role/name come from the
-- metadata passed at creation time (see scripts/createUser.js), default employee.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, title, role)
  values (
    new.id,
    new.raw_user_meta_data->>'full_name',
    new.raw_user_meta_data->>'title',
    coalesce(new.raw_user_meta_data->>'role', 'employee')
  )
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ----------------------------------------------------------------------------
-- leads : superset of the campaign model + the portal's CRM fields
-- ----------------------------------------------------------------------------
create table if not exists public.leads (
  id                uuid primary key default gen_random_uuid(),
  -- campaign fields
  first_name        text,
  last_name         text,
  email             text,
  phone             text,
  company           text,
  title             text,
  vertical          text not null default 'property_manager',
  linkedin_url      text,
  linkedin_name     text,
  location          text,
  about             text,
  source            text default 'manual',
  status            text not null default 'discovered',
  campaign_id       text default 'cold_outreach',
  sequence_step     integer not null default 0,
  score             integer not null default 50,
  enriched          boolean not null default false,
  last_contacted_at timestamptz,
  -- portal CRM fields
  value             numeric default 0,
  specialty         text,
  next_step         text,
  next_step_due     date,
  pipeline_stage    text not null default 'New'
                      check (pipeline_stage in ('New','Contacted','Demo Sent','Proposal','Won','Lost')),
  -- bookkeeping
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists idx_leads_status   on public.leads(status);
create index if not exists idx_leads_stage     on public.leads(pipeline_stage);
create index if not exists idx_leads_vertical  on public.leads(vertical);
create index if not exists idx_leads_campaign  on public.leads(campaign_id);

-- canonical status -> portal pipeline_stage bucket
create or replace function public.stage_for_status(p_status text)
returns text language sql immutable as $$
  select case p_status
    when 'discovered' then 'New'
    when 'enriched'   then 'New'
    when 'linkedin_connection_sent' then 'Contacted'
    when 'linkedin_accepted'        then 'Contacted'
    when 'linkedin_messaged'        then 'Contacted'
    when 'email_queued'             then 'Contacted'
    when 'email_sequence'           then 'Contacted'
    when 'replied'                  then 'Contacted'
    when 'qualified'                then 'Proposal'
    when 'meeting_booked'           then 'Proposal'
    when 'closed_won'               then 'Won'
    when 'closed_lost'              then 'Lost'
    when 'unsubscribed'             then 'Lost'
    when 'do_not_contact'           then 'Lost'
    else 'New'
  end;
$$;

-- keep updated_at fresh, and re-derive pipeline_stage ONLY when status changes
-- (so an admin's manual kanban move — incl. the campaign-less 'Demo Sent' — sticks).
create or replace function public.leads_touch()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  if (tg_op = 'INSERT') or (new.status is distinct from old.status) then
    new.pipeline_stage := public.stage_for_status(new.status);
  end if;
  return new;
end; $$;

drop trigger if exists trg_leads_touch on public.leads;
create trigger trg_leads_touch
  before insert or update on public.leads
  for each row execute function public.leads_touch();

-- ----------------------------------------------------------------------------
-- lead_notes : append-only notes (portal CRM + agent reply-qualification)
-- ----------------------------------------------------------------------------
create table if not exists public.lead_notes (
  id         uuid primary key default gen_random_uuid(),
  lead_id    uuid not null references public.leads(id) on delete cascade,
  body       text not null,
  author     text,
  created_at timestamptz not null default now()
);
create index if not exists idx_lead_notes_lead on public.lead_notes(lead_id);

-- ----------------------------------------------------------------------------
-- touches : outreach history. status 'draft'/'queued' let the portal review
-- and approve a message before the email agent actually sends it.
-- ----------------------------------------------------------------------------
create table if not exists public.touches (
  id            uuid primary key default gen_random_uuid(),
  lead_id       uuid not null references public.leads(id) on delete cascade,
  channel       text not null,            -- email | linkedin
  type          text not null,            -- intro | follow_up | breakup | connection | message
  sequence_step integer,
  status        text not null default 'sent',  -- draft|queued|sent|opened|replied|error
  message_id    text,
  subject       text,
  body          text,
  sent_at       timestamptz default now(),
  opened_at     timestamptz,
  replied_at    timestamptz,
  error         text
);
create index if not exists idx_touches_lead   on public.touches(lead_id);
create index if not exists idx_touches_status on public.touches(status);

-- ----------------------------------------------------------------------------
-- campaign_runs : orchestrator run log (1:1 with the old SQLite table)
-- ----------------------------------------------------------------------------
create table if not exists public.campaign_runs (
  id              uuid primary key default gen_random_uuid(),
  started_at      timestamptz not null default now(),
  completed_at    timestamptz,
  leads_processed integer default 0,
  emails_sent     integer default 0,
  linkedin_sent   integer default 0,
  errors          integer default 0,
  notes           text
);

-- ----------------------------------------------------------------------------
-- time_entries : clock in / out (portal)
-- ----------------------------------------------------------------------------
create table if not exists public.time_entries (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  clock_in   timestamptz not null default now(),
  clock_out  timestamptz
);
create index if not exists idx_time_profile on public.time_entries(profile_id);

-- ----------------------------------------------------------------------------
-- shifts : weekly schedule (portal)
-- ----------------------------------------------------------------------------
create table if not exists public.shifts (
  id         uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  date       date not null,
  start_time text not null,
  end_time   text not null,
  site       text
);
create index if not exists idx_shifts_profile on public.shifts(profile_id);
create index if not exists idx_shifts_date    on public.shifts(date);

-- ============================================================================
-- ROW LEVEL SECURITY
-- Agents use the service_role key, which bypasses RLS entirely. These policies
-- govern the portal (anon/auth users via supabase-js).
-- ============================================================================
alter table public.profiles      enable row level security;
alter table public.leads         enable row level security;
alter table public.lead_notes    enable row level security;
alter table public.touches       enable row level security;
alter table public.campaign_runs enable row level security;
alter table public.time_entries  enable row level security;
alter table public.shifts        enable row level security;

-- profiles: any authenticated user may read (schedule needs names); write self or admin
drop policy if exists profiles_read   on public.profiles;
drop policy if exists profiles_write  on public.profiles;
drop policy if exists profiles_update on public.profiles;
create policy profiles_read   on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid() or public.is_admin()) with check (id = auth.uid() or public.is_admin());
create policy profiles_write  on public.profiles for insert to authenticated
  with check (public.is_admin());

-- leads / lead_notes / touches / campaign_runs: ADMIN ONLY (employees blocked)
drop policy if exists leads_admin         on public.leads;
drop policy if exists lead_notes_admin    on public.lead_notes;
drop policy if exists touches_admin       on public.touches;
drop policy if exists campaign_runs_admin on public.campaign_runs;
create policy leads_admin         on public.leads         for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy lead_notes_admin    on public.lead_notes    for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy touches_admin       on public.touches       for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy campaign_runs_admin on public.campaign_runs for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- time_entries: employee reads/writes OWN rows; admin everything
drop policy if exists time_select on public.time_entries;
drop policy if exists time_write  on public.time_entries;
drop policy if exists time_update on public.time_entries;
create policy time_select on public.time_entries for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());
create policy time_write  on public.time_entries for insert to authenticated
  with check (profile_id = auth.uid() or public.is_admin());
create policy time_update on public.time_entries for update to authenticated
  using (profile_id = auth.uid() or public.is_admin()) with check (profile_id = auth.uid() or public.is_admin());

-- shifts: employee reads OWN; admin full CRUD
drop policy if exists shifts_select on public.shifts;
drop policy if exists shifts_admin  on public.shifts;
create policy shifts_select on public.shifts for select to authenticated
  using (profile_id = auth.uid() or public.is_admin());
create policy shifts_admin  on public.shifts for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ============================================================================
-- Done. Next: create your first admin with  npm run create-user  (service key),
-- then migrate real leads with  npm run migrate.
-- ============================================================================
