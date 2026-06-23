/**
 * DB entry point. Schema now lives in Supabase (see supabase/migration.sql) —
 * this module just re-exports the client and a connectivity check.
 * `getDb()` (the old better-sqlite3 handle) is gone; all access goes through
 * the async helpers in leads.js / touches.js / runs.js.
 */
import { supabase } from './supabase.js';
export { supabase } from './supabase.js';

export async function checkConnection() {
  const { error } = await supabase.from('leads').select('id').limit(1);
  if (error) throw new Error(`Supabase connection failed: ${error.message}`);
  return true;
}
