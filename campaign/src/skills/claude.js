import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const client = new Anthropic({ apiKey: credentials.anthropicApiKey });
const MODEL = 'claude-opus-4-8';

let _verticals, _campaigns;

function loadConfig() {
  if (!_verticals) {
    _verticals = yaml.load(readFileSync(join(__dirname, '../../config/verticals.yaml'), 'utf8')).verticals;
    _campaigns = yaml.load(readFileSync(join(__dirname, '../../config/campaigns.yaml'), 'utf8')).campaigns;
  }
}

function getVertical(id) {
  loadConfig();
  return _verticals[id] || _verticals.restaurant;
}

function getCampaign(id) {
  loadConfig();
  return _campaigns[id] || _campaigns.cold_outreach;
}

export async function generateLinkedInMessage({ lead, messageType, customContext }) {
  const vertical = getVertical(lead.vertical);
  const charLimit = messageType === 'connection' ? 300 : 1000;

  const system = `You are a professional outreach specialist for GuardTech Solutions, a cybersecurity and IT solutions company.

${vertical.gts_value_prop}

Tone guidance: ${vertical.tone_guidance}

Key pain points for this vertical:
${vertical.pain_points.map(p => `- ${p}`).join('\n')}

Rules:
- Write in first person as a GuardTech Solutions representative
- Never use: "I came across your profile", "I hope this finds you well", "synergies"
- Be specific to their background — generic messages are deleted
- Output ONLY the message body, no greeting, no subject line`;

  const user = `Write a LinkedIn ${messageType === 'connection' ? 'connection request note' : 'direct message'} for this prospect.

PROSPECT:
- Name: ${lead.first_name}${lead.last_name ? ' ' + lead.last_name : ''}
- Title: ${lead.title || 'Unknown'}
- Company: ${lead.company || 'Unknown'}
- Location: ${lead.location || 'Not specified'}
- About: ${lead.about ? lead.about.substring(0, 400) : 'Not available'}
${customContext ? `\nAdditional context: ${customContext}` : ''}

MAX LENGTH: ${charLimit} characters (strict — count carefully).
Output ONLY the message text.`;

  logger.debug(`Generating LinkedIn ${messageType} for ${lead.first_name} ${lead.last_name || ''}`);

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }]
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '';
  logger.debug(`Generated ${text.length} chars for ${lead.first_name}`);
  return text;
}

export async function generateEmail({ lead, emailType, sequenceStep, previousTouches }) {
  const vertical = getVertical(lead.vertical);
  const charLimit = emailType === 'email_breakup' ? 300 : 500;

  const touchSummary = previousTouches?.length
    ? `Previous touches:\n${previousTouches.map(t => `- ${t.channel} ${t.type} on ${t.sent_at} (${t.status})`).join('\n')}`
    : 'No previous contact';

  const system = `You are a business development representative for GuardTech Solutions, a cybersecurity and IT solutions company.

${vertical.gts_value_prop}

Tone: ${vertical.tone_guidance}

Pain points for this vertical:
${vertical.pain_points.map(p => `- ${p}`).join('\n')}

Email sequence context:
- Step ${sequenceStep} of the sequence
- Type: ${emailType}
- ${emailType === 'email_intro' ? 'This is the first email — make a strong first impression' : ''}
- ${emailType === 'email_followup_1' ? 'This is a follow-up — reference that they may have missed the first email, come from a different angle' : ''}
- ${emailType === 'email_breakup' ? 'This is the final email — make it short, acknowledge it\'s the last outreach, leave the door open' : ''}

Rules:
- Write in first person as a GuardTech Solutions representative
- No generic openers
- Max ${charLimit} words
- Output ONLY the email body (no subject, no signature)`;

  const user = `Write a ${emailType.replace(/_/g, ' ')} email for this prospect.

PROSPECT:
- Name: ${lead.first_name}${lead.last_name ? ' ' + lead.last_name : ''}
- Title: ${lead.title || 'Decision maker'}
- Company: ${lead.company || 'their organization'}
- Vertical: ${vertical.name}
- Notes: ${lead.notes || 'None'}

${touchSummary}

Output ONLY the email body text.`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    thinking: { type: 'adaptive' },
    system,
    messages: [{ role: 'user', content: user }]
  });

  return response.content.find(b => b.type === 'text')?.text?.trim() || '';
}

export async function generateSubject({ lead, emailType, template }) {
  if (!template) return `GuardTech Solutions — quick note for ${lead.company || lead.first_name}`;

  const subject = template
    .replace('{company}', lead.company || 'your organization')
    .replace('{first_name}', lead.first_name || 'there');

  return subject;
}

export async function enrichLeadWithClaude(lead, rawData) {
  const system = `You are a data analyst helping enrich B2B sales leads for GuardTech Solutions.
Given raw information about a prospect, extract and structure key details.
Output valid JSON only.`;

  const user = `Extract and structure this lead information:

RAW DATA:
${JSON.stringify(rawData, null, 2)}

EXISTING LEAD:
${JSON.stringify({ name: `${lead.first_name} ${lead.last_name}`, company: lead.company, title: lead.title }, null, 2)}

Return JSON with these fields (null if unknown):
{
  "email": string | null,
  "phone": string | null,
  "title": string | null,
  "company": string | null,
  "location": string | null,
  "about": string | null,
  "score": number (0-100, based on decision-maker seniority and company fit for cybersecurity),
  "notes": string | null
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 512,
    system,
    messages: [{ role: 'user', content: user }]
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
  try {
    return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
  } catch {
    return {};
  }
}

export async function scoreAndQualifyLead(lead, replyText) {
  const system = `You are a sales qualification specialist for GuardTech Solutions.
Analyze a prospect's reply to determine their level of interest and readiness.
Output valid JSON only.`;

  const user = `Qualify this sales reply:

FROM: ${lead.first_name} ${lead.last_name || ''} at ${lead.company || 'unknown company'}
VERTICAL: ${lead.vertical}

REPLY:
"${replyText}"

Return JSON:
{
  "qualified": boolean,
  "intent": "positive" | "neutral" | "negative" | "unsubscribe",
  "suggested_status": "qualified" | "meeting_booked" | "replied" | "closed_lost" | "unsubscribed",
  "next_action": string,
  "score_adjustment": number (-20 to +40),
  "notes": string
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 256,
    system,
    messages: [{ role: 'user', content: user }]
  });

  const text = response.content.find(b => b.type === 'text')?.text?.trim() || '{}';
  try {
    return JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
  } catch {
    return { qualified: false, intent: 'neutral', suggested_status: 'replied', next_action: 'Manual review', score_adjustment: 0 };
  }
}
