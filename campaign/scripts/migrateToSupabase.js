/**
 * One-time migration: load the real published leads (portal format) into the
 * shared Supabase `leads` table. "Start clean with real data" — only these real
 * prospects are imported; demo staff/sample leads are not.
 *
 * Usage:
 *   npm run migrate -- --file ../path/to/published-leads.json
 *   (defaults to ./published-leads.json in the current directory)
 *
 * Idempotent: skips a lead that already exists (matched by email / linkedin /
 * name+company), so it's safe to re-run.
 */
import { readFileSync } from 'fs';
import { supabase } from '../src/db/supabase.js';
import { findDuplicate, addNote } from '../src/db/leads.js';

const args = process.argv.slice(2);
const fileArg = args.find(a => a === '--file') ? args[args.indexOf('--file') + 1]
  : args.find(a => a.startsWith('--file='))?.split('=').slice(1).join('=');
const file = fileArg || 'published-leads.json';

// portal pipeline stage -> canonical campaign status (trigger re-derives stage)
const STAGE_TO_STATUS = {
  'New': 'discovered',
  'Contacted': 'email_queued',
  'Demo Sent': 'email_sequence',
  'Proposal': 'qualified',
  'Won': 'closed_won',
  'Lost': 'closed_lost'
};

function splitName(contact = '') {
  const parts = contact.trim().split(/\s+/);
  return { first_name: parts[0] || '', last_name: parts.slice(1).join(' ') || null };
}

let leads;
try {
  leads = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}\nPass --file <path to published-leads.json>.`);
  process.exit(1);
}
if (!Array.isArray(leads)) { console.error('Expected a JSON array of leads.'); process.exit(1); }

let imported = 0, skipped = 0, errors = 0;

for (const l of leads) {
  const { first_name, last_name } = l.first_name ? l : splitName(l.contact);
  const noteText = Array.isArray(l.notes) ? l.notes.map(n => n.t || n).filter(Boolean).join(' | ')
    : (l.notes || l.note || '');
  const scoreMatch = /score\s+(\d{1,3})/i.exec(noteText);

  const row = {
    first_name: l.first_name || first_name,
    last_name: l.last_name ?? last_name,
    email: l.email || null,
    phone: l.phone || null,
    company: l.company || null,
    title: l.title || null,
    vertical: l.vertical || 'property_manager',
    linkedin_url: l.linkedin || l.linkedin_url || null,
    location: l.city || l.location || null,
    specialty: l.specialty || null,
    value: l.value || 0,
    score: scoreMatch ? Math.min(100, parseInt(scoreMatch[1])) : 50,
    status: STAGE_TO_STATUS[l.stage] || 'discovered',
    source: 'portal_import'
  };

  try {
    if (await findDuplicate(row)) { skipped++; continue; }
    const { data, error } = await supabase.from('leads').insert(row).select('id').single();
    if (error) throw new Error(error.message);
    if (noteText) await addNote(data.id, noteText, 'import');
    imported++;
    console.log(`  ✓ ${row.company} — ${row.first_name} ${row.last_name || ''}`.trim());
  } catch (err) {
    console.error(`  ✗ ${l.company}: ${err.message}`);
    errors++;
  }
}

console.log(`\nMigration complete — imported: ${imported}, skipped (dupes): ${skipped}, errors: ${errors}`);
process.exit(errors ? 1 : 0);
