/**
 * Lead Enrichment Agent
 * Takes raw leads (status=discovered) and enriches them with:
 *  1. Claude-based analysis of existing data (always available)
 *  2. Hunter.io email finder (if HUNTER_API_KEY set)
 *  3. Clearbit company lookup (if CLEARBIT_API_KEY set)
 *
 * Updates lead record with enriched data and marks enriched=1.
 */

import { fileURLToPath } from 'url';
import { getLeadsForEnrichment, updateLeadStatus, getLead, LEAD_STATUS } from '../db/leads.js';
import { enrichLeadWithClaude } from '../skills/claude.js';
import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';
import { getDb } from '../db/schema.js';

async function findEmailViaHunter(firstName, lastName, domain) {
  if (!credentials.enrichment.hunterApiKey || !domain) return null;

  try {
    const url = new URL('https://api.hunter.io/v2/email-finder');
    url.searchParams.set('domain', domain);
    url.searchParams.set('first_name', firstName);
    if (lastName) url.searchParams.set('last_name', lastName);
    url.searchParams.set('api_key', credentials.enrichment.hunterApiKey);

    const res = await fetch(url.toString());
    if (!res.ok) return null;

    const data = await res.json();
    if (data.data?.email && data.data.confidence > 50) {
      logger.info(`Hunter found email for ${firstName} ${lastName}: confidence ${data.data.confidence}%`);
      return data.data.email;
    }
  } catch (err) {
    logger.warn(`Hunter lookup failed: ${err.message}`);
  }
  return null;
}

async function enrichViaHunter(lead) {
  if (!credentials.enrichment.hunterApiKey) return {};
  if (!lead.company) return {};

  // Extract domain from company name (basic heuristic)
  const domain = lead.company
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .substring(0, 30);

  const email = await findEmailViaHunter(lead.first_name, lead.last_name, `${domain}.com`);
  return email ? { email } : {};
}

async function enrichViaClearbit(lead) {
  if (!credentials.enrichment.clearbitApiKey || !lead.email) return {};

  try {
    const res = await fetch(`https://person.clearbit.com/v2/combined/find?email=${encodeURIComponent(lead.email)}`, {
      headers: { Authorization: `Bearer ${credentials.enrichment.clearbitApiKey}` }
    });
    if (!res.ok) return {};

    const data = await res.json();
    return {
      title: data.person?.title || null,
      company: data.company?.name || null,
      location: data.person?.location || null,
      about: data.person?.bio || null
    };
  } catch (err) {
    logger.warn(`Clearbit lookup failed: ${err.message}`);
    return {};
  }
}

async function enrichLead(lead) {
  logger.info(`Enriching lead: ${lead.first_name} ${lead.last_name || ''} at ${lead.company || 'unknown'}`);

  const rawData = {
    linkedin_name: lead.linkedin_name,
    linkedin_url: lead.linkedin_url,
    title: lead.title,
    company: lead.company,
    about: lead.about,
    location: lead.location
  };

  const [claudeEnrichment, hunterEnrichment, clearbitEnrichment] = await Promise.allSettled([
    enrichLeadWithClaude(lead, rawData),
    enrichViaHunter(lead),
    enrichViaClearbit(lead)
  ]);

  const merged = {
    ...(claudeEnrichment.status === 'fulfilled' ? claudeEnrichment.value : {}),
    ...(hunterEnrichment.status === 'fulfilled' ? hunterEnrichment.value : {}),
    ...(clearbitEnrichment.status === 'fulfilled' ? clearbitEnrichment.value : {})
  };

  // Existing data wins over enriched data (don't overwrite confirmed info)
  const updates = {};
  for (const [key, val] of Object.entries(merged)) {
    if (val && !lead[key]) updates[key] = val;
    if (key === 'score' && val) updates[key] = val;
  }

  if (Object.keys(updates).length > 0) {
    const db = getDb();
    const fields = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE leads SET ${fields}, enriched = 1, updated_at = datetime('now') WHERE id = @id`)
      .run({ ...updates, id: lead.id });
    logger.info(`Updated ${Object.keys(updates).join(', ')} for lead ${lead.id}`);
  } else {
    getDb().prepare(`UPDATE leads SET enriched = 1, updated_at = datetime('now') WHERE id = ?`).run(lead.id);
  }

  updateLeadStatus(lead.id, LEAD_STATUS.ENRICHED);
  return { id: lead.id, updates };
}

export async function runEnrichmentAgent(limit = 20) {
  logger.info('=== Enrichment Agent Starting ===');
  const leads = getLeadsForEnrichment(limit);
  logger.info(`Found ${leads.length} leads to enrich`);

  let enriched = 0, errors = 0;

  for (const lead of leads) {
    try {
      await enrichLead(lead);
      enriched++;
      await new Promise(r => setTimeout(r, 1000));
    } catch (err) {
      logger.error(`Enrichment failed for lead ${lead.id}: ${err.message}`);
      errors++;
    }
  }

  logger.info(`=== Enrichment Done — enriched: ${enriched}, errors: ${errors} ===`);
  return { enriched, errors };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEnrichmentAgent().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
