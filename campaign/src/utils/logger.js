import { createWriteStream, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(__dirname, '../../logs');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const currentLevel = LEVELS[process.env.LOG_LEVEL || 'info'] ?? 1;

// Strip patterns that look like API keys or tokens from log output
const SECRET_PATTERNS = [
  /sk-ant-[a-zA-Z0-9\-_]+/g,
  /1\/\/[a-zA-Z0-9\-_.]+/g,
  /Bearer [a-zA-Z0-9\-_.]+/g,
  /client_secret=[^&\s]+/g
];

function redact(message) {
  let safe = String(message);
  for (const pattern of SECRET_PATTERNS) {
    safe = safe.replace(pattern, '[REDACTED]');
  }
  return safe;
}

let logStream;
try {
  mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  logStream = createWriteStream(join(LOG_DIR, `campaign-${date}.log`), { flags: 'a' });
} catch {
  // If log dir can't be created, fall back to console only
}

function log(level, ...args) {
  if (LEVELS[level] < currentLevel) return;

  const message = args.map(a =>
    typeof a === 'object' ? JSON.stringify(a, null, 2) : String(a)
  ).join(' ');

  const safe = redact(message);
  const ts = new Date().toISOString();
  const line = `[${ts}] [${level.toUpperCase()}] ${safe}`;

  console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](line);
  logStream?.write(line + '\n');
}

export const logger = {
  debug: (...args) => log('debug', ...args),
  info: (...args) => log('info', ...args),
  warn: (...args) => log('warn', ...args),
  error: (...args) => log('error', ...args)
};
