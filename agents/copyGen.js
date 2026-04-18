import 'dotenv/config';
import supabase from '../shared/db.js';
import { callSonnet } from '../shared/claude.js';
import { log, updateHealth } from '../shared/logger.js';

const SYSTEM_PROMPT = `You are an expert cold email copywriter. Write short, direct, conversational emails on behalf of Metric — an automated follow-up system for home service businesses. Always write in first person plural (we/our). Never use buzzwords like "synergy", "cutting-edge", or "game-changer". Write like a real person, not a marketer.

Metric's pitch: We install a missed call text-back system for home service businesses. The moment they miss a call on the job, the caller gets an automatic text within 60 seconds. Our system qualifies the lead and sends them a booking link. The business owner finishes the job they're on — the next one is already on their calendar. We're onboarding 3 founding clients at $97/mo, locked permanently. Standard pricing moves to $297/mo after those spots are filled. No contracts, cancel anytime.`;

function buildUserPrompt(lead) {
  const context = lead.website_snippet
    ? `Their website says: "${lead.website_snippet.slice(0, 400)}"`
    : 'No website content available.';

  return `Write a 4-email cold outreach sequence for a home service business owner in ${lead.city}.

Business: ${lead.business}
Context: ${context}

Rules:
- Email 1: Under 80 words. Subject line hooks on missed calls or lost jobs. Open with the core pain — they miss calls when they're on jobs and those leads book someone else. Introduce the fix: we text the missed caller within 60 seconds, qualify them, and get them booked on their calendar automatically. They finish the job they're on — the next one is already scheduled. End with a soft question ("Worth a quick 15-minute call to see if it fits?") — no Calendly link yet. Include: trymetric.co
- Email 2: 3 days later. Under 60 words. Don't repeat the full pitch. Add one concrete insight — the average home service business misses 30-40% of inbound calls. Each one is a job that went to a competitor. Mention the founding client offer: $97/mo locked permanently, 3 spots only. End with a soft CTA. Include: trymetric.co
- Email 3: 6 days later. Under 50 words. Create mild urgency — founding client spots are filling. After these 3 spots the price moves to $297/mo. Ask if they want to lock in before we move on. Include: trymetric.co
- Email 4: 10 days later. Under 40 words. Friendly breakup. Leave the door open. Drop the Calendly link: calendly.com/metriccall. No hard sell.

Return ONLY a valid JSON array, no markdown:
[{"subject": "...", "body": "..."}, {"subject": "...", "body": "..."}, {"subject": "...", "body": "..."}, {"subject": "...", "body": "..."}]`;
}

export async function run() {
  await log('info', 'copyGen starting');

  const { data: leads, error } = await supabase
    .from('metric_leads')
    .select('id, business, city, website_snippet')
    .eq('status', 'qualified');

  if (error) {
    await log('error', 'Failed to fetch leads', { error: error.message });
    return;
  }

  let processed = 0;

  for (const lead of leads || []) {
    let emails;
    try {
      const raw = await callSonnet(SYSTEM_PROMPT, buildUserPrompt(lead));
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array in response');
      emails = JSON.parse(match[0]);
      if (!Array.isArray(emails) || emails.length !== 4) throw new Error('Expected 4 emails');
    } catch (err) {
      await log('error', `Copy gen failed for lead ${lead.id}`, { error: err.message });
      continue;
    }

    const rows = emails.map((email, i) => ({
      lead_id: lead.id,
      step: i + 1,
      subject: email.subject,
      body: email.body,
      status: 'pending',
    }));

    const { error: insertErr } = await supabase.from('metric_sequences').insert(rows);
    if (insertErr) {
      await log('warn', `Sequence insert failed, retrying for lead ${lead.id}`, { error: insertErr.message });
      await new Promise(r => setTimeout(r, 2000));
      await supabase.from('metric_sequences').insert(rows);
    }

    await supabase.from('metric_leads').update({ status: 'copy_ready' }).eq('id', lead.id);
    processed++;
  }

  await updateHealth('copyGen');
  await log('info', `copyGen complete. Processed: ${processed} leads`);
  return { generated: processed };
}
