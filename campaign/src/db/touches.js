/**
 * Outreach touch history — Supabase (service role). All async.
 */
import { supabase } from './supabase.js';

export async function recordTouch({ leadId, channel, type, step, body, subject, messageId, status = 'sent', error }) {
  const { data, error: insErr } = await supabase.from('touches').insert({
    lead_id: leadId,
    channel,
    type,
    sequence_step: step || null,
    body: body || null,
    subject: subject || null,
    message_id: messageId || null,
    status,
    error: error || null
  }).select('id').single();
  if (insErr) throw new Error(`recordTouch: ${insErr.message}`);

  // bump last_contacted_at (updated_at maintained by the leads trigger)
  await supabase.from('leads').update({ last_contacted_at: new Date().toISOString() }).eq('id', leadId);
  return data.id;
}

export async function markTouchReplied(leadId, channel) {
  // Supabase has no ORDER BY on UPDATE — select the newest un-replied touch, then update it.
  const { data } = await supabase.from('touches').select('id')
    .eq('lead_id', leadId).eq('channel', channel).is('replied_at', null)
    .order('sent_at', { ascending: false }).limit(1);
  if (!data?.length) return;
  await supabase.from('touches')
    .update({ replied_at: new Date().toISOString(), status: 'replied' })
    .eq('id', data[0].id);
}

export async function markTouchOpened(messageId) {
  await supabase.from('touches')
    .update({ opened_at: new Date().toISOString(), status: 'opened' })
    .eq('message_id', messageId);
}

export async function getTouchHistory(leadId) {
  const { data, error } = await supabase.from('touches').select('*')
    .eq('lead_id', leadId).order('sent_at', { ascending: true });
  if (error) throw new Error(`getTouchHistory: ${error.message}`);
  return data || [];
}

export async function getLastTouch(leadId, channel) {
  const { data, error } = await supabase.from('touches').select('*')
    .eq('lead_id', leadId).eq('channel', channel)
    .order('sent_at', { ascending: false }).limit(1);
  if (error) throw new Error(`getLastTouch: ${error.message}`);
  return data?.[0] || null;
}

export async function countTouches(leadId, channel) {
  const { count, error } = await supabase.from('touches')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId).eq('channel', channel).neq('status', 'error');
  if (error) throw new Error(`countTouches: ${error.message}`);
  return count || 0;
}

/** True if an email/linkedin reply touch already exists for this lead. */
export async function hasReplied(leadId, channel) {
  const { count, error } = await supabase.from('touches')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId).eq('channel', channel).eq('status', 'replied');
  if (error) throw new Error(`hasReplied: ${error.message}`);
  return (count || 0) > 0;
}
