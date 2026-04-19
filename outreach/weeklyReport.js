import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import supabase from '../shared/db.js';
import { log } from '../shared/logger.js';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Metric brand colors
const TEAL = '#00D4FF';
const NAVY = '#111827';
const DEEP = '#080C18';

function getWeekStart() {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now);
  monday.setDate(diff);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function toDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function formatWeekLabel(monday) {
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const opts = { month: 'short', day: 'numeric' };
  const start = monday.toLocaleDateString('en-US', opts);
  const end = sunday.toLocaleDateString('en-US', { ...opts, year: 'numeric' });
  return `${start}–${end}`;
}

async function sendBrevoHtml(to, subject, html) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      sender: { name: process.env.BREVO_FROM_NAME || 'Metric', email: process.env.BREVO_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Brevo API error: ${err}`);
  }
}

async function getSynthesis(currentMetrics, snapshots) {
  const lastWeek = snapshots.length > 0 ? snapshots[snapshots.length - 1].metrics : null;
  const weeksOfData = snapshots.length;

  const prompt = `You are writing the weekly performance summary for Metric Outreach — a solo founder's cold email system targeting home service businesses (plumbers, HVAC, electricians, landscapers, handymen). The product being sold is a missed call text-back follow-up system at $97/mo.

WEEK: ${currentMetrics.weekLabel}
RAW DATA THIS WEEK:
${JSON.stringify(currentMetrics, null, 2)}

LAST WEEK'S DATA:
${lastWeek ? JSON.stringify(lastWeek, null, 2) : 'No prior data yet'}

WEEKS OF DATA COLLECTED: ${weeksOfData}

Respond ONLY in valid JSON (no markdown, no extra text):
{
  "working_well": ["bullet 1", "bullet 2"],
  "needs_adjustment": ["bullet 1", "bullet 2"],
  "recommendations": ["action 1", "action 2", "action 3"],
  "abandon_suggestions": []
}

Rules:
- Reference actual numbers (cities, service types, reply counts)
- Solo founder, no team, $150/day email cap
- abandon_suggestions: ONLY if ${weeksOfData >= 4 ? 'a specific city or service type has 0 positive replies across all 4 weeks' : 'leave empty — less than 4 weeks of data'}
- Each bullet: 1-2 sentences max`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  const text = message.content[0].text.trim();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    return { working_well: [], needs_adjustment: [], recommendations: [], abandon_suggestions: [] };
  }
}

function buildPipelineChecks(metrics) {
  const checks = [];

  // Agent health
  const agentNames = ['leadSourcing', 'enrichment', 'copyGen', 'sequenceSender', 'replyHandler'];
  const failedAgents = agentNames.filter(name => {
    const h = (metrics.agentHealth || []).find(a => a.agent_name === name);
    return !h || h.status !== 'ok';
  });
  if (failedAgents.length === 0) {
    checks.push({ label: 'Agent health', status: 'ok', message: 'All agents ran successfully' });
  } else {
    checks.push({ label: 'Agent health', status: 'error', message: `Failed: ${failedAgents.join(', ')}` });
  }

  // Email cap (150/day)
  const dailyAvg = metrics.emailsSentWeek / 7;
  if (metrics.emailsSentWeek === 0) {
    checks.push({ label: 'Email outreach', status: 'warn', message: 'No emails sent this week' });
  } else if (dailyAvg >= 140) {
    checks.push({ label: 'Email cap', status: 'warn', message: `Averaging ${Math.round(dailyAvg)}/day — near 150/day cap. Consider scaling up.` });
  } else {
    checks.push({ label: 'Email outreach', status: 'ok', message: `${metrics.emailsSentWeek} sent (avg ${Math.round(dailyAvg)}/day of 150 cap)` });
  }

  // Positive reply rate
  if (metrics.emailsSentWeek > 0) {
    const replyRate = ((metrics.positiveRepliesWeek / metrics.emailsSentWeek) * 100).toFixed(2);
    if (parseFloat(replyRate) < 0.5) {
      checks.push({ label: 'Positive replies', status: 'warn', message: `${replyRate}% positive reply rate — below 0.5%` });
    } else {
      checks.push({ label: 'Positive replies', status: 'ok', message: `${replyRate}% positive reply rate` });
    }
  }

  // Calls booked
  if (metrics.callsBookedWeek === 0) {
    checks.push({ label: 'Calls booked', status: 'warn', message: 'No calls booked this week' });
  } else {
    checks.push({ label: 'Calls booked', status: 'ok', message: `${metrics.callsBookedWeek} call(s) booked this week` });
  }

  return checks;
}

function statBox(value, label, highlight) {
  const color = highlight ? '#16a34a' : DEEP;
  return `<div style="background:#f9f9f7;border-radius:10px;padding:14px 16px">
    <div style="font-size:22px;font-weight:700;color:${color}">${value}</div>
    <div style="font-size:12px;color:#888;margin-top:3px">${label}</div>
  </div>`;
}

function tableRow(label, value) {
  return `<tr><td style="padding:7px 0;color:#555;font-size:13px;border-top:1px solid #f0f0f0">${label}</td><td style="padding:7px 0;text-align:right;font-weight:700;color:${DEEP};font-size:13px;border-top:1px solid #f0f0f0">${value ?? 0}</td></tr>`;
}

function synthSection(title, items, color) {
  if (!items || items.length === 0) return '';
  return `<div style="margin-top:20px">
    <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 8px">${title}</p>
    ${items.map(item => `<p style="font-size:13px;color:${color};margin:0 0 6px;line-height:1.5;padding-left:12px;border-left:3px solid ${color}30">${item}</p>`).join('')}
  </div>`;
}

function buildHtml(metrics, synthesis, checks, weekLabel) {
  const pipelineRows = checks.map(c => {
    const icon = c.status === 'ok' ? '✅' : c.status === 'warn' ? '⚠️' : '❌';
    return `<div style="display:flex;gap:10px;padding:11px 18px;border-top:1px solid #1e2a3a;align-items:flex-start">
      <span style="font-size:15px;flex-shrink:0">${icon}</span>
      <span style="font-size:13px;color:#cbd5e1;line-height:1.5"><strong style="color:#fff">${c.label}:</strong> ${c.message}</span>
    </div>`;
  }).join('');

  const funnelRows = [
    ['New leads sourced', metrics.newLeadsWeek],
    ['Qualified (score ≥ 6)', metrics.qualifiedLeadsWeek],
    ['In sequence (all-time)', metrics.inSequenceTotal],
    ['Emails sent this week', metrics.emailsSentWeek],
    ['All replies this week', metrics.allRepliesWeek],
    ['Positive replies this week', metrics.positiveRepliesWeek],
    ['Calls booked this week', metrics.callsBookedWeek],
    ['Calls booked all-time', metrics.callsBookedTotal],
  ].map(([l, v]) => tableRow(l, v)).join('');

  const serviceRows = (metrics.leadsByService || []).map(r =>
    `<tr><td style="padding:6px 0;color:#555;font-size:13px;border-top:1px solid #f0f0f0;text-transform:capitalize">${r.service_type || 'unknown'}</td><td style="padding:6px 0;text-align:right;font-weight:700;color:${DEEP};font-size:13px;border-top:1px solid #f0f0f0">${r.count}</td></tr>`
  ).join('') || `<tr><td colspan="2" style="padding:7px 0;color:#999;font-size:13px">No leads this week</td></tr>`;

  const cityRows = (metrics.leadsByCity || []).map(r =>
    `<tr><td style="padding:6px 0;color:#555;font-size:13px;border-top:1px solid #f0f0f0">${r.city}</td><td style="padding:6px 0;text-align:right;font-weight:700;color:${DEEP};font-size:13px;border-top:1px solid #f0f0f0">${r.count}</td></tr>`
  ).join('') || `<tr><td colspan="2" style="padding:7px 0;color:#999;font-size:13px">No leads this week</td></tr>`;

  const abandonSection = synthesis.abandon_suggestions && synthesis.abandon_suggestions.length > 0 ? `
    <div style="margin-top:24px;background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#dc2626;margin:0 0 8px">Consider Abandoning</p>
      ${synthesis.abandon_suggestions.map(item => `<p style="font-size:13px;color:#dc2626;margin:0 0 6px;line-height:1.5">${item}</p>`).join('')}
    </div>` : '';

  const recsSection = synthesis.recommendations && synthesis.recommendations.length > 0 ? `
    <div style="margin-top:24px;background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:14px 18px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#92400e;margin:0 0 8px">This Week's Actions</p>
      ${synthesis.recommendations.map((item, i) => `<p style="font-size:13px;color:#444;margin:0 0 6px;line-height:1.5"><strong>${i + 1}.</strong> ${item}</p>`).join('')}
    </div>` : '';

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
</head>
<body style="margin:0;padding:0;background:#f4f4f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif">
<div style="max-width:620px;margin:0 auto;background:#fff">

  <div style="background:${DEEP};padding:28px 36px;text-align:center">
    <p style="color:${TEAL};font-size:22px;font-weight:800;margin:0;letter-spacing:-.5px">METRIC</p>
    <p style="color:#94a3b8;margin:8px 0 0;font-size:14px">Outreach — Weekly Report — ${weekLabel}</p>
  </div>

  <div style="padding:32px 36px">

    <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 10px">This Week at a Glance</p>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:6px">
      ${statBox(metrics.newLeadsWeek ?? 0, 'New Leads', false)}
      ${statBox(metrics.emailsSentWeek ?? 0, 'Emails Sent', false)}
      ${statBox(metrics.allRepliesWeek ?? 0, 'All Replies', false)}
      ${statBox(metrics.positiveRepliesWeek ?? 0, 'Positive Replies', metrics.positiveRepliesWeek > 0)}
      ${statBox(metrics.callsBookedWeek ?? 0, 'Calls Booked', metrics.callsBookedWeek > 0)}
      ${statBox(metrics.callsBookedTotal ?? 0, 'Calls Total (All-Time)', false)}
    </div>

    <div style="margin-top:28px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 10px">Pipeline Funnel</p>
      <table style="width:100%;border-collapse:collapse">${funnelRows}</table>
    </div>

    <div style="margin-top:28px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 10px">Leads by Service Type</p>
      <table style="width:100%;border-collapse:collapse">${serviceRows}</table>
    </div>

    <div style="margin-top:28px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 10px">Leads by City</p>
      <table style="width:100%;border-collapse:collapse">${cityRows}</table>
    </div>

    <div style="margin-top:28px">
      <div style="background:${NAVY};border-radius:12px;overflow:hidden">
        <div style="background:${DEEP};padding:12px 18px;border-bottom:1px solid #1e2a3a">
          <span style="color:${TEAL};font-size:13px;font-weight:800;letter-spacing:.04em;text-transform:uppercase">Pipeline Health</span>
        </div>
        ${pipelineRows}
      </div>
    </div>

    <div style="margin-top:28px">
      <p style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#999;margin:0 0 10px">Analysis</p>
      <div style="background:#f9f9f7;border-radius:10px;padding:16px 18px">
        ${synthSection("What's Working", synthesis.working_well, '#16a34a')}
        ${synthSection('Needs Adjustment', synthesis.needs_adjustment, '#b45309')}
      </div>
    </div>

    ${recsSection}
    ${abandonSection}

  </div>

  <div style="background:${DEEP};padding:20px 36px;text-align:center;font-size:12px;color:#64748b">
    <p style="margin:0;color:${TEAL};font-weight:700;letter-spacing:.06em">METRIC</p>
    <p style="margin:4px 0 0">Outreach Pipeline — Weekly Owner Report</p>
  </div>

</div>
</body>
</html>`;
}

