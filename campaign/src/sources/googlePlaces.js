/**
 * Google Places Discovery Source
 * Finds local businesses by vertical + location using the Google Places API.
 * Returns normalized lead objects ready for DB import.
 */

import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';

const PLACES_BASE = 'https://maps.googleapis.com/maps/api/place';

// Maps GTS verticals to Google Places search queries and type filters
const VERTICAL_CONFIG = {
  restaurant: {
    queries: ['restaurants', 'food service', 'cafes diners'],
    type: 'restaurant',
    decisionTitles: ['Owner', 'General Manager', 'GM', 'Operator']
  },
  church: {
    queries: ['churches', 'religious organizations', 'houses of worship'],
    type: 'church',
    decisionTitles: ['Pastor', 'Senior Pastor', 'Executive Pastor', 'Administrator']
  },
  school: {
    queries: ['K-12 schools', 'private schools', 'elementary middle high school'],
    type: 'school',
    decisionTitles: ['Principal', 'Superintendent', 'IT Director', 'Technology Coordinator']
  },
  property_manager: {
    queries: ['property management companies', 'real estate management'],
    type: 'real_estate_agency',
    decisionTitles: ['Property Manager', 'Regional Manager', 'Director of Operations']
  },
  healthcare: {
    queries: ['medical practices', 'dental offices', 'doctor offices', 'clinics'],
    type: 'doctor',
    decisionTitles: ['Practice Manager', 'Office Manager', 'Administrator', 'CIO']
  }
};

async function placesRequest(path, params) {
  const apiKey = credentials.discovery.googlePlacesApiKey;
  if (!apiKey) throw new Error('GOOGLE_PLACES_API_KEY not set');

  const url = new URL(`${PLACES_BASE}/${path}/json`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set('key', apiKey);

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Places API error: ${res.status}`);
  const data = await res.json();

  if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    throw new Error(`Places API: ${data.status} — ${data.error_message || ''}`);
  }

  return data;
}

async function getPlaceDetails(placeId) {
  const data = await placesRequest('details', {
    place_id: placeId,
    fields: 'name,formatted_phone_number,website,rating,user_ratings_total,formatted_address,business_status'
  });
  return data.result;
}

function extractDomain(website) {
  if (!website) return null;
  try {
    const url = new URL(website);
    return url.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function scoreLead(place, vertical) {
  let score = 40;
  if (place.rating >= 4.0) score += 10;
  if (place.user_ratings_total >= 50) score += 10;
  if (place.user_ratings_total >= 200) score += 10;
  if (place.website) score += 15;
  if (place.formatted_phone_number) score += 5;
  if (place.business_status === 'OPERATIONAL') score += 10;
  return Math.min(score, 95);
}

function normalizeLead(place, vertical, source) {
  const config = VERTICAL_CONFIG[vertical];
  const domain = extractDomain(place.website);
  const nameParts = place.name.split(' ');

  return {
    first_name: place.name,
    last_name: null,
    company: place.name,
    title: null,
    email: null,
    phone: place.formatted_phone_number || null,
    location: place.formatted_address || null,
    linkedin_url: null,
    vertical,
    source,
    score: scoreLead(place, vertical),
    notes: [
      domain ? `Domain: ${domain}` : null,
      place.website ? `Website: ${place.website}` : null,
      place.rating ? `Google rating: ${place.rating} (${place.user_ratings_total} reviews)` : null,
      place.place_id ? `PlaceID: ${place.place_id}` : null
    ].filter(Boolean).join(' | ')
  };
}

async function fetchPage(query, location, pageToken) {
  const params = {
    query: `${query} in ${location}`,
    language: 'en'
  };
  if (pageToken) params.pagetoken = pageToken;

  return placesRequest('textsearch', params);
}

export async function discoverViaGooglePlaces({ vertical, location, limit = 60 }) {
  const config = VERTICAL_CONFIG[vertical];
  if (!config) throw new Error(`Unknown vertical: ${vertical}`);

  logger.info(`Google Places discovery: ${vertical} in "${location}" (limit ${limit})`);

  const leads = [];
  const seen = new Set();

  for (const query of config.queries) {
    if (leads.length >= limit) break;

    let pageToken = null;
    let page = 0;

    do {
      if (page > 0) await new Promise(r => setTimeout(r, 2000)); // Places API pagination delay

      let data;
      try {
        data = await fetchPage(query, location, pageToken);
      } catch (err) {
        logger.warn(`Places search failed for "${query}": ${err.message}`);
        break;
      }

      for (const result of (data.results || [])) {
        if (leads.length >= limit) break;
        if (seen.has(result.place_id)) continue;
        seen.add(result.place_id);

        try {
          const details = await getPlaceDetails(result.place_id);
          if (details.business_status === 'CLOSED_PERMANENTLY') continue;
          const lead = normalizeLead({ ...result, ...details }, vertical, 'google_places');
          leads.push(lead);
          await new Promise(r => setTimeout(r, 300));
        } catch (err) {
          logger.warn(`Skipping place ${result.place_id}: ${err.message}`);
        }
      }

      pageToken = data.next_page_token || null;
      page++;
    } while (pageToken && leads.length < limit);
  }

  logger.info(`Google Places found ${leads.length} leads for ${vertical} in ${location}`);
  return leads;
}
