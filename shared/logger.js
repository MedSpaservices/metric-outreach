import supabase from './db.js';

export async function log(level, message, data = {}) {
  const entry = { level, message, data, timestamp: new Date().toISOString() };
  console.log(JSON.stringify(entry));
}

export async function updateHealth(agentName, extraFields = {}) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase
    .from('metric_system_health')
    .upsert(
      { agent_name: agentName, last_run: new Date().toISOString(), last_run_date: today, status: 'ok', ...extraFields },
      { onConflict: 'agent_name' }
    );
}

export async function getEmailsSentToday() {
  const today = new Date().toISOString().slice(0, 10);
  const { data } = await supabase
    .from('metric_system_health')
    .select('emails_sent_today, last_run_date')
    .eq('agent_name', 'sequenceSender')
    .single();

  if (!data || data.last_run_date !== today) return 0;
  return data.emails_sent_today || 0;
}

export async function incrementEmailsSent(count) {
  const today = new Date().toISOString().slice(0, 10);

  const { data } = await supabase
    .from('metric_system_health')
    .select('emails_sent_today, last_run_date')
    .eq('agent_name', 'sequenceSender')
    .single();

  const currentCount = data?.last_run_date === today ? (data?.emails_sent_today || 0) : 0;

  await supabase
    .from('metric_system_health')
    .upsert(
      { agent_name: 'sequenceSender', emails_sent_today: currentCount + count, last_run_date: today },
      { onConflict: 'agent_name' }
    );
}
