import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import { log } from './shared/logger.js';
import supabase from './shared/db.js';

const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'metric-outreach', time: new Date().toISOString() });
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
