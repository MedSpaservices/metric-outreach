import 'dotenv/config';
import supabase from '../shared/db.js';
import { callHaiku } from '../shared/claude.js';
import { log, updateHealth } from '../shared/logger.js';

const SYSTEM_PROMPT = `You are an expert cold email copywriter. Write short, direct, conversational emails on behalf of Metric — an automated follow-up system for home service businesses. Always write in first person plural (we/our). Never use buzzwords like "synergy", "cutting-edge", or "game-changer". Write like a real person, not a marketer.

Metric's pitch: We install a missed call text-back system for home service businesses. The moment they miss a call on the job, the caller gets an automatic text within 60 seconds. Our system qualifies the lead and sends them a booking link. The business owner finishes the job they're on — the next one is already on their calendar. We're onboarding 3 founding clients at $97/mo, locked permanently. Standard pricing moves to $297/mo after those spots are filled. No contracts, cancel anytime.`;

const STEP_RULES = {
  1: `Under 80 words. Subject line hooks on missed calls or lost jobs. Open with the core pain — they miss calls when they're on jobs and those leads book someone else. Introduce the fix: we text the missed caller within 60 seconds, qualify them, and get them booked on their calendar automatically. They finish the job they're on — the next one is already scheduled. End with a soft question ("Worth a quick 15-minute call to see if it fits?") — no Calendly link yet. Include: trymetric.co`,
  2: `Under 60 words. Don't repeat the full pitch. Add one concrete insight — the average home service business misses 30-40% of inbound calls. Each one is a job that went to a competitor. Mention the founding client offer: $97/mo locked permanently, 3 spots only. End with a soft CTA. Include: trymetric.co`,
  3: `Under 50 words. Create mild urgency — founding client spots are filling. After these 3 spots the price moves to $297/mo. Ask if they want to lock in before we move on. Include: trymetric.co`,
  4: `Under 40 words. Friendly breakup. Leave the door open. Drop the Calendly link: calendly.com/metriccall. No hard sell.`,
};

function buildSingleStepPrompt(lead, step) {
  const context = lead.website_snippet
    ? `Their website says: "${lead.website_snippet.slice(0, 400)}"`
    : 'No website content available.';

  return `Write email ${step} of a cold outreach sequence for a home service business owner in ${lead.city}.

Business: ${lead.business}
Context: ${context}

Rules for this email:
- ${STEP_RULES[step]}

Return ONLY a valid JSON object, no markdown:
{"subject": "...", "body": "..."}`;
}

export async function generateStep(lead, step) {
  const raw = await callHaiku(SYSTEM_PROMPT, buildSingleStepPrompt(lead, step));
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in response');
  const parsed = JSON.parse(match[0]);
  if (!parsed.subject || !parsed.body) throw new Error('Missing subject or body');
  return parsed;
}

export async function run() {
  await log('info', 'copyGen starting');

  const { data: leads, error } = await supabase
    .from('metric_leads')
    .select('id, business, city, website_snippet')
    .eq('status', 'qualified')
    .not('email', 'is', null);

  if (error) {
    await log('error', 'Failed to fetch leads', { error: error.message });
    return;
  }

  let processed = 0;

  for (const lead of leads || []) {
    let email;
    try {
      email = await generateStep(lead, 1);
    } catch (err) {
      await log('error', `Copy gen failed for lead ${lead.id}`, { error: err.message });
      continue;
    }

    const { error: insertErr } = await supabase.from('metric_sequences').insert({
      lead_id: lead.id,
      step: 1,
      subject: email.subject,
      body: email.body,
      status: 'pending',
    });

    if (insertErr) {
      await log('warn', `Sequence insert failed for lead ${lead.id}`, { error: insertErr.message });
      continue;
    }

    await supabase.from('metric_leads').update({ status: 'copy_ready' }).eq('id', lead.id);
    processed++;
  }

  await updateHealth('copyGen');
  await log('info', `copyGen complete. Processed: ${processed} leads`);
  return { generated: processed };
}
