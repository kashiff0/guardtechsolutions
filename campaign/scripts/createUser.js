/**
 * Create a portal user (auth account + profile) with a role.
 * The DB trigger handle_new_user() turns the auth user's metadata into a
 * public.profiles row, so role/name/title are passed as user_metadata here.
 *
 * Usage:
 *   npm run create-user -- --email you@co.com --password 'Secret123' --name "Geovonni O." --role admin --title "Owner / Admin"
 *   npm run create-user -- --email guard@co.com --password 'Secret123' --name "Marcus Bell" --role employee --title "Lead Security Officer"
 *
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in campaign/.env.
 */
import { supabase } from '../src/db/supabase.js';

const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.findIndex(a => a === flag);
  if (i >= 0) return args[i + 1];
  return args.find(a => a.startsWith(flag + '='))?.split('=').slice(1).join('=');
};

const email = get('--email');
const password = get('--password');
const full_name = get('--name') || '';
const title = get('--title') || '';
const role = (get('--role') || 'employee').toLowerCase();

if (!email || !password) {
  console.error('\nUsage: npm run create-user -- --email <email> --password <pw> --name "<full name>" --role admin|employee [--title "<title>"]\n');
  process.exit(1);
}
if (!['admin', 'employee'].includes(role)) {
  console.error(`Invalid role "${role}" — must be admin or employee.`);
  process.exit(1);
}

const { data, error } = await supabase.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name, title, role }
});

if (error) {
  console.error(`Failed to create user: ${error.message}`);
  process.exit(1);
}

// Belt-and-suspenders: ensure the profile row reflects the role even if the
// signup trigger isn't installed for some reason.
await supabase.from('profiles').upsert({
  id: data.user.id, full_name, title, role
}, { onConflict: 'id' });

console.log(`✓ Created ${role} user ${email} (${data.user.id}) — ${full_name}`);
process.exit(0);
