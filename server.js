import 'dotenv/config';
import express from 'express';
import cron from 'node-cron';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './shared/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3002;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ ok: true, service: 'metric-outreach', time: new Date().toISOString() });
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
  const base = path.dirname(fileURLToPath(import.meta.url));
  const pipeline = [
    { name: 'leadSourcing', file: `${base}/agents/leadSourcing.js` },
    { name: 'enrichment', file: `${base}/agents/enrichment.js` },
    { name: 'copyGen', file: `${base}/agents/copyGen.js` },
    { name: 'sequenceSender', file: `${base}/outreach/sequenceSender.js` },
    { name: 'replyHandler', file: `${base}/outreach/replyHandler.js` },
    { name: 'dailyReport', file: `${base}/outreach/dailyReport.js` },
  ];

  console.log(`[${new Date().toISOString()}] Pipeline starting`);
  for (const agent of pipeline) {
    try {
      console.log(`[${new Date().toISOString()}] Starting: ${agent.name}`);
      const mod = await import(agent.file);
      await mod.run();
      console.log(`[${new Date().toISOString()}] Done: ${agent.name}`);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Failed: ${agent.name} — ${err.message}\n${err.stack}`);
      // Send error alert email
      try {
        const { sendEmail } = await import('./shared/mailer.js');
        await sendEmail(
          process.env.REPORT_EMAIL,
          `[Metric Outreach] Agent failed: ${agent.name}`,
          `Error: ${err.message}\n\nStack:\n${err.stack}`
        );
      } catch {}
    }
  }
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
      const base = path.dirname(fileURLToPath(import.meta.url));
      const { run } = await import(`${base}/outreach/dailyReport.js`);
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
      const base = path.dirname(fileURLToPath(import.meta.url));
      const { run } = await import(`${base}/outreach/weeklyReport.js`);
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

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] metric-outreach running on port ${PORT}`);
});
