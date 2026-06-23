/**
 * Email Outreach Agent
 * Processes the lead queue, generates personalized emails via Claude,
 * sends via Gmail, and records all touches.
 *
 * Sequence logic:
 *   step 1 = email_intro       (day 0)
 *   step 2 = email_followup_1  (day 3-4)
 *   step 3 = email_breakup     (day 7+)
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { getLeadsForEmail, updateLeadStatus, LEAD_STATUS } from '../db/leads.js';
import { recordTouch, getTouchHistory, countTouches } from '../db/touches.js';
import { generateEmail, generateSubject } from '../skills/claude.js';
import { sendEmail } from '../skills/gmail.js';
import { emailLimiter } from '../utils/rateLimiter.js';
import { logger } from '../utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const campaignsConfig = yaml.load(readFileSync(join(__dirname, '../../config/campaigns.yaml'), 'utf8')).campaigns;

const EMAIL_SEQUENCE_TYPES = ['email_intro', 'email_followup_1', 'email_breakup'];
const MIN_DAYS_BETWEEN = [0, 3, 5];

function getSequenceStep(lead, touchHistory) {
  const emailTouches = touchHistory.filter(t => t.channel === 'email' && t.status !== 'error');
  return emailTouches.length;
}

function isReadyForNextEmail(lead, touchHistory, step) {
  if (step === 0) return true;

  const lastEmail = touchHistory
    .filter(t => t.channel === 'email')
    .sort((a, b) => new Date(b.sent_at) - new Date(a.sent_at))[0];

  if (!lastEmail) return true;

  const daysSinceLast = (Date.now() - new Date(lastEmail.sent_at)) / (1000 * 60 * 60 * 24);
  const minDays = MIN_DAYS_BETWEEN[step] || 5;
  return daysSinceLast >= minDays;
}

async function processLead(lead) {
  const campaign = campaignsConfig[lead.campaign_id] || campaignsConfig.cold_outreach;
  const touchHistory = getTouchHistory(lead.id);
  const emailStep = getSequenceStep(lead, touchHistory);

  if (emailStep >= EMAIL_SEQUENCE_TYPES.length) {
    logger.info(`Lead ${lead.id} (${lead.first_name}) — email sequence complete`);
    updateLeadStatus(lead.id, LEAD_STATUS.CLOSED_LOST, { notes: 'Email sequence completed, no reply' });
    return { skipped: true, reason: 'sequence_complete' };
  }

  if (!isReadyForNextEmail(lead, touchHistory, emailStep)) {
    return { skipped: true, reason: 'too_soon' };
  }

  const emailType = EMAIL_SEQUENCE_TYPES[emailStep];
  const campaignStep = campaign.sequence?.find(s => s.type === emailType);

  const acquired = await emailLimiter.acquire('email');
  if (!acquired) return { skipped: true, reason: 'rate_limit' };

  let body, subject;
  try {
    body = await generateEmail({
      lead,
      emailType,
      sequenceStep: emailStep + 1,
      previousTouches: touchHistory.filter(t => t.channel === 'email')
    });

    subject = await generateSubject({
      lead,
      emailType,
      template: campaignStep?.subject_template
    });
  } catch (err) {
    logger.error(`Claude generation failed for lead ${lead.id}: ${err.message}`);
    recordTouch({ leadId: lead.id, channel: 'email', type: emailType, step: emailStep + 1, status: 'error', error: err.message });
    return { error: err.message };
  }

  try {
    const result = await sendEmail({ to: lead.email, subject, body });

    recordTouch({
      leadId: lead.id,
      channel: 'email',
      type: emailType,
      step: emailStep + 1,
      body,
      subject,
      messageId: result.id,
      status: 'sent'
    });

    updateLeadStatus(lead.id, LEAD_STATUS.EMAIL_SEQUENCE, {
      sequence_step: emailStep + 1,
      last_contacted_at: new Date().toISOString()
    });

    logger.info(`✓ Email sent to ${lead.first_name} ${lead.last_name || ''} <${lead.email}> — step ${emailStep + 1} (${emailType})`);
    return { sent: true, emailType, step: emailStep + 1 };

  } catch (err) {
    logger.error(`Send failed for ${lead.email}: ${err.message}`);
    recordTouch({ leadId: lead.id, channel: 'email', type: emailType, step: emailStep + 1, status: 'error', error: err.message });
    return { error: err.message };
  }
}

export async function runEmailAgent(limit = 50) {
  logger.info('=== Email Agent Starting ===');
  const leads = getLeadsForEmail(limit);
  logger.info(`Found ${leads.length} leads ready for email`);

  const results = { sent: 0, skipped: 0, errors: 0 };

  for (const lead of leads) {
    const result = await processLead(lead);
    if (result.sent) results.sent++;
    else if (result.skipped) results.skipped++;
    else if (result.error) results.errors++;
  }

  logger.info(`=== Email Agent Done — sent: ${results.sent}, skipped: ${results.skipped}, errors: ${results.errors} ===`);
  return results;
}

// Direct run
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runEmailAgent().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
