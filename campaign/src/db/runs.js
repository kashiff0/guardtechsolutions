/**
 * campaign_runs helpers — Supabase (service role).
 * Replaces the raw INSERT/UPDATE the orchestrator used to do via getDb().
 */
import { supabase } from './supabase.js';

export async function createRun() {
  const { data, error } = await supabase.from('campaign_runs').insert({}).select('id').single();
  if (error) throw new Error(`createRun: ${error.message}`);
  return data.id;
}

export async function finishRun(id, { leadsProcessed = 0, emailsSent = 0, linkedinSent = 0, errors = 0 } = {}) {
  const { error } = await supabase.from('campaign_runs').update({
    completed_at: new Date().toISOString(),
    leads_processed: leadsProcessed,
    emails_sent: emailsSent,
    linkedin_sent: linkedinSent,
    errors
  }).eq('id', id);
  if (error) throw new Error(`finishRun: ${error.message}`);
}
