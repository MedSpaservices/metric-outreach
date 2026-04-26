import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { log } from './shared/logger.js';
import supabase from './shared/db.js';
import { sendEmail } from './shared/mailer.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'metric-outreach', time: new Date().toISOString() });
});

app.get('/health', async (req, res) => {
  try {
    const { data: health, error } = await supabase
      .from('metric_system_health')
      .select('agent_name, last_run, emails_sent_today, last_run_date')
      .order('agent_name');
    if (error) throw error;

    const { data: leads } = await supabase.from('metric_leads').select('status');

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const leadCounts = {};
    for (const l of leads || []) leadCounts[l.status] = (leadCounts[l.status] || 0) + 1;

    const agents = {};
    for (const row of health || []) {
      const lastRun = row.last_run ? new Date(row.last_run) : null;
      agents[row.agent_name] = {
        lastRun: row.last_run,
        hoursAgo: lastRun ? Math.round((now - lastRun) / 3600000 * 10) / 10 : null,
        ...(row.agent_name === 'sequenceSender' ? { emailsSentToday: row.last_run_date === today ? (row.emails_sent_today || 0) : 0 } : {})
      };
    }

    const pipelineLastRun = agents.sequenceSender?.lastRun || agents.leadSourcing?.lastRun || null;
    const pipelineHoursAgo = pipelineLastRun ? Math.round((now - new Date(pipelineLastRun)) / 3600000 * 10) / 10 : null;

    res.json({
      service: 'metric-outreach',
      db: 'connected',
      pipeline: { lastRun: pipelineLastRun, hoursAgo: pipelineHoursAgo, status: pipelineHoursAgo !== null && pipelineHoursAgo > 30 ? 'stale' : 'ok' },
      emailsSentToday: agents.sequenceSender?.emailsSentToday ?? 0,
      leads: leadCounts,
      agents,
      time: now.toISOString()
    });
  } catch (err) {
    res.status(500).json({ service: 'metric-outreach', db: 'error', error: err.message, time: new Date().toISOString() });
  }
});

