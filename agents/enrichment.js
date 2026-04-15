import 'dotenv/config';
import { parse } from 'node-html-parser';
import supabase from '../shared/db.js';
import { callHaiku } from '../shared/claude.js';
import { log, updateHealth } from '../shared/logger.js';

const SYSTEM_PROMPT = `You are a B2B lead scoring assistant. Score home service businesses on their likelihood to pay for a customer reactivation marketing campaign (25% revenue share, no upfront cost).

Score higher (7-10) for: solo-owned or small team, established business (5+ years implied by reviews), no obvious marketing agency, dated or minimal website, lots of reviews suggesting an existing customer base.
Score lower (1-5) for: franchise/chain, already has active marketing campaigns, large staff, polished professional marketing presence.

Return ONLY valid JSON: {"score": <number 1-10>, "reason": "<one sentence>"}`;

async function fetchWebsiteData(url) {
  if (!url) return { text: null, email: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    const raw = await res.text();

    // Extract email from raw HTML before parsing
    const emailMatch = raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    const email = emailMatch ? emailMatch[0].toLowerCase() : null;

    const root = parse(raw);
    root.querySelectorAll('script, style').forEach(el => el.remove());
    const text = root.structuredText.replace(/\s+/g, ' ').trim();
    return { text: text.slice(0, 800), email };
  } catch {
    return { text: null, email: null };
  }
}

export async function run() {
  await log('info', 'enrichment starting');

  const { data: leads, error } = await supabase
    .from('metric_leads')
    .select('id, website, email')
    .eq('status', 'new')
    .limit(20);

  if (error) {
    await log('error', 'Failed to fetch leads', { error: error.message });
    return;
  }

  let processed = 0;
  let qualified = 0;

  for (const lead of leads || []) {
    const { text: websiteSnippet, email: foundEmail } = await fetchWebsiteData(lead.website);

    let score = null;
    let scoreReason = null;

    try {
      const context = websiteSnippet || 'No website content available.';
      const raw = await callHaiku(SYSTEM_PROMPT, context);
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        const parsed = JSON.parse(match[0]);
        score = parsed.score;
        scoreReason = parsed.reason;
      }
    } catch (err) {
      await log('error', `Haiku scoring failed for lead ${lead.id}`, { error: err.message });
    }

    const status = score !== null
      ? (score >= 6 ? 'qualified' : 'disqualified')
      : 'new';

    const update = {
      score,
      score_reason: scoreReason,
      status,
      website_snippet: websiteSnippet,
      // only overwrite email if Apify didn't already find one
      ...(foundEmail && !lead.email && { email: foundEmail }),
    };

    const { error: updateErr } = await supabase.from('metric_leads').update(update).eq('id', lead.id);
    if (updateErr) {
      await log('warn', `Update failed, retrying for ${lead.id}`, { error: updateErr.message });
      await new Promise(r => setTimeout(r, 2000));
      await supabase.from('metric_leads').update(update).eq('id', lead.id);
    }

    processed++;
    if (status === 'qualified') qualified++;
  }

  await updateHealth('enrichment');
  await log('info', `enrichment complete. Processed: ${processed}, Qualified: ${qualified}`);
}
