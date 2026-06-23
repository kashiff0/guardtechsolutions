/**
 * Lead Import Script
 * Import leads from CSV into the campaign database.
 *
 * Usage:
 *   node scripts/importLeads.js path/to/leads.csv --vertical restaurant --campaign cold_outreach
 *
 * CSV format (headers required):
 *   first_name, last_name, email, phone, company, title, linkedin_url, location, notes, score
 *
 * Only first_name and vertical are required; all others are optional.
 */

import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createLead } from '../src/db/leads.js';
import { logger } from '../src/utils/logger.js';

const VALID_VERTICALS = ['restaurant', 'church', 'school', 'property_manager', 'healthcare'];
const VALID_CAMPAIGNS = ['cold_outreach', 'partnership', 'sales_demo'];

async function importCsv(filePath, { vertical, campaign = 'cold_outreach' } = {}) {
  if (!VALID_VERTICALS.includes(vertical)) {
    throw new Error(`Invalid vertical: ${vertical}. Valid: ${VALID_VERTICALS.join(', ')}`);
  }

  const rl = createInterface({ input: createReadStream(filePath) });
  let headers = null;
  let imported = 0, skipped = 0, errors = 0;

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const values = trimmed.split(',').map(v => v.trim().replace(/^"|"$/g, ''));

    if (!headers) {
      headers = values.map(h => h.toLowerCase().replace(/\s+/g, '_'));
      continue;
    }

    const row = Object.fromEntries(headers.map((h, i) => [h, values[i] || null]));

    if (!row.first_name) {
      skipped++;
      continue;
    }

    try {
      await createLead({
        first_name: row.first_name,
        last_name: row.last_name || null,
        email: row.email || null,
        phone: row.phone || null,
        company: row.company || null,
        title: row.title || null,
        linkedin_url: row.linkedin_url || null,
        location: row.location || null,
        notes: row.notes || null,
        score: row.score ? parseInt(row.score) : 50,
        vertical,
        campaign_id: campaign,
        source: 'csv_import'
      });
      imported++;
    } catch (err) {
      logger.error(`Failed to import row: ${JSON.stringify(row)} — ${err.message}`);
      errors++;
    }
  }

  logger.info(`Import complete — imported: ${imported}, skipped: ${skipped}, errors: ${errors}`);
  return { imported, skipped, errors };
}

const args = process.argv.slice(2);
const filePath = args[0];
const vertical = args.find(a => a.startsWith('--vertical='))?.split('=')?.[1]
  || args[args.indexOf('--vertical') + 1];
const campaign = args.find(a => a.startsWith('--campaign='))?.split('=')?.[1]
  || args[args.indexOf('--campaign') + 1]
  || 'cold_outreach';

if (!filePath || !vertical) {
  console.error('\nUsage: node scripts/importLeads.js <file.csv> --vertical <id> [--campaign <id>]');
  console.error(`Verticals: ${VALID_VERTICALS.join(', ')}`);
  console.error(`Campaigns: ${VALID_CAMPAIGNS.join(', ')}\n`);
  process.exit(1);
}

importCsv(filePath, { vertical, campaign })
  .then(r => { console.log(r); process.exit(0); })
  .catch(err => { console.error(err.message); process.exit(1); });
