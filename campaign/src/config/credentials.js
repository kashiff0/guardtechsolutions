import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '../../.env');

if (existsSync(envPath)) {
  const { default: dotenv } = await import('dotenv');
  dotenv.config({ path: envPath });
}

const REQUIRED = [
  {
    key: 'ANTHROPIC_API_KEY',
    validate: v => v.startsWith('sk-ant-'),
    hint: 'Get from https://console.anthropic.com → API Keys'
  },
  {
    key: 'GMAIL_CLIENT_ID',
    validate: v => v.includes('.apps.googleusercontent.com'),
    hint: 'Google Cloud Console → APIs & Services → Credentials'
  },
  {
    key: 'GMAIL_CLIENT_SECRET',
    validate: v => v.length > 10,
    hint: 'Google Cloud Console → APIs & Services → Credentials'
  },
  {
    key: 'GMAIL_REFRESH_TOKEN',
    validate: v => v.length > 20,
    hint: 'Run: npm run auth (one-time Gmail OAuth setup)'
  },
  {
    key: 'GMAIL_USER_EMAIL',
    validate: v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v),
    hint: 'The Gmail address to send outreach from'
  }
];

function loadAndValidate() {
  const missing = [];
  const invalid = [];

  for (const { key, validate, hint } of REQUIRED) {
    const val = process.env[key];
    if (!val || val.includes('YOUR_')) {
      missing.push(`  ${key}\n    → ${hint}`);
    } else if (!validate(val)) {
      invalid.push(`  ${key} — unexpected format\n    → ${hint}`);
    }
  }

  if (missing.length || invalid.length) {
    const lines = ['', '⛔  Credential check failed — copy .env.example to .env and fill in values.'];
    if (missing.length) lines.push('\nMissing:', ...missing);
    if (invalid.length) lines.push('\nInvalid format:', ...invalid);
    lines.push('');
    throw new Error(lines.join('\n'));
  }

  return Object.freeze({
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    dryRun: process.env.DRY_RUN !== 'false',
    gmail: Object.freeze({
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      userEmail: process.env.GMAIL_USER_EMAIL
    }),
    limits: Object.freeze({
      dailyEmail: parseInt(process.env.DAILY_EMAIL_LIMIT || '50'),
      dailyLinkedin: parseInt(process.env.DAILY_LINKEDIN_LIMIT || '15'),
      discoveryPerRun: parseInt(process.env.DISCOVERY_LIMIT || '100')
    }),
    enrichment: Object.freeze({
      hunterApiKey: process.env.HUNTER_API_KEY || null,
      clearbitApiKey: process.env.CLEARBIT_API_KEY || null
    }),
    discovery: Object.freeze({
      googlePlacesApiKey: process.env.GOOGLE_PLACES_API_KEY || null,
      serpApiKey: process.env.SERP_API_KEY || null
    })
  });
}

export const credentials = loadAndValidate();