app.get('/dashboard', async (req, res) => {
  if (req.query.key !== process.env.PIPELINE_SECRET) {
    return res.status(401).send('Unauthorized');
  }

  const { data: leads } = await supabase
    .from('metric_leads')
    .select('business, city, email, status, sequence_step, last_contacted, created_at')
    .order('created_at', { ascending: false })
    .limit(500);

  const counts = {};
  for (const l of leads || []) {
    counts[l.status] = (counts[l.status] || 0) + 1;
  }

  const statusColor = {
    new: '#6b7280',
    qualified: '#3b82f6',
    copy_ready: '#8b5cf6',
    in_sequence: '#f59e0b',
    replied: '#10b981',
    call_booked: '#00D4FF',
    disqualified: '#ef4444',
  };

  const badge = (s) =>
    `<span style="background:${statusColor[s] || '#6b7280'};color:#fff;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600">${s}</span>`;

  const rows = (leads || []).map(l => `
    <tr>
      <td>${l.business}</td>
      <td>${l.city || '—'}</td>
      <td style="color:#9ca3af;font-size:12px">${l.email || '—'}</td>
      <td>${badge(l.status)}</td>
      <td style="text-align:center">${l.sequence_step || 0} / 4</td>
      <td style="color:#9ca3af;font-size:12px">${l.last_contacted ? new Date(l.last_contacted).toLocaleDateString('en-US', { month:'short', day:'numeric' }) : '—'}</td>
    </tr>`).join('');

  const summaryCards = Object.entries(counts).map(([s, n]) =>
    `<div style="background:#1f2937;border-radius:8px;padding:12px 20px;text-align:center">
      <div style="font-size:24px;font-weight:700;color:${statusColor[s] || '#fff'}">${n}</div>
      <div style="font-size:12px;color:#9ca3af;margin-top:2px">${s}</div>
    </div>`
  ).join('');

  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>Metric Pipeline</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #111827; color: #f9fafb; font-family: -apple-system, sans-serif; padding: 32px 24px; }
    h1 { font-size: 20px; font-weight: 700; margin-bottom: 24px; color: #00D4FF; }
    .cards { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 32px; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 12px; color: #6b7280; font-weight: 500; border-bottom: 1px solid #374151; }
    td { padding: 10px 12px; border-bottom: 1px solid #1f2937; vertical-align: middle; }
    tr:hover td { background: #1f2937; }
  </style>
</head>
<body>
  <h1>Metric Pipeline</h1>
  <div class="cards">${summaryCards}</div>
  <table>
    <thead>
      <tr>
        <th>Business</th><th>City</th><th>Email</th><th>Status</th><th>Step</th><th>Last Sent</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`);
});

// Brevo inbound reply webhook — receives parsed replies and logs them against leads
app.post('/inbound-reply', async (req, res) => {
  res.status(200).send('OK'); // always respond 200 immediately so Brevo doesn't retry

  try {
    const { From, TextBody, HtmlBody } = req.body || {};
    if (!From) return;

    const emailMatch = From.match(/<(.+?)>/) || [null, From.trim()];
    const fromEmail = emailMatch[1]?.trim().toLowerCase();
    if (!fromEmail) return;

    const replyText = (TextBody || HtmlBody?.replace(/<[^>]+>/g, '') || '').trim();
    if (!replyText) return;

    const { data: lead } = await supabase
      .from('metric_leads')
      .select('id, status')
      .eq('email', fromEmail)
      .in('status', ['in_sequence', 'copy_ready'])
      .maybeSingle();

    if (!lead) {
      await log('info', `Inbound reply from unknown address: ${fromEmail}`);
      return;
    }

    await supabase
      .from('metric_leads')
      .update({ status: 'replied', reply_text: replyText })
      .eq('id', lead.id);

    await log('info', `Reply captured from ${fromEmail} — lead ${lead.id}`);
  } catch (err) {
    await log('error', `Inbound reply handler failed: ${err.message}`);
  }
});

// External cron trigger — POST /run-pipeline with Authorization: Bearer <PIPELINE_SECRET>
app.post('/run-pipeline', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[${new Date().toISOString()}] /run-pipeline triggered`);
  res.json({ ok: true, message: 'Pipeline started' });

  setImmediate(async () => {
    await runPipeline();
  });
});

async function runPipeline() {
  console.log(`[${new Date().toISOString()}] Pipeline starting`);
  const { run } = await import('./orchestrator.js');
  await run();
  console.log(`[${new Date().toISOString()}] Pipeline complete`);
}

// External cron trigger — POST /run-daily-report with Authorization: Bearer <PIPELINE_SECRET>
app.post('/run-daily-report', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[${new Date().toISOString()}] /run-daily-report triggered`);
  res.json({ ok: true, message: 'Daily report started' });

  setImmediate(async () => {
    try {
      const { run } = await import('./outreach/dailyReport.js');
      await run();
      console.log(`[${new Date().toISOString()}] Daily report complete`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Daily report failed — ${err.message}\n${err.stack}`);
    }
  });
});

// External cron trigger — POST /run-weekly-report with Authorization: Bearer <PIPELINE_SECRET>
app.post('/run-weekly-report', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[${new Date().toISOString()}] /run-weekly-report triggered`);
  res.json({ ok: true, message: 'Weekly report started' });

  setImmediate(async () => {
    try {
      const { run } = await import('./outreach/weeklyReport.js');
      await run();
      console.log(`[${new Date().toISOString()}] Weekly report complete`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Weekly report failed — ${err.message}\n${err.stack}`);
    }
  });
});

