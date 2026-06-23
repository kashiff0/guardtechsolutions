/**
 * Campaign Report Script
 * Prints a weekly summary of campaign performance.
 *
 * Usage: node scripts/report.js   (or: npm run report)
 *
 * Reads from Supabase and aggregates client-side — the dataset is small and
 * Supabase's JS client has no GROUP BY, so we pull the rows and reduce here.
 */
import { supabase } from '../src/db/schema.js';
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

// group an array of rows by a key fn into [{...}] with running tallies
function tally(rows, keyFn, addFn) {
  const map = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, addFn(r, null));
    else map.set(k, addFn(r, map.get(k)));
  }
  return [...map.values()];
}

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('GTS Campaign Report — ' + new Date().toLocaleDateString());
  console.log('='.repeat(60) + '\n');

  // Lead status breakdown
  const stats = await getStats();
  const total = stats.reduce((s, r) => s + r.count, 0) || 1;
  console.log('📋 Lead Status Breakdown\n');
  console.log(formatTable(
    stats.map(s => ({ status: s.status, count: s.count, pct: Math.round(s.count / total * 100) + '%' })),
    [{ key: 'status', label: 'Status' }, { key: 'count', label: 'Count' }, { key: 'pct', label: '%' }]
  ));

  // Touch metrics (last 30 days), grouped by type within channel
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const { data: touches = [] } = await supabase.from('touches')
    .select('channel, type, status, sent_at').gt('sent_at', cutoff);

  const touchRows = (channel) => tally(
    (touches || []).filter(t => t.channel === channel),
    t => t.type,
    (t, acc) => ({
      type: t.type,
      sent: (acc?.sent || 0) + 1,
      opens: (acc?.opens || 0) + (t.status === 'opened' ? 1 : 0),
      replies: (acc?.replies || 0) + (t.status === 'replied' ? 1 : 0)
    })
  );

  const emailStats = touchRows('email');
  if (emailStats.length) {
    console.log('\n📧 Email Performance (Last 30 Days)\n');
    console.log(formatTable(emailStats, [
      { key: 'type', label: 'Email Type' },
      { key: 'sent', label: 'Sent' },
      { key: 'opens', label: 'Opens' },
      { key: 'replies', label: 'Replies' }
    ]));
  }

  const liMetrics = touchRows('linkedin');
  if (liMetrics.length) {
    console.log('\n🔗 LinkedIn Performance (Last 30 Days)\n');
    console.log(formatTable(liMetrics, [
      { key: 'type', label: 'Type' },
      { key: 'sent', label: 'Sent' },
      { key: 'replies', label: 'Replies' }
    ]));
  }

  // Leads, used for vertical breakdown + hot leads
  const { data: leads = [] } = await supabase.from('leads')
    .select('first_name, last_name, company, title, status, score, vertical');

  const byVertical = tally(
    leads || [],
    l => l.vertical || 'unknown',
    (l, acc) => ({
      vertical: l.vertical || 'unknown',
      count: (acc?.count || 0) + 1,
      qualified: (acc?.qualified || 0) + (['qualified', 'meeting_booked'].includes(l.status) ? 1 : 0)
    })
  ).sort((a, b) => b.count - a.count);

  console.log('\n🏢 Leads by Vertical\n');
  console.log(formatTable(byVertical, [
    { key: 'vertical', label: 'Vertical' },
    { key: 'count', label: 'Total' },
    { key: 'qualified', label: 'Qualified' }
  ]));

  const hotLeads = (leads || [])
    .filter(l => ['replied', 'qualified', 'meeting_booked'].includes(l.status))
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 10)
    .map(l => ({
      name: `${l.first_name || ''} ${l.last_name || ''}`.trim(),
      company: l.company,
      status: l.status,
      score: l.score
    }));

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

main().then(() => process.exit(0)).catch(err => { console.error(err.message); process.exit(1); });
