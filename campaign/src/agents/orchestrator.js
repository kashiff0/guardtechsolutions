/**
 * GTS Campaign Orchestrator
 * Master agent that coordinates all outreach channels.
 *
 * Run modes:
 *   npm run run           — single pass (CI/cron friendly)
 *   npm run run -- --watch — continuous mode with cron schedule
 *
 * Phase execution order:
 *   1. Enrich new leads (Claude + Hunter + Clearbit)
 *   2. Check Gmail inbox for replies → qualify & update status
 *   3. Run email sequence for ready leads
 *   4. Start LinkedIn queue server for extension integration
 */

import { fileURLToPath } from 'url';
import cron from 'node-cron';
import { getStats, getLeadByEmail, updateLeadStatus, LEAD_STATUS } from '../db/leads.js';
import { searchReplies } from '../skills/gmail.js';
import { scoreAndQualifyLead } from '../skills/claude.js';
import { markTouchReplied, hasReplied } from '../db/touches.js';
import { createRun, finishRun } from '../db/runs.js';
import { runEnrichmentAgent } from './enrichment.js';
import { runEmailAgent } from './email.js';
import { startQueueServer } from './linkedin.js';
import { logger } from '../utils/logger.js';

async function processReplies() {
  logger.info('Checking Gmail for replies...');

  let replies;
  try {
    replies = await searchReplies();
  } catch (err) {
    logger.warn(`Gmail reply check failed: ${err.message}`);
    return { processed: 0 };
  }

  let processed = 0;

  for (const reply of replies) {
    // Match reply to a lead by email address
    const emailFrom = reply.from.match(/<([^>]+)>/)?.[1] || reply.from;

    const lead = await getLeadByEmail(emailFrom);
    if (!lead) continue;

    if (await hasReplied(lead.id, 'email')) continue;

    logger.info(`Reply from ${lead.first_name} ${lead.last_name || ''} (${emailFrom}): "${reply.subject}"`);

    let qualification;
    try {
      qualification = await scoreAndQualifyLead(lead, reply.body);
    } catch {
      qualification = { suggested_status: LEAD_STATUS.REPLIED, score_adjustment: 0, notes: 'Manual review needed' };
    }

    await markTouchReplied(lead.id, 'email');

    const newScore = Math.min(100, Math.max(0, (lead.score || 50) + (qualification.score_adjustment || 0)));
    await updateLeadStatus(lead.id, qualification.suggested_status || LEAD_STATUS.REPLIED, {
      score: newScore,
      notes: qualification.notes || null
    });

    logger.info(`Lead ${lead.id} qualified — intent: ${qualification.intent}, status: ${qualification.suggested_status}`);
    processed++;
  }

  return { processed };
}

async function logCampaignStats() {
  const stats = await getStats();
  const total = stats.reduce((sum, s) => sum + s.count, 0) || 1;
  logger.info(`\n📊 Campaign Stats (${total} leads total):`);
  for (const { status, count } of stats) {
    const pct = Math.round((count / total) * 100);
    logger.info(`   ${status.padEnd(30)} ${count} (${pct}%)`);
  }
}

async function runOnce() {
  const runId = await createRun();
  const stats = { leadsProcessed: 0, emailsSent: 0, errors: 0 };

  logger.info(`\n${'='.repeat(50)}`);
  logger.info(`GTS Campaign Run: ${runId}`);
  logger.info(`${'='.repeat(50)}\n`);

  // Phase 1: Enrich new leads
  const enrichResult = await runEnrichmentAgent(20);
  stats.leadsProcessed += enrichResult.enriched;
  stats.errors += enrichResult.errors;

  // Phase 2: Process replies
  const replyResult = await processReplies();
  logger.info(`Processed ${replyResult.processed} replies`);

  // Phase 3: Email outreach
  const emailResult = await runEmailAgent(50);
  stats.emailsSent += emailResult.sent;
  stats.errors += emailResult.errors;

  // Log stats
  await logCampaignStats();

  await finishRun(runId, {
    leadsProcessed: stats.leadsProcessed,
    emailsSent: stats.emailsSent,
    errors: stats.errors
  });

  logger.info(`\nRun complete: ${JSON.stringify(stats)}`);
  return stats;
}

async function runWithSchedule() {
  logger.info('Starting GTS Campaign Orchestrator in watch mode...');

  // Start LinkedIn queue server for Chrome extension
  startQueueServer(7432);

  // Run immediately on start
  await runOnce().catch(err => logger.error(`Run failed: ${err.message}`));

  // Schedule: daily at 9am and 2pm
  cron.schedule('0 9 * * 1-5', () => {
    logger.info('9am scheduled run');
    runOnce().catch(err => logger.error(`Scheduled run failed: ${err.message}`));
  });

  cron.schedule('0 14 * * 1-5', () => {
    logger.info('2pm scheduled run');
    runOnce().catch(err => logger.error(`Scheduled run failed: ${err.message}`));
  });

  // Check for replies every 2 hours
  cron.schedule('0 */2 * * *', () => {
    processReplies().catch(err => logger.error(`Reply check failed: ${err.message}`));
  });

  logger.info('Scheduled: Mon-Fri 9am & 2pm (email runs), every 2hr (reply check)');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const watchMode = process.argv.includes('--watch');

  if (watchMode) {
    runWithSchedule().catch(err => {
      logger.error(err.message);
      process.exit(1);
    });
  } else {
    runOnce().then(() => process.exit(0)).catch(err => {
      logger.error(err.message);
      process.exit(1);
    });
  }
}
