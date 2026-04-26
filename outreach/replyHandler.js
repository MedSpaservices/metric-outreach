import 'dotenv/config';
import supabase from '../shared/db.js';
import { callHaiku } from '../shared/claude.js';
import { sendEmail } from '../shared/mailer.js';
import { log, updateHealth } from '../shared/logger.js';

const CALENDLY = 'https://calendly.com/metriccall';
const LINK_SENT_FOLLOWUP_DAYS = 5;

const SYSTEM_PROMPT = `You are a B2B outreach assistant for Metric, an automated follow-up system for home service businesses. Metric installs a missed call text-back system — when a business misses a call on the job, the caller gets an automatic text within 60 seconds, is qualified by AI, and sent a booking link. Founding client rate is $97/mo, locked permanently. Classify email replies and draft follow-up messages. Always write in first person plural (we/our).

Classify as:
- "positive" — they're interested, want more info, or asked a question suggesting openness
- "negative" — they said no, unsubscribe, stop emailing, or are clearly not interested
- "neutral" — out-of-office, ambiguous, or just a clarifying question

If positive, draft a short reply (under 60 words, conversational, we/our) that acknowledges their interest and invites them to book a 15-minute call: ${CALENDLY}

Return ONLY valid JSON: {"classification": "positive|negative|neutral", "draft_reply": "<text or null>"}`;

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

export async function run() {
  await log('info', 'replyHandler starting');

  // --- Nudge leads who got the Calendly link but haven't booked in 5+ days ---
  const { data: stale } = await supabase
    .from('metric_leads')
    .select('id, email, business')
    .eq('status', 'link_sent')
    .lt('last_contacted', daysAgo(LINK_SENT_FOLLOWUP_DAYS));

  for (const lead of stale || []) {
    if (!lead.email) {
      await supabase.from('metric_leads').update({ status: 'abandoned' }).eq('id', lead.id);
      continue;
    }
    try {
      await sendEmail(
        lead.email,
        'still interested in the Metric call?',
        `Hey — you reached out a few days ago about missed calls at ${lead.business}.\n\nIf you're still curious, here's the link to grab 15 minutes with us: ${CALENDLY}\n\nNo pressure either way — just didn't want to leave you hanging.`
      );
      await supabase.from('metric_leads').update({ status: 'abandoned', last_contacted: new Date().toISOString() }).eq('id', lead.id);
      await log('info', `Nudge sent to stale link_sent lead ${lead.id} — moved to abandoned`);
    } catch (err) {
      await log('error', `Nudge send failed for lead ${lead.id}`, { error: err.message });
    }
  }

  // --- Classify new replies ---
  const { data: leads, error } = await supabase
    .from('metric_leads')
    .select('id, email, business, reply_text, sequence_step')
    .eq('status', 'replied');

  if (error) {
    await log('error', 'Failed to fetch leads', { error: error.message });
    return;
  }

  let booked = 0;

  for (const lead of leads || []) {
    if (!lead.reply_text || !lead.email) continue;

    let classification, draftReply;
    try {
      const raw = await callHaiku(SYSTEM_PROMPT, `Email reply from ${lead.business}:\n\n${lead.reply_text}`);
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON in response');
      const parsed = JSON.parse(match[0]);
      classification = parsed.classification;
      draftReply = parsed.draft_reply;
    } catch (err) {
      await log('error', `Classification failed for lead ${lead.id}`, { error: err.message });
      continue;
    }

    await log('info', `Lead ${lead.id} classified as: ${classification}`);

    if (classification === 'negative') {
      await supabase.from('metric_leads').update({ status: 'disqualified' }).eq('id', lead.id);
      continue;
    }

    if (classification === 'positive' && draftReply) {
      const { data: seq } = await supabase
        .from('metric_sequences')
        .select('subject')
        .eq('lead_id', lead.id)
        .eq('step', 1)
        .single();

      try {
        await sendEmail(
          lead.email,
          `Re: ${seq?.subject || 'Our conversation'}`,
          draftReply
        );
        await supabase.from('metric_leads').update({
          status: 'link_sent',
          last_contacted: new Date().toISOString(),
        }).eq('id', lead.id);
        booked++;
        await log('info', `Calendly link sent to lead ${lead.id}`);
      } catch (err) {
        await log('error', `Reply send failed for lead ${lead.id}`, { error: err.message });
      }
    }
    // neutral: leave as 'replied', revisit next run
  }

  await updateHealth('replyHandler');
  await log('info', `replyHandler complete. Link sent: ${booked}`);
  return { booked };
}
