# Supabase setup (Phase 3 — shared database)

This is the one-time setup that connects the **portal** and the **campaign agents**
to a single hosted database. Do these steps, then send me the three values in step 3.

## 1. Create the project
1. Go to https://supabase.com → **New project** (free tier is fine).
2. Pick a name (e.g. `gts`) and a strong database password. Region: closest to Houston (e.g. `us-east-1`).
3. Wait ~2 min for it to provision.

## 2. Create the schema
1. In the project: **SQL Editor → New query**.
2. Paste the entire contents of [`migration.sql`](./migration.sql) and click **Run**.
3. You should see "Success. No rows returned." Check **Table Editor** — you'll see
   `profiles, leads, lead_notes, touches, campaign_runs, time_entries, shifts`.

## 3. Grab your keys  →  Project Settings → API
Send me (or fill in yourself):

| Value | Where | Used by |
|---|---|---|
| **Project URL** | API → Project URL | portal **and** agents |
| **anon public** key | API → Project API keys → `anon` | **portal** (safe to ship in the static page; RLS protects data) |
| **service_role** key | API → Project API keys → `service_role` | **agents only** — goes in `campaign/.env`, **never** in the portal |

## 4. Point the campaign agents at it
```bash
cd campaign
cp .env.example .env          # then fill in SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
npm install
```

## 5. Create your first admin login
```bash
npm run create-user -- --email you@guardtechsolutions.com --password 'ChangeMe123!' --name "Geovonni O." --role admin --title "Owner / Admin"
```
Add employees the same way with `--role employee`. (Or, later, from the portal's admin UI.)

## 6. Migrate the real leads in
```bash
npm run migrate -- --file ../../KM-GTS/published-leads.json
```
"Start clean with real data" — only the real published prospects are imported (no demo staff/sample leads).

## 7. Verify
```bash
npm run report     # should list the migrated leads by status/vertical
```
Then I wire the portal to `SUPABASE_URL` + the anon key and we test login + RLS end-to-end.

---
### Security notes
- The **service_role** key bypasses Row-Level Security — it lives only in `campaign/.env` (gitignored). Never put it in `portal.html`.
- The portal uses the **anon** key; RLS policies (in `migration.sql`) enforce that employees can't read leads/CRM and only see their own hours/shifts.
