import 'dotenv/config';
import supabase from '../shared/db.js';
import { callHaiku } from '../shared/claude.js';
import { sendEmail } from '../shared/mailer.js';
import { log, updateHealth } from '../shared/logger.js';

const CALENDLY = 'https://calendly.com/metriccall';

const SYSTEM_PROMPT = `You are a B2B outreach assistant for Metric, a performance-based marketing consultancy. Classify email replies and draft follow-up messages. Always write in first person plural (we/our).

Classify as:
- "positive" — they're interested, want more info, or asked a question suggesting openness
- "negative" — they said no, unsubscribe, stop emailing, or are clearly not interested
- "neutral" — out-of-office, ambiguous, or just a clarifying question

If positive, draft a short reply (under 60 words, conversational, we/our) that acknowledges their interest and invites them to book a 15-minute call: ${CALENDLY}

Return ONLY valid JSON: {"classification": "positive|negative|neutral", "draft_reply": "<text or null>"}`;

export async function run() {
  await log('info', 'replyHandler starting');

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
        await supabase.from('metric_leads').update({ status: 'call_booked' }).eq('id', lead.id);
        booked++;
        await log('info', `Calendly link sent to lead ${lead.id}`);
      } catch (err) {
        await log('error', `Reply send failed for lead ${lead.id}`, { error: err.message });
      }
    }
    // neutral: leave as 'replied', revisit next run
  }

  await updateHealth('replyHandler');
  await log('info', `replyHandler complete. Booked: ${booked}`);
}
