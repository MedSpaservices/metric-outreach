// Manual agent runner: node run.js --agent=leadSourcing
import 'dotenv/config';
import { sendEmail } from './shared/mailer.js';

const AGENTS = {
  leadSourcing: './agents/leadSourcing.js',
  enrichment: './agents/enrichment.js',
  copyGen: './agents/copyGen.js',
  sequenceSender: './outreach/sequenceSender.js',
  replyHandler: './outreach/replyHandler.js',
};

const arg = process.argv.find(a => a.startsWith('--agent='));
const agentName = arg?.split('=')[1];

if (!agentName || !AGENTS[agentName]) {
  console.error(`Usage: node run.js --agent=<name>`);
  console.error(`Available: ${Object.keys(AGENTS).join(', ')}`);
  process.exit(1);
}

try {
  console.log(`[${new Date().toISOString()}] Running: ${agentName}`);
  const mod = await import(AGENTS[agentName]);
  await mod.run();
  console.log(`[${new Date().toISOString()}] Done: ${agentName}`);
} catch (err) {
  console.error(`[${new Date().toISOString()}] Failed: ${agentName} — ${err.message}\n${err.stack}`);
  try {
    await sendEmail(
      process.env.REPORT_EMAIL,
      `[Metric Outreach] Agent failed: ${agentName}`,
      `Error: ${err.message}\n\nStack:\n${err.stack}`
    );
  } catch {}
  process.exit(1);
}