export async function run() {
  await log('info', 'weeklyReport: starting');

  const now = new Date();
  const thisMonday = getWeekStart();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const weekStart = toDateStr(thisMonday);
  const weekLabel = formatWeekLabel(thisMonday);

  // ── Pull weekly metrics ──────────────────────────────────────────────────────
  const [
    { data: newLeadsData },
    { data: sentThisWeek },
    { data: repliedLeads },
    { count: callsBookedTotal },
    { count: inSequenceTotal },
    { data: agentHealth },
  ] = await Promise.all([
    supabase.from('metric_leads').select('id, city, score, status').gte('created_at', weekAgo),
    supabase.from('metric_sequences').select('id').eq('status', 'sent').gte('sent_at', weekAgo),
    supabase.from('metric_leads').select('id, reply_text, status').in('status', ['replied', 'call_booked']).gte('last_contacted', weekAgo),
    supabase.from('metric_leads').select('id', { count: 'exact', head: true }).eq('status', 'call_booked'),
    supabase.from('metric_leads').select('id', { count: 'exact', head: true }).eq('status', 'in_sequence'),
    supabase.from('metric_system_health').select('agent_name, last_run, status'),
  ]);

  // Classify leads by service type (from source field or city-based heuristic)
  const { data: serviceLeads } = await supabase
    .from('metric_leads')
    .select('city, source')
    .gte('created_at', weekAgo);

  // City counts
  const cityCounts = {};
  for (const l of (newLeadsData || [])) {
    if (l.city) cityCounts[l.city] = (cityCounts[l.city] || 0) + 1;
  }
  const leadsByCity = Object.entries(cityCounts)
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count);

  // Service type from source field
  const serviceCounts = {};
  for (const l of (serviceLeads || [])) {
    const svc = l.source || 'unknown';
    serviceCounts[svc] = (serviceCounts[svc] || 0) + 1;
  }
  const leadsByService = Object.entries(serviceCounts)
    .map(([service_type, count]) => ({ service_type, count }))
    .sort((a, b) => b.count - a.count);

  const qualifiedLeadsWeek = (newLeadsData || []).filter(l => l.score >= 6).length;
  const callsBookedWeek = (repliedLeads || []).filter(l => l.status === 'call_booked').length;
  const positiveRepliesWeek = (repliedLeads || []).length;

  const metrics = {
    weekLabel,
    weekStart,
    newLeadsWeek: (newLeadsData || []).length,
    qualifiedLeadsWeek,
    emailsSentWeek: (sentThisWeek || []).length,
    allRepliesWeek: positiveRepliesWeek,
    positiveRepliesWeek,
    callsBookedWeek,
    callsBookedTotal: callsBookedTotal ?? 0,
    inSequenceTotal: inSequenceTotal ?? 0,
    leadsByCity,
    leadsByService,
    agentHealth: agentHealth || [],
  };

  // ── Load prior snapshots ─────────────────────────────────────────────────────
  const { data: snapshots } = await supabase
    .from('weekly_report_snapshots')
    .select('week_start, metrics')
    .order('week_start', { ascending: true })
    .limit(4);

  // ── Claude synthesis ─────────────────────────────────────────────────────────
  let synthesis = { working_well: [], needs_adjustment: [], recommendations: [], abandon_suggestions: [] };
  try {
    synthesis = await getSynthesis(metrics, snapshots || []);
  } catch (err) {
    await log('warn', 'weeklyReport: synthesis failed', { error: err.message });
  }

  // ── Pipeline checks ──────────────────────────────────────────────────────────
  const checks = buildPipelineChecks(metrics);

  // ── Build + send email ───────────────────────────────────────────────────────
  const html = buildHtml(metrics, synthesis, checks, weekLabel);
  const to = process.env.REPORT_EMAIL;
  if (!to) throw new Error('REPORT_EMAIL not set');

  await sendBrevoHtml(to, `Metric Weekly Report — ${weekLabel}`, html);
  await log('info', 'weeklyReport: email sent', { to, weekLabel });

  // ── Save snapshot ────────────────────────────────────────────────────────────
  const { error: upsertErr } = await supabase
    .from('weekly_report_snapshots')
    .upsert({ week_start: weekStart, metrics }, { onConflict: 'week_start', ignoreDuplicates: false });

  if (upsertErr) {
    await log('warn', 'weeklyReport: snapshot save failed', { error: upsertErr.message });
  } else {
    await log('info', 'weeklyReport: snapshot saved', { weekStart });
  }
}
