import 'dotenv/config';
import supabase from '../shared/db.js';
import { sendEmail } from '../shared/mailer.js';
import { log } from '../shared/logger.js';

function getYesterdayRange() {
  const now = new Date();
  const start = new Date(now);
  start.setDate(start.getDate() - 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return {
    date: start.toISOString().slice(0, 10),
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}

async function getBrevoOpens(date) {
  try {
    const res = await fetch(
      `https://api.brevo.com/v3/smtp/statistics/events?event=opened&startDate=${date}&endDate=${date}&limit=500`,
      { headers: { 'api-key': process.env.BREVO_API_KEY } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data.events || [];
  } catch {
    return null;
  }
}

export async function run() {
  await log('info', 'dailyReport starting');

  const { date, startISO, endISO } = getYesterdayRange();
  const today = new Date().toISOString().slice(0, 10);

  // Pipeline stats
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
    .in('status', ['link_sent', 'call_booked']);

  const { count: totalLeads } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true });

  const { count: inSequence } = await supabase
    .from('metric_leads')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'in_sequence');

  // Yesterday's emails sent by step (for open rate context)
  const { data: sentYesterday } = await supabase
    .from('metric_sequences')
    .select('step, lead_id')
    .eq('status', 'sent')
    .gte('sent_at', startISO)
    .lte('sent_at', endISO);

  const sentByStep = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const row of sentYesterday || []) sentByStep[row.step] = (sentByStep[row.step] || 0) + 1;
  const totalSentYesterday = (sentYesterday || []).length;

  // Brevo opens for yesterday
  const openEvents = await getBrevoOpens(date);
  let opensLine = '  Opens (yesterday): unavailable';

  if (openEvents !== null) {
    // Cross-reference opened emails against what we sent yesterday
    const openEmails = new Set(openEvents.map(e => e.email?.toLowerCase()).filter(Boolean));

    // Get lead emails for leads that had sequences sent yesterday
    const leadIds = [...new Set((sentYesterday || []).map(r => r.lead_id))];
    let opensByStep = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let totalOpens = 0;

    if (leadIds.length > 0) {
      const { data: leadEmails } = await supabase
        .from('metric_leads')
        .select('id, email')
        .in('id', leadIds);

      const leadEmailMap = {};
      for (const l of leadEmails || []) leadEmailMap[l.id] = l.email?.toLowerCase();

      for (const seq of sentYesterday || []) {
        const email = leadEmailMap[seq.lead_id];
        if (email && openEmails.has(email)) {
          opensByStep[seq.step] = (opensByStep[seq.step] || 0) + 1;
          totalOpens++;
        }
      }
    }

    const openRate = totalSentYesterday > 0
      ? Math.round((totalOpens / totalSentYesterday) * 100)
      : 0;

    const stepBreakdown = [1, 2, 3, 4]
      .filter(s => sentByStep[s] > 0)
      .map(s => `Step ${s}: ${opensByStep[s]}/${sentByStep[s]}`)
      .join(', ');

    opensLine = `  Opens (yesterday): ${totalOpens}/${totalSentYesterday} (${openRate}%)${stepBreakdown ? `\n  By step:           ${stepBreakdown}` : ''}`;
  }

  const body = `Metric Outreach — Daily Report (${today})

TODAY
  Leads sourced:   ${leadsToday ?? 0}
  Emails sent:     ${emailsToday ?? 0}

YESTERDAY'S PERFORMANCE
${opensLine}

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
