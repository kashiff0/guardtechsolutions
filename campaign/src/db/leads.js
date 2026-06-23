import { v4 as uuidv4 } from 'uuid';
import { getDb } from './schema.js';

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

export function createLead(data) {
  const db = getDb();
  const id = uuidv4();
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO leads (
      id, first_name, last_name, email, phone, company, title,
      vertical, linkedin_url, linkedin_name, location, about,
      source, status, campaign_id, score, notes, created_at, updated_at
    ) VALUES (
      @id, @first_name, @last_name, @email, @phone, @company, @title,
      @vertical, @linkedin_url, @linkedin_name, @location, @about,
      @source, @status, @campaign_id, @score, @notes, @created_at, @updated_at
    )
  `).run({
    id,
    first_name: data.first_name || '',
    last_name: data.last_name || null,
    email: data.email || null,
    phone: data.phone || null,
    company: data.company || null,
    title: data.title || null,
    vertical: data.vertical || 'restaurant',
    linkedin_url: data.linkedin_url || null,
    linkedin_name: data.linkedin_name || null,
    location: data.location || null,
    about: data.about || null,
    source: data.source || 'manual',
    status: LEAD_STATUS.DISCOVERED,
    campaign_id: data.campaign_id || 'cold_outreach',
    score: data.score || 50,
    notes: data.notes || null,
    created_at: now,
    updated_at: now
  });

  return getLead(id);
}

export function getLead(id) {
  return getDb().prepare('SELECT * FROM leads WHERE id = ?').get(id);
}

export function updateLeadStatus(id, status, extra = {}) {
  const db = getDb();
  const updates = { status, updated_at: new Date().toISOString(), ...extra };

  const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE leads SET ${fields} WHERE id = @id`).run({ ...updates, id });
}

export function updateLeadStep(id, step) {
  updateLeadStatus(id, undefined, { sequence_step: step });
}

export function getLeadsForEnrichment(limit = 20) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status = 'discovered' AND enriched = 0
    ORDER BY created_at ASC
    LIMIT ?
  `).all(limit);
}

export function getLeadsForLinkedIn(limit = 15) {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status IN ('enriched', 'discovered')
    AND linkedin_url IS NOT NULL
    ORDER BY score DESC, created_at ASC
    LIMIT ?
  `).all(limit);
}

export function getLeadsForEmail(limit = 50) {
  const cutoff = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status IN ('linkedin_accepted', 'email_queued', 'email_sequence')
    AND email IS NOT NULL
    AND (last_contacted_at IS NULL OR last_contacted_at < ?)
    AND status != 'unsubscribed'
    AND status != 'do_not_contact'
    ORDER BY score DESC, last_contacted_at ASC
    LIMIT ?
  `).all(cutoff, limit);
}

export function getNextLinkedInProfile() {
  return getDb().prepare(`
    SELECT * FROM leads
    WHERE status IN ('enriched', 'discovered')
    AND linkedin_url IS NOT NULL
    ORDER BY score DESC, created_at ASC
    LIMIT 1
  `).get();
}

export function searchLeads({ vertical, status, campaign, query } = {}) {
  const db = getDb();
  const conditions = [];
  const params = {};

  if (vertical) { conditions.push('vertical = @vertical'); params.vertical = vertical; }
  if (status) { conditions.push('status = @status'); params.status = status; }
  if (campaign) { conditions.push('campaign_id = @campaign'); params.campaign = campaign; }
  if (query) {
    conditions.push('(first_name LIKE @q OR last_name LIKE @q OR company LIKE @q OR email LIKE @q)');
    params.q = `%${query}%`;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM leads ${where} ORDER BY score DESC, created_at DESC LIMIT 200`).all(params);
}

export function getStats() {
  const db = getDb();
  return db.prepare(`
    SELECT
      status,
      COUNT(*) as count
    FROM leads
    GROUP BY status
    ORDER BY count DESC
  `).all();
}
