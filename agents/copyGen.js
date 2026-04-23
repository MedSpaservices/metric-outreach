import 'dotenv/config';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import supabase from '../shared/db.js';
import { log, updateHealth } from '../shared/logger.js';

const base = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = JSON.parse(readFileSync(path.join(base, '../templates/sequence.json'), 'utf8'));

export function generateStep(lead, step) {
  const template = TEMPLATES.steps.find(s => s.step === step);
  if (!template) throw new Error(`No template found for step ${step}`);

  const subject = template.subject
    .replace(/\{\{business\}\}/g, lead.business)
    .replace(/\{\{city\}\}/g, lead.city);

  const body = template.body
    .replace(/\{\{business\}\}/g, lead.business)
    .replace(/\{\{city\}\}/g, lead.city);

  return { subject, body };
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
