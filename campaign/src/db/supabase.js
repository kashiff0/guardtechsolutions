/**
 * Supabase service-role client (campaign agents).
 * Self-contained: loads .env and validates ONLY the Supabase vars, so utility
 * scripts (migrate, create-user) can run without the full Gmail/Anthropic creds.
 * The service_role key bypasses Row-Level Security — keep it server-side only.
 */
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');
if (existsSync(envPath)) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: envPath });
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key || url.includes('YOUR_') || key.includes('YOUR_')) {
  throw new Error(
    '\n⛔  Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in campaign/.env\n' +
    '    → Supabase dashboard → Project Settings → API\n'
  );
}

export const supabase = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false }
});
