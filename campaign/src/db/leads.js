/**
 * Lead data access — Supabase (service role).
 * Every function is async; the shapes returned match the old SQLite rows so the
 * agents only needed `await` added. `notes` is no longer a column — it lives in
 * the lead_notes table, so createLead/updateLeadStatus redirect a `notes` value
 * into addNote().
 */
import { supabase } from './supabase.js';

export const LEAD_STATUS = {
  DISCOVERED: 'discovered',
  ENRICHED: 'enriched',
  LINKEDIN_SENT: 'linkedin_connection_sent',
  LINKEDIN_ACCEPTED: 'linkedin_accepted',
  LINKEDIN_MESSAGED: 'linkedin_messaged',
  EMAIL_QUEUED: 'email_queued',
  EMAIL_SEQUENCE: 'email_sequence',
  REPLIED: 'replied',
  QUALIFIED: 'qualified',
  MEETING_BOOKED: 'meeting_booked',
  CLOSED_WON: 'closed_won',
  CLOSED_LOST: 'closed_lost',
  UNSUBSCRIBED: 'unsubscribed',
  DO_NOT_CONTACT: 'do_not_contact'
};

const ACTIVE_LINKEDIN_STATUSES = ['enriched', 'discovered'];

export async function addNote(leadId, body, author = 'campaign') {
  if (!body) return;
  const { error } = await supabase.from('lead_notes').insert({ lead_id: leadId, body, author });
  if (error) throw new Error(`addNote: ${error.message}`);
}

export async function createLead(data) {
  const { notes, ...rest } = data;
  const row = {
    first_name: rest.first_name || '',
    last_name: rest.last_name || null,
    email: rest.email || null,
    phone: rest.phone || null,
    company: rest.company || null,
    title: rest.title || null,
    vertical: rest.vertical || 'property_manager',
    linkedin_url: rest.linkedin_url || null,
    linkedin_name: rest.linkedin_name || null,
    location: rest.location || null,
    about: rest.about || null,
    source: rest.source || 'manual',
    status: LEAD_STATUS.DISCOVERED,
    campaign_id: rest.campaign_id || 'cold_outreach',
    score: rest.score ?? 50
  };
  const { data: inserted, error } = await supabase.from('leads').insert(row).select().single();
  if (error) throw new Error(`createLead: ${error.message}`);
  if (notes) await addNote(inserted.id, notes, 'import');
  return inserted;
}

export async function getLead(id) {
  const { data, error } = await supabase.from('leads').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`getLead: ${error.message}`);
  return data;
}

export async function getLeadByEmail(email) {
  if (!email) return null;
  const { data, error } = await supabase.from('leads').select('*').eq('email', email).limit(1);
  if (error) throw new Error(`getLeadByEmail: ${error.message}`);
  return data?.[0] || null;
}

/**
 * Update a lead. Pass status=undefined to leave status unchanged (e.g. just
 * bumping sequence_step). A `notes` key in extra is redirected to lead_notes.
 */
export async function updateLeadStatus(id, status, extra = {}) {
  const { notes, ...rest } = extra;
  const updates = { ...rest };
  if (status !== undefined) updates.status = status;
  if (Object.keys(updates).length) {
    const { error } = await supabase.from('leads').update(updates).eq('id', id);
    if (error) throw new Error(`updateLeadStatus: ${error.message}`);
  }
  if (notes) await addNote(id, notes, 'campaign');
}

export async function updateLeadStep(id, step) {
  await updateLeadStatus(id, undefined, { sequence_step: step });
}

/** Mark a lead enriched, applying any discovered field updates in the same write. */
export async function markEnriched(id, updates = {}) {
  const { notes, ...rest } = updates;
  const { error } = await supabase.from('leads').update({ ...rest, enriched: true }).eq('id', id);
  if (error) throw new Error(`markEnriched: ${error.message}`);
  if (notes) await addNote(id, notes, 'enrichment');
}

export async function getLeadsForEnrichment(limit = 20) {
  const { data, error } = await supabase.from('leads').select('*')
    .eq('status', 'discovered').eq('enriched', false)
    .order('created_at', { ascending: true }).limit(limit);
  if (error) throw new Error(`getLeadsForEnrichment: ${error.message}`);
  return data || [];
}

export async function getLeadsForLinkedIn(limit = 15) {
  const { data, error } = await supabase.from('leads').select('*')
    .in('status', ACTIVE_LINKEDIN_STATUSES).not('linkedin_url', 'is', null)
    .order('score', { ascending: false }).order('created_at', { ascending: true }).limit(limit);
  if (error) throw new Error(`getLeadsForLinkedIn: ${error.message}`);
  return data || [];
}

export async function getLeadsForEmail(limit = 50) {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase.from('leads').select('*')
    .in('status', ['linkedin_accepted', 'email_queued', 'email_sequence'])
    .not('email', 'is', null)
    .or(`last_contacted_at.is.null,last_contacted_at.lt.${cutoff}`)
    .order('score', { ascending: false }).order('last_contacted_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`getLeadsForEmail: ${error.message}`);
  return data || [];
}

export async function getNextLinkedInProfile() {
  const rows = await getLeadsForLinkedIn(1);
  return rows[0] || null;
}

/** True if a lead matching this candidate (email / linkedin_url / name+company) already exists. */
export async function findDuplicate(lead) {
  const hit = async (col, val) => {
    if (!val) return false;
    const { data } = await supabase.from('leads').select('id').eq(col, val).limit(1);
    return !!(data && data.length);
  };
  if (await hit('email', lead.email)) return true;
  if (await hit('linkedin_url', lead.linkedin_url)) return true;
  if (lead.first_name && lead.company) {
    const { data } = await supabase.from('leads').select('id')
      .eq('first_name', lead.first_name).eq('company', lead.company).limit(1);
    if (data && data.length) return true;
  }
  return false;
}

export async function searchLeads({ vertical, status, campaign, query } = {}) {
  let q = supabase.from('leads').select('*');
  if (vertical) q = q.eq('vertical', vertical);
  if (status) q = q.eq('status', status);
  if (campaign) q = q.eq('campaign_id', campaign);
  if (query) {
    const like = `%${query}%`;
    q = q.or(`first_name.ilike.${like},last_name.ilike.${like},company.ilike.${like},email.ilike.${like}`);
  }
  const { data, error } = await q
    .order('score', { ascending: false }).order('created_at', { ascending: false }).limit(200);
  if (error) throw new Error(`searchLeads: ${error.message}`);
  return data || [];
}

/** [{ status, count }] sorted desc — aggregated client-side (small dataset). */
export async function getStats() {
  const { data, error } = await supabase.from('leads').select('status');
  if (error) throw new Error(`getStats: ${error.message}`);
  const counts = {};
  for (const { status } of data || []) counts[status] = (counts[status] || 0) + 1;
  return Object.entries(counts).map(([status, count]) => ({ status, count }))
    .sort((a, b) => b.count - a.count);
}
