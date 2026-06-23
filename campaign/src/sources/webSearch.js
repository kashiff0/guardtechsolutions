/**
 * Web Search Discovery Source
 * Uses SerpAPI to find decision-maker LinkedIn profiles and company contacts.
 * Fallback source when Google Places doesn't cover a lead type well
 * (e.g. searching for "Property Manager Chicago LinkedIn").
 */

import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';

const SERP_BASE = 'https://serpapi.com/search';

const VERTICAL_QUERIES = {
  restaurant: [
    'site:linkedin.com/in "restaurant owner" "{location}"',
    'site:linkedin.com/in "general manager" "restaurant" "{location}"'
  ],
  church: [
    'site:linkedin.com/in "senior pastor" "{location}"',
    'site:linkedin.com/in "church administrator" "{location}"',
    'site:linkedin.com/in "executive pastor" "{location}"'
  ],
  school: [
    'site:linkedin.com/in "school principal" "{location}"',
    'site:linkedin.com/in "IT director" "school district" "{location}"',
    'site:linkedin.com/in "superintendent" "school" "{location}"'
  ],
  property_manager: [
    'site:linkedin.com/in "property manager" "{location}"',
    'site:linkedin.com/in "regional manager" "property management" "{location}"'
  ],
  healthcare: [
    'site:linkedin.com/in "practice manager" "medical" "{location}"',
    'site:linkedin.com/in "office manager" "clinic" "{location}"'
  ]
};

function parseLinkedInResult(result) {
  const url = result.link || '';
  if (!url.includes('linkedin.com/in/')) return null;

  const title = result.title || '';
  const snippet = result.snippet || '';

  // LinkedIn result title is typically "Name - Title at Company | LinkedIn"
  const titleMatch = title.match(/^(.+?)\s*[-–]\s*(.+?)\s*(?:\||\bat\b)/i);
  const nameStr = titleMatch?.[1]?.trim() || '';
  const nameParts = nameStr.split(' ');

  const companyMatch = snippet.match(/(?:at|@)\s+([^·\n]+)/i) || title.match(/at\s+([^|]+)/i);

  return {
    first_name: nameParts[0] || nameStr,
    last_name: nameParts.slice(1).join(' ') || null,
    title: titleMatch?.[2]?.trim() || null,
    company: companyMatch?.[1]?.trim() || null,
    linkedin_url: url.split('?')[0],
    linkedin_name: nameStr,
    about: snippet,
    email: null,
    phone: null,
    source: 'web_search'
  };
}

export async function discoverViaWebSearch({ vertical, location, limit = 30 }) {
  const apiKey = credentials.discovery.serpApiKey;
  if (!apiKey) {
    logger.warn('SERP_API_KEY not set — skipping web search discovery');
    return [];
  }

  const queries = (VERTICAL_QUERIES[vertical] || [])
    .map(q => q.replace('{location}', location));

  const leads = [];
  const seenUrls = new Set();

  for (const query of queries) {
    if (leads.length >= limit) break;

    try {
      const url = new URL(SERP_BASE);
      url.searchParams.set('engine', 'google');
      url.searchParams.set('q', query);
      url.searchParams.set('num', '10');
      url.searchParams.set('api_key', apiKey);

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error(`SerpAPI error: ${res.status}`);

      const data = await res.json();
      const results = data.organic_results || [];

      for (const result of results) {
        if (leads.length >= limit) break;

        const lead = parseLinkedInResult(result);
        if (!lead) continue;
        if (seenUrls.has(lead.linkedin_url)) continue;
        seenUrls.add(lead.linkedin_url);

        leads.push({ ...lead, vertical, score: 55 });
      }

      await new Promise(r => setTimeout(r, 1500));
    } catch (err) {
      logger.warn(`Web search failed for "${query}": ${err.message}`);
    }
  }

  logger.info(`Web search found ${leads.length} LinkedIn profiles for ${vertical} in ${location}`);
  return leads;
}
