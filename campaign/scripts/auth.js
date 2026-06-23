/**
 * Gmail OAuth2 Setup — run once to generate your refresh token.
 *
 * Usage:
 *   1. Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env
 *   2. Run: node scripts/auth.js
 *   3. Open the URL printed, authorize Gmail access
 *   4. Paste the code back into the terminal
 *   5. Copy the printed GMAIL_REFRESH_TOKEN into your .env
 */

import { google } from 'googleapis';
import readline from 'readline';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: join(__dirname, '../.env') });

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify'
];

async function main() {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (!clientId || clientId.includes('YOUR_')) {
    console.error('\n⛔  Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET in .env first.\n');
    console.error('Steps:');
    console.error('  1. Go to https://console.cloud.google.com');
    console.error('  2. Create or select a project');
    console.error('  3. Enable the Gmail API');
    console.error('  4. Go to APIs & Services → Credentials');
    console.error('  5. Create OAuth 2.0 Client ID (Desktop app type)');
    console.error('  6. Copy Client ID and Client Secret into .env\n');
    process.exit(1);
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret, 'urn:ietf:wg:oauth:2.0:oob');

  const authUrl = auth.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('\n' + '='.repeat(60));
  console.log('GTS Gmail Authorization');
  console.log('='.repeat(60));
  console.log('\n1. Open this URL in your browser:\n');
  console.log('   ' + authUrl);
  console.log('\n2. Authorize access for the Gmail account you want to send from');
  console.log('3. Copy the authorization code and paste it below\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  rl.question('Authorization code: ', async (code) => {
    rl.close();

    try {
      const { tokens } = await auth.getToken(code.trim());

      console.log('\n' + '='.repeat(60));
      console.log('✅  Authorization successful!');
      console.log('='.repeat(60));
      console.log('\nAdd this to your .env file:\n');
      console.log(`GMAIL_REFRESH_TOKEN=${tokens.refresh_token}`);
      console.log('\n⚠️   Keep this token secret — it grants access to your Gmail account.');
      console.log('     Never commit it to git.\n');

      if (!tokens.refresh_token) {
        console.log('⚠️   No refresh token returned. This can happen if you already authorized this app.');
        console.log('    Go to https://myaccount.google.com/permissions, revoke access, and run auth again.\n');
      }
    } catch (err) {
      console.error(`\n⛔  Auth failed: ${err.message}\n`);
      process.exit(1);
    }
  });
}

main();
