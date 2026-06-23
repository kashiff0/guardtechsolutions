import { logger } from './logger.js';

export class RateLimiter {
  constructor({ dailyLimit, delayMs = 2000 }) {
    this.dailyLimit = dailyLimit;
    this.delayMs = delayMs;
    this.counters = new Map();
  }

  _todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  getCount(channel) {
    const key = `${channel}:${this._todayKey()}`;
    return this.counters.get(key) || 0;
  }

  canProceed(channel) {
    return this.getCount(channel) < this.dailyLimit;
  }

  increment(channel) {
    const key = `${channel}:${this._todayKey()}`;
    this.counters.set(key, (this.counters.get(key) || 0) + 1);
  }

  async wait() {
    await new Promise(r => setTimeout(r, this.delayMs));
  }

  async acquire(channel) {
    if (!this.canProceed(channel)) {
      logger.warn(`Rate limit reached for ${channel} today (${this.getCount(channel)}/${this.dailyLimit})`);
      return false;
    }
    this.increment(channel);
    await this.wait();
    return true;
  }
}

export const emailLimiter = new RateLimiter({
  dailyLimit: parseInt(process.env.DAILY_EMAIL_LIMIT || '50'),
  delayMs: 3000
});

export const linkedinLimiter = new RateLimiter({
  dailyLimit: parseInt(process.env.DAILY_LINKEDIN_LIMIT || '15'),
  delayMs: 5000
});
