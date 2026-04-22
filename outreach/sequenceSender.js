import 'dotenv/config';
import supabase from '../shared/db.js';
import { sendEmail } from '../shared/mailer.js';
import { log, updateHealth, getEmailsSentToday, incrementEmailsSent } from '../shared/logger.js';
import { generateStep } from '../agents/copyGen.js';

const DAILY_CAP = 150;
const STEP_DELAY_DAYS = 3;
const MAX_STEPS = 4;

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

async function queueNextStep(lead, sentStep) {
  const nextStep = sentStep + 1;
  if (nextStep > MAX_STEPS) return;

  try {
    const email = await generateStep(lead, nextStep);
    await supabase.from('metric_sequences').insert({
      lead_id: lead.id,
      step: nextStep,
      subject: email.subject,
      body: email.body,
      status: 'pending',
    });
    await log('info', `Queued step ${nextStep} for lead ${lead.id}`);
  } catch (err) {
    await log('error', `Failed to queue step ${nextStep} for lead ${lead.id}`, { error: err.message });
  }
}

export async function run() {
  await log('info', 'sequenceSender starting');

  const sentToday = await getEmailsSentToday();
  if (sentToday >= DAILY_CAP) {
    await log('info', `Daily cap reached (${sentToday}/${DAILY_CAP}). Skipping.`);
    return;
  }

  const remaining = DAILY_CAP - sentToday;

  const { data: leads, error } = await supabase
    .from('metric_leads')
    .select('id, email, business, city, website_snippet, sequence_step, last_contacted')
    .in('status', ['copy_ready', 'in_sequence'])
    .not('email', 'is', null)
    .or(`last_contacted.is.null,last_contacted.lt.${daysAgo(STEP_DELAY_DAYS)}`)
    .limit(remaining);

  if (error) {
    await log('error', 'Failed to fetch leads', { error: error.message });
    return;
  }

  let sent = 0;

  for (const lead of leads || []) {
    if (sent >= remaining) break;

    const nextStep = (lead.sequence_step || 0) + 1;
    if (nextStep > MAX_STEPS) continue;

    const { data: seq } = await supabase
      .from('metric_sequences')
      .select('id, subject, body')
      .eq('lead_id', lead.id)
      .eq('step', nextStep)
      .eq('status', 'pending')
      .single();

    if (!seq) continue;

    try {
      await sendEmail(lead.email, seq.subject, seq.body);

      await supabase
        .from('metric_sequences')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', seq.id);

      await supabase
        .from('metric_leads')
        .update({
          status: 'in_sequence',
          sequence_step: nextStep,
          last_contacted: new Date().toISOString(),
        })
        .eq('id', lead.id);

      sent++;
      await log('info', `Sent step ${nextStep} to lead ${lead.id}`);

      // Generate next step's copy now so it's ready when the delay expires
      await queueNextStep(lead, nextStep);
    } catch (err) {
      await log('error', `Send failed for lead ${lead.id}`, { error: err.message });
      await supabase.from('metric_sequences').update({ status: 'failed' }).eq('id', seq.id);
    }
  }

  await incrementEmailsSent(sent);
  await updateHealth('sequenceSender');
  await log('info', `sequenceSender complete. Sent: ${sent}/${DAILY_CAP} today`);
  return { sent };
}
