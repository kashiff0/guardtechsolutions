/**
 * Lead Discovery Agent
 * Finds new leads from multiple sources, deduplicates, scores, and imports
 * them into the SQLite database ready for the enrichment + outreach pipeline.
 *
 * Sources (in priority order):
 *  1. Google Places API   — local businesses by type + location (best for restaurants, churches, etc.)
 *  2. Web Search (SerpAPI) — LinkedIn profile search by role + location
 *  3. LinkedIn extension   — manual via Chrome extension "Add to Queue" (handled in content.js)
 *
 * Usage (CLI):
 *  node src/agents/discovery.js --vertical restaurant --location "Chicago, IL"
 *  node src/agents/discovery.js --vertical church --location "Atlanta, GA" --limit 50
 */

import { fileURLToPath } from 'url';
import { createLead, findDuplicate } from '../db/leads.js';
import { discoverViaGooglePlaces } from '../sources/googlePlaces.js';
import { discoverViaWebSearch } from '../sources/webSearch.js';
import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';

const VALID_VERTICALS = ['restaurant', 'church', 'school', 'property_manager', 'healthcare'];

async function runDiscoveryAgent({ vertical, location, limit, campaign = 'cold_outreach', source }) {
  if (!VALID_VERTICALS.includes(vertical)) {
    throw new Error(`Invalid vertical: ${vertical}. Valid: ${VALID_VERTICALS.join(', ')}`);
  }
  if (!location) throw new Error('--location is required (e.g. "Chicago, IL")');

  const maxLeads = limit || credentials.limits.discoveryPerRun;

  logger.info(`\n${'='.repeat(50)}`);
  logger.info(`Discovery Agent — ${vertical} in "${location}" (limit: ${maxLeads})`);
  logger.info(`${'='.repeat(50)}`);

  let candidates = [];

  // Source 1: Google Places (local business discovery)
  if ((!source || source === 'places') && credentials.discovery.googlePlacesApiKey) {
    try {
      const placesLeads = await discoverViaGooglePlaces({ vertical, location, limit: Math.ceil(maxLeads * 0.7) });
      candidates.push(...placesLeads);
      logger.info(`Places: ${placesLeads.length} candidates`);
    } catch (err) {
      logger.warn(`Google Places failed: ${err.message}`);
    }
  }

  // Source 2: Web search / LinkedIn profiles (decision-maker discovery)
  if ((!source || source === 'search') && credentials.discovery.serpApiKey) {
    try {
      const searchLeads = await discoverViaWebSearch({ vertical, location, limit: Math.ceil(maxLeads * 0.5) });
      candidates.push(...searchLeads);
      logger.info(`Web search: ${searchLeads.length} candidates`);
    } catch (err) {
      logger.warn(`Web search failed: ${err.message}`);
    }
  }

  if (candidates.length === 0) {
    logger.warn('No candidates found. Check that at least one of GOOGLE_PLACES_API_KEY or SERP_API_KEY is set.');
    return { discovered: 0, imported: 0, duplicates: 0 };
  }

  // Deduplicate candidates against each other first
  const uniqueCandidates = [];
  const seenKeys = new Set();
  for (const lead of candidates) {
    const key = lead.linkedin_url || lead.email || `${lead.first_name}|${lead.company}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    uniqueCandidates.push(lead);
  }

  // Sort by score descending, take top N
  uniqueCandidates.sort((a, b) => (b.score || 0) - (a.score || 0));
  const toImport = uniqueCandidates.slice(0, maxLeads);

  logger.info(`${candidates.length} total candidates → ${uniqueCandidates.length} unique → importing top ${toImport.length}`);

  let imported = 0;
  let duplicates = 0;

  for (const lead of toImport) {
    if (await findDuplicate(lead)) {
      duplicates++;
      continue;
    }
    try {
      await createLead({ ...lead, campaign_id: campaign });
      imported++;
    } catch (err) {
      logger.error(`Import failed for ${lead.first_name}: ${err.message}`);
    }
  }

  logger.info(`\n✓ Discovery complete:`);
  logger.info(`  Found:      ${candidates.length}`);
  logger.info(`  Unique:     ${uniqueCandidates.length}`);
  logger.info(`  Imported:   ${imported}`);
  logger.info(`  Duplicates: ${duplicates}`);

  return { discovered: candidates.length, imported, duplicates };
}

export { runDiscoveryAgent };

// CLI
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const idx = args.findIndex(a => a === flag);
    return idx >= 0 ? args[idx + 1] : args.find(a => a.startsWith(flag + '='))?.split('=').slice(1).join('=');
  };

  const vertical = get('--vertical');
  const location = get('--location');
  const limit = get('--limit') ? parseInt(get('--limit')) : undefined;
  const campaign = get('--campaign') || 'cold_outreach';
  const source = get('--source');

  if (!vertical || !location) {
    console.error('\nUsage: node src/agents/discovery.js --vertical <id> --location "<city, state>" [--limit N] [--campaign <id>] [--source places|search]\n');
    console.error('Verticals: restaurant, church, school, property_manager, healthcare\n');
    process.exit(1);
  }

  runDiscoveryAgent({ vertical, location, limit, campaign, source })
    .then(() => process.exit(0))
    .catch(err => { logger.error(err.message); process.exit(1); });
}
