import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { log } from './shared/logger.js';
import { sendEmail } from './shared/mailer.js';

const base = path.dirname(fileURLToPath(import.meta.url));

const AGENTS = [
  { name: 'leadSourcing',   file: `${base}/agents/leadSourcing.js` },
  { name: 'enrichment',     file: `${base}/agents/enrichment.js` },
  { name: 'copyGen',        file: `${base}/agents/copyGen.js` },
  { name: 'sequenceSender', file: `${base}/outreach/sequenceSender.js` },
  { name: 'replyHandler',   file: `${base}/outreach/replyHandler.js` },
  { name: 'dailyReport',    file: `${base}/outreach/dailyReport.js` },
];

async function runAgent(agent) {
  const mod = await import(agent.file);
  return await mod.run();
}

async function runWithRetry(agent) {
  try {
    const result = await runAgent(agent);
    return { ok: true, result: result || {} };
  } catch (err) {
    await log('warn', `${agent.name} failed, retrying in 30s`, { error: err.message });
    await new Promise(r => setTimeout(r, 30000));
    try {
      const result = await runAgent(agent);
      return { ok: true, result: result || {}, retried: true };
    } catch (err2) {
      await log('error', `${agent.name} failed after retry`, { error: err2.message });
      return { ok: false, error: err2.message };
    }
  }
}

export async function run() {
  await log('info', 'orchestrator starting');
  const summary = {};

  for (const agent of AGENTS) {
    await log('info', `orchestrator → ${agent.name}`);
    const { ok, result, error, retried } = await runWithRetry(agent);
    summary[agent.name] = ok ? { ...result, ...(retried ? { retried: true } : {}) } : { error };
  }

  // Hot reply alert — send immediately if any positive replies were booked
  const booked = summary.replyHandler?.booked ?? 0;
  if (booked > 0) {
    try {
      await sendEmail(
        process.env.REPORT_EMAIL,
        `[Metric] ${booked} interested lead${booked > 1 ? 's' : ''} — reply now`,
        `${booked} lead${booked > 1 ? 's' : ''} responded positively and received your Calendly link.\n\nCheck your inbox and follow up fast.`
      );
      await log('info', `Hot reply alert sent for ${booked} lead(s)`);
    } catch (err) {
      await log('error', 'Hot reply alert failed', { error: err.message });
    }
  }

  // Pipeline summary log
  const lines = Object.entries(summary).map(([name, data]) => {
    if (data.error) return `  ${name}: FAILED — ${data.error}`;
    const parts = Object.entries(data)
      .filter(([k]) => k !== 'retried')
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ');
    return `  ${name}: ${parts || 'ok'}${data.retried ? ' (retried)' : ''}`;
  });

  await log('info', `orchestrator complete\n${lines.join('\n')}`);
}
