import 'dotenv/config';
import supabase from '../shared/db.js';
import { sendEmail } from '../shared/mailer.js';
import { log } from '../shared/logger.js';

export async function run() {
  await log('info', 'dailyReport starting');

  const today = new Date().toISOString().slice(0, 10);

  const { count: leadsToday } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true })
    .gte('created_at', `${today}T00:00:00.000Z`);

  const { count: emailsToday } = await supabase
    .from('metric_sequences')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'sent')
    .gte('sent_at', `${today}T00:00:00.000Z`);

  const { count: replies } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'replied');

  const { count: booked } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'call_booked');

  const { count: totalLeads } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true });

  const { count: inSequence } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'in_sequence');

  const body = `Metric Outreach — Daily Report (${today})

TODAY
  Leads sourced:   ${leadsToday ?? 0}
  Emails sent:     ${emailsToday ?? 0}

ALL TIME
  Total leads:     ${totalLeads ?? 0}
  In sequence:     ${inSequence ?? 0}
  Replies:         ${replies ?? 0}
  Calls booked:    ${booked ?? 0}
`;

  await sendEmail(
    process.env.REPORT_EMAIL,
    `Metric Outreach — Daily Report ${today}`,
    body
  );

  await log('info', 'dailyReport sent');
}