// Health check — POST /check-health?mode=pre|post with Authorization: Bearer <PIPELINE_SECRET>
// pre = fires 2h before pipelines run (7am EST), post = fires 1h after (10am EST)
// Only sends email if issues are found
app.post('/check-health', async (req, res) => {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (token !== process.env.PIPELINE_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const mode = req.query.mode;
  if (!['pre', 'post'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be pre or post' });
  }
  res.json({ ok: true, message: `Health check (${mode}) started` });
  setImmediate(async () => {
    try { await runHealthCheck(mode); }
    catch (err) { await log('error', `check-health failed: ${err.message}`); }
  });
});

async function runHealthCheck(mode) {
  const issues = [];

  // metric-outreach (self) — query DB directly
  try {
    const { data: health, error } = await supabase
      .from('metric_system_health')
      .select('agent_name, last_run, emails_sent_today, last_run_date')
      .order('agent_name');
    if (error) throw error;

    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const sender = health?.find(r => r.agent_name === 'sequenceSender');
    const lastRun = sender?.last_run ? new Date(sender.last_run) : null;
    const hoursAgo = lastRun ? Math.round((now - lastRun) / 3600000 * 10) / 10 : null;
    const emailsSentToday = sender?.last_run_date === today ? (sender.emails_sent_today || 0) : 0;

    if (mode === 'pre' && (hoursAgo === null || hoursAgo > 30)) {
      issues.push(`metric-outreach: pipeline last ran ${hoursAgo ?? 'never'} hours ago — yesterday may have failed`);
    }
    if (mode === 'post') {
      if (hoursAgo === null || hoursAgo > 3) {
        issues.push(`metric-outreach: pipeline hasn't run today (last run ${hoursAgo ?? 'never'} hours ago)`);
      } else if (emailsSentToday === 0) {
        issues.push(`metric-outreach: pipeline ran but 0 emails sent — sequenceSender may have failed`);
      }
    }
  } catch (err) {
    issues.push(`metric-outreach: DB unreachable — ${err.message}`);
  }

  // firmflow-outreach — hit its /health endpoint
  try {
    const r = await fetch('https://firmflow-outreach.onrender.com/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.db === 'error') {
      issues.push(`firmflow-outreach: DB error — ${data.error}`);
    } else if (mode === 'pre' && (data.pipeline?.hoursAgo === null || data.pipeline?.hoursAgo > 30)) {
      issues.push(`firmflow-outreach: pipeline last ran ${data.pipeline?.hoursAgo ?? 'never'} hours ago — yesterday may have failed`);
    } else if (mode === 'post' && (data.pipeline?.hoursAgo === null || data.pipeline?.hoursAgo > 3)) {
      issues.push(`firmflow-outreach: pipeline hasn't run today (last run ${data.pipeline?.hoursAgo ?? 'never'} hours ago)`);
    }
  } catch (err) {
    issues.push(`firmflow-outreach: unreachable — ${err.message}`);
  }

  // metric-product — connectivity only, both modes
  try {
    const r = await fetch('https://metric-product.onrender.com/health');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    if (data.db === 'error') issues.push(`metric-product: DB error — ${data.error}`);
  } catch (err) {
    issues.push(`metric-product: unreachable — ${err.message}`);
  }

  await log('info', `check-health (${mode}): ${issues.length === 0 ? 'all clear' : issues.length + ' issue(s) found'}`);

  if (issues.length > 0) {
    const label = mode === 'pre' ? 'PRE-RUN CHECK' : 'POST-RUN CHECK';
    const subject = `[${label}] ${issues.length} pipeline issue${issues.length > 1 ? 's' : ''} — action needed`;
    const body = [
      `Automated ${mode === 'pre' ? 'pre-run (7am)' : 'post-run (10am)'} health check found ${issues.length} issue${issues.length > 1 ? 's' : ''}:`,
      '',
      ...issues.map(i => `• ${i}`),
      '',
      `Checked at: ${new Date().toISOString()}`,
    ].join('\n');
    await sendEmail(process.env.REPORT_EMAIL, subject, body);
    await log('warn', `check-health alert sent (${mode}): ${issues.join(' | ')}`);
  }
}

// node-cron backup — 9am EST daily (external cron-job.org trigger is primary)
cron.schedule('0 9 * * *', async () => {
  await log('info', 'node-cron 9am trigger firing');
  await runPipeline();
}, { timezone: 'America/New_York' });

// Keepalive — ping self every 10 minutes to prevent Render free tier sleep
const SERVICE_URL = process.env.RENDER_EXTERNAL_URL || 'https://metric-outreach.onrender.com';
cron.schedule('*/10 * * * *', async () => {
  try {
    await fetch(`${SERVICE_URL}/`);
    console.log(`[${new Date().toISOString()}] keepalive ping ok`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] keepalive ping failed — ${err.message}`);
  }
});

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] metric-outreach running on port ${PORT}`);
});
