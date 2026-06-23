import { google } from 'googleapis';
import { credentials } from '../config/credentials.js';
import { logger } from '../utils/logger.js';

let _client;

function getClient() {
  if (!_client) {
    const auth = new google.auth.OAuth2(
      credentials.gmail.clientId,
      credentials.gmail.clientSecret
    );
    auth.setCredentials({ refresh_token: credentials.gmail.refreshToken });
    _client = google.gmail({ version: 'v1', auth });
  }
  return _client;
}

function encodeEmail({ to, subject, body, replyToMessageId, replyToThreadId }) {
  const from = `GuardTech Solutions <${credentials.gmail.userEmail}>`;
  let raw = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    ''
  ];

  if (replyToMessageId) {
    raw.push(`In-Reply-To: ${replyToMessageId}`);
    raw.push(`References: ${replyToMessageId}`);
  }

  raw.push('', body);

  const encoded = Buffer.from(raw.join('\n')).toString('base64url');
  return { raw: encoded, threadId: replyToThreadId };
}

export async function sendEmail({ to, subject, body, replyToMessageId, replyToThreadId }) {
  if (credentials.dryRun) {
    logger.info(`[DRY RUN] Would send email to ${to}: "${subject}"`);
    return { id: `dry-run-${Date.now()}`, threadId: replyToThreadId || `dry-thread-${Date.now()}` };
  }

  const gmail = getClient();
  const message = encodeEmail({ to, subject, body, replyToMessageId, replyToThreadId });

  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: message
    });
    logger.info(`Email sent to ${to}, messageId: ${res.data.id}`);
    return { id: res.data.id, threadId: res.data.threadId };
  } catch (err) {
    logger.error(`Failed to send email to ${to}: ${err.message}`);
    throw err;
  }
}

export async function createDraft({ to, subject, body }) {
  const gmail = getClient();
  const message = encodeEmail({ to, subject, body });

  const res = await gmail.users.drafts.create({
    userId: 'me',
    requestBody: { message }
  });
  logger.info(`Draft created for ${to}: ${res.data.id}`);
  return res.data;
}

export async function searchReplies(sinceDate) {
  const gmail = getClient();
  const since = sinceDate ? `after:${Math.floor(new Date(sinceDate).getTime() / 1000)}` : 'newer_than:7d';

  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `in:inbox ${since} -from:me`,
    maxResults: 100
  });

  if (!res.data.messages) return [];

  const messages = await Promise.all(
    res.data.messages.slice(0, 20).map(async m => {
      const msg = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'full' });
      const headers = msg.data.payload?.headers || [];
      const getHeader = name => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

      const body = extractBody(msg.data.payload);

      return {
        id: m.id,
        threadId: msg.data.threadId,
        from: getHeader('From'),
        replyTo: getHeader('Reply-To'),
        subject: getHeader('Subject'),
        date: getHeader('Date'),
        inReplyTo: getHeader('In-Reply-To'),
        body: body.substring(0, 2000)
      };
    })
  );

  return messages;
}

function extractBody(payload) {
  if (!payload) return '';

  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        return Buffer.from(part.body.data, 'base64').toString('utf8');
      }
    }
    for (const part of payload.parts) {
      const nested = extractBody(part);
      if (nested) return nested;
    }
  }

  return '';
}

export async function checkEmailExists(email) {
  try {
    const gmail = getClient();
    const res = await gmail.users.messages.list({
      userId: 'me',
      q: `to:${email}`,
      maxResults: 1
    });
    return !!(res.data.messages?.length);
  } catch {
    return false;
  }
}
