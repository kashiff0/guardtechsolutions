/**
 * LinkedIn Queue Agent
 * Manages the LinkedIn outreach queue. The Chrome extension consumes this queue
 * by calling getNextProfile(), and reports back status via markLinkedIn*().
 *
 * The extension calls into this module via a local HTTP server (see below).
 * In Phase 2 this server will be exposed to the extension via a local API.
 */

import http from 'http';
import { fileURLToPath } from 'url';
import {
  getNextLinkedInProfile,
  getLeadsForLinkedIn,
  updateLeadStatus,
  getLead,
  createLead,
  findDuplicate,
  LEAD_STATUS
} from '../db/leads.js';
import { recordTouch } from '../db/touches.js';
import { generateLinkedInMessage } from '../skills/claude.js';
import { linkedinLimiter } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

export async function getNextProfile() {
  const lead = await getNextLinkedInProfile();
  if (!lead) {
    logger.info('LinkedIn queue empty');
    return null;
  }
  return lead;
}

export async function generateConnectionRequest(leadId) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const text = await generateLinkedInMessage({ lead, messageType: 'connection' });
  return { text, charCount: text.length, limit: 300, overLimit: text.length > 300 };
}

export async function generateDirectMessage(leadId) {
  const lead = await getLead(leadId);
  if (!lead) throw new Error(`Lead ${leadId} not found`);

  const text = await generateLinkedInMessage({ lead, messageType: 'message' });
  return { text, charCount: text.length, limit: 1000, overLimit: text.length > 1000 };
}

export async function markConnectionSent(leadId, messageText) {
  await updateLeadStatus(leadId, LEAD_STATUS.LINKEDIN_SENT);
  await recordTouch({
    leadId,
    channel: 'linkedin',
    type: 'connection_request',
    step: 1,
    body: messageText,
    status: 'sent'
  });
  logger.info(`LinkedIn connection request marked sent for lead ${leadId}`);
}

export async function markConnectionAccepted(leadId) {
  await updateLeadStatus(leadId, LEAD_STATUS.LINKEDIN_ACCEPTED);
  logger.info(`LinkedIn connection accepted for lead ${leadId}`);
}

export async function markDirectMessageSent(leadId, messageText) {
  await updateLeadStatus(leadId, LEAD_STATUS.LINKEDIN_MESSAGED);
  await recordTouch({
    leadId,
    channel: 'linkedin',
    type: 'direct_message',
    step: 2,
    body: messageText,
    status: 'sent'
  });
  logger.info(`LinkedIn direct message marked sent for lead ${leadId}`);
}

export async function markLinkedInReplied(leadId) {
  await updateLeadStatus(leadId, LEAD_STATUS.REPLIED);
  await recordTouch({
    leadId,
    channel: 'linkedin',
    type: 'reply_received',
    status: 'replied'
  });
  logger.info(`LinkedIn reply recorded for lead ${leadId}`);
}

// Local API server — Chrome extension calls this to get profile queue
// and report back status without needing the extension to access the DB directly
export function startQueueServer(port = 7432) {
  const routes = {
    'GET /next': async () => {
      const lead = await getNextProfile();
      return lead || { empty: true };
    },
    'GET /queue': async () => {
      return await getLeadsForLinkedIn(20);
    },
    'POST /connection-sent': async (body) => {
      await markConnectionSent(body.leadId, body.message);
      return { ok: true };
    },
    'POST /connection-accepted': async (body) => {
      await markConnectionAccepted(body.leadId);
      return { ok: true };
    },
    'POST /message-sent': async (body) => {
      await markDirectMessageSent(body.leadId, body.message);
      return { ok: true };
    },
    'POST /replied': async (body) => {
      await markLinkedInReplied(body.leadId);
      return { ok: true };
    },
    'POST /generate/connection': async (body) => {
      return await generateConnectionRequest(body.leadId);
    },
    'POST /generate/message': async (body) => {
      return await generateDirectMessage(body.leadId);
    },

    'POST /bulk-import': async (body) => {
      const { leads = [], vertical, campaign_id = 'cold_outreach' } = body;

      let imported = 0, duplicates = 0;
      for (const lead of leads) {
        if (!lead.first_name) continue;
        if (await findDuplicate(lead)) { duplicates++; continue; }
        try {
          await createLead({ ...lead, vertical: vertical || 'property_manager', campaign_id, source: 'linkedin_search' });
          imported++;
        } catch {}
      }
      logger.info(`Bulk import: ${imported} imported, ${duplicates} duplicates`);
      return { imported, duplicates };
    }
  };

  const server = http.createServer(async (req, res) => {
    // CORS — extension needs to call localhost
    res.setHeader('Access-Control-Allow-Origin', 'chrome-extension://*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-GTS-Token');
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const token = req.headers['x-gts-token'];
    if (token !== process.env.GTS_LOCAL_TOKEN && process.env.GTS_LOCAL_TOKEN) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const routeKey = `${req.method} ${req.url.split('?')[0]}`;
    const handler = routes[routeKey];

    if (!handler) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found' }));
      return;
    }

    let body = {};
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch {}
    }

    try {
      const result = await handler(body);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    } catch (err) {
      logger.error(`Queue server error: ${err.message}`);
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    logger.info(`LinkedIn queue server running on http://127.0.0.1:${port}`);
  });

  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  startQueueServer();
}
