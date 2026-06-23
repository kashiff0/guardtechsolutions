/**
 * Campaign Report Script
 * Prints a weekly summary of campaign performance.
 *
 * Usage: node scripts/report.js
 */

import { getDb } from '../src/db/schema.js';
import { getStats } from '../src/db/leads.js';

function formatTable(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(r[c.key] ?? '').length)));
  const line = widths.map(w => '-'.repeat(w + 2)).join('+');
  const header = cols.map((c, i) => ` ${c.label.padEnd(widths[i])} `).join('|');

  const lines = [line, `|${header}|`, line];
  for (const row of rows) {
    const cells = cols.map((c, i) => ` ${String(row[c.key] ?? '').padEnd(widths[i])} `).join('|');
    lines.push(`|${cells}|`);
  }
  lines.push(line);
  return lines.join('\n');
}

function main() {
  const db = getDb();

  console.log('\n' + '='.repeat(60));
  console.log('GTS Campaign Report — ' + new Date().toLocaleDateString());
  console.log('='.repeat(60) + '\n');

  // Lead status breakdown
  const stats = getStats();
  const total = stats.reduce((s, r) => s + r.count, 0);
  console.log('📋 Lead Status Breakdown\n');
  console.log(formatTable(
    stats.map(s => ({ status: s.status, count: s.count, pct: Math.round(s.count / total * 100) + '%' })),
    [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Count' }, { key: 'pct', label: '%' }]
  ));

  // Email metrics (last 30 days)
  const emailStats = db.prepare(`
    SELECT
      type,
      COUNT(*) as sent,
      SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replies,
      SUM(CASE WHEN status = 'opened' THEN 1 ELSE 0 END) as opens
    FROM touches
    WHERE channel = 'email' AND sent_at > datetime('now', '-30 days')
    GROUP BY type
  `).all();

  if (emailStats.length) {
    console.log('\n📧 Email Performance (Last 30 Days)\n');
    console.log(formatTable(emailStats, [
      { key: 'type', label: 'Email Type' },
      { key: 'sent', label: 'Sent' },
      { key: 'opens', label: 'Opens' },
      { key: 'replies', label: 'Replies' }
    ]));
  }

  // LinkedIn metrics
  const liMetrics = db.prepare(`
    SELECT
      type,
      COUNT(*) as sent,
      SUM(CASE WHEN status = 'replied' THEN 1 ELSE 0 END) as replies
    FROM touches
    WHERE channel = 'linkedin' AND sent_at > datetime('now', '-30 days')
    GROUP BY type
  `).all();

  if (liMetrics.length) {
    console.log('\n🔗 LinkedIn Performance (Last 30 Days)\n');
    console.log(formatTable(liMetrics, [
      { key: 'type', label: 'Type' },
      { key: 'sent', label: 'Sent' },
      { key: 'replies', label: 'Replies' }
    ]));
  }

  // Vertical breakdown
  const byVertical = db.prepare(`
    SELECT vertical, COUNT(*) as count,
           SUM(CASE WHEN status = 'qualified' OR status = 'meeting_booked' THEN 1 ELSE 0 END) as qualified
    FROM leads GROUP BY vertical ORDER BY count DESC
  `).all();

  console.log('\n🏢 Leads by Vertical\n');
  console.log(formatTable(byVertical, [
    { key: 'vertical', label: 'Vertical' },
    { key: 'count', label: 'Total' },
    { key: 'qualified', label: 'Qualified' }
  ]));

  // Hot leads
  const hotLeads = db.prepare(`
    SELECT first_name || ' ' || COALESCE(last_name, '') as name, company, title, status, score
    FROM leads
    WHERE status IN ('replied', 'qualified', 'meeting_booked')
    ORDER BY score DESC LIMIT 10
  `).all();

  if (hotLeads.length) {
    console.log('\n🔥 Hot Leads\n');
    console.log(formatTable(hotLeads, [
      { key: 'name', label: 'Name' },
      { key: 'company', label: 'Company' },
      { key: 'status', label: 'Status' },
      { key: 'score', label: 'Score' }
    ]));
  }

  console.log('');
}

main();
