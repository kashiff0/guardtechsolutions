import { v4 as uuidv4 } from 'uuid';
import { getDb } from './schema.js';

export function recordTouch({ leadId, channel, type, step, body, subject, messageId, status = 'sent', error }) {
  const db = getDb();
  const id = uuidv4();

  db.prepare(`
    INSERT INTO touches (id, lead_id, channel, type, sequence_step, body, subject, message_id, status, sent_at, error)
    VALUES (@id, @lead_id, @channel, @type, @step, @body, @subject, @message_id, @status, @sent_at, @error)
  `).run({
    id,
    lead_id: leadId,
    channel,
    type,
    step: step || null,
    body: body || null,
    subject: subject || null,
    message_id: messageId || null,
    status,
    sent_at: new Date().toISOString(),
    error: error || null
  });

  db.prepare(`UPDATE leads SET last_contacted_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`).run(leadId);

  return id;
}

export function markTouchReplied(leadId, channel) {
  const db = getDb();
  db.prepare(`
    UPDATE touches SET replied_at = datetime('now'), status = 'replied'
    WHERE lead_id = ? AND channel = ? AND replied_at IS NULL
    ORDER BY sent_at DESC LIMIT 1
  `).run(leadId, channel);
}

export function markTouchOpened(messageId) {
  getDb().prepare(`
    UPDATE touches SET opened_at = datetime('now'), status = 'opened'
    WHERE message_id = ?
  `).run(messageId);
}

export function getTouchHistory(leadId) {
  return getDb().prepare(`
    SELECT * FROM touches WHERE lead_id = ? ORDER BY sent_at ASC
  `).all(leadId);
}

export function getLastTouch(leadId, channel) {
  return getDb().prepare(`
    SELECT * FROM touches WHERE lead_id = ? AND channel = ?
    ORDER BY sent_at DESC LIMIT 1
  `).get(leadId, channel);
}

export function countTouches(leadId, channel) {
  const row = getDb().prepare(`
    SELECT COUNT(*) as n FROM touches WHERE lead_id = ? AND channel = ? AND status != 'error'
  `).get(leadId, channel);
  return row?.n || 0;
}
