import 'dotenv/config';
import supabase from '../shared/db.js';
import { callSonnet } from '../shared/claude.js';
import { log, updateHealth } from '../shared/logger.js';

const SYSTEM_PROMPT = `You are an expert cold email copywriter. Write short, direct, conversational emails on behalf of Metric — a performance-based marketing consultancy. Always write in first person plural (we/our). Never use buzzwords like "synergy", "cutting-edge", or "game-changer". Write like a real person, not a marketer.

Metric's pitch: We run reactivation campaigns for home service businesses — we reach back out to their old customers who haven't booked in 6-12 months and get them to re-book. No upfront cost — we only get paid 25% of the revenue from jobs we help rebook. Zero risk to the business owner.`;

function buildUserPrompt(lead) {
  const context = lead.website_snippet
    ? `Their website says: "${lead.website_snippet.slice(0, 400)}"`
    : 'No website content available.';

  return `Write a 4-email cold outreach sequence for a home service business owner in ${lead.city}.

Business: ${lead.business}
Context: ${context}

Rules:
- Email 1: Under 80 words. Open with one specific, natural observation about their business (from context, or generic if no context). Pitch reactivation: we contact their old customers who haven't booked in 6-12 months and get them rebooked — we only take 25% of revenue from jobs we help close, nothing upfront. End with a soft question ("Does that sound like something worth a quick chat about?") — no Calendly link yet.
- Email 2: 3 days later. Under 60 words. Don't repeat the pitch. Add one concrete insight (e.g. most home service businesses have 40-60% of their customer base go dormant each year — that's untapped revenue sitting idle). End with a different soft CTA.
- Email 3: 6 days later. Under 50 words. Create mild urgency — we only work with one business per service category per city. Ask if they want to lock in their spot before we move on.
- Email 4: 10 days later. Under 40 words. Friendly breakup. Leave door open. No hard sell.

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
}
