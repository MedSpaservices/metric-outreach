import 'dotenv/config';
import supabase from '../shared/db.js';
import { sendEmail } from '../shared/mailer.js';
import { log, updateHealth, getEmailsSentToday, incrementEmailsSent } from '../shared/logger.js';

const DAILY_CAP = 150;
const STEP_DELAY_DAYS = 3;

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
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
    .select('id, email, sequence_step, last_contacted')
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
    if (nextStep > 4) continue;

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
    } catch (err) {
      await log('error', `Send failed for lead ${lead.id}`, { error: err.message });
      await supabase.from('metric_sequences').update({ status: 'failed' }).eq('id', seq.id);
    }
  }

  await incrementEmailsSent(sent);
  await updateHealth('sequenceSender');
  await log('info', `sequenceSender complete. Sent: ${sent}/${DAILY_CAP} today`);
}
