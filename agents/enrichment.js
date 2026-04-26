import 'dotenv/config';
import { parse } from 'node-html-parser';
import supabase from '../shared/db.js';
import { callHaiku } from '../shared/claude.js';
import { log, updateHealth } from '../shared/logger.js';

const SYSTEM_PROMPT = `You are a B2B lead scoring assistant. Score home service businesses on their likelihood to pay $97/mo for an automated missed call text-back system.

Score higher (7-10) for: solo-owned or small team, owner likely taking calls themselves, established business with steady inbound (reviews suggest they're busy), dated or minimal website, no obvious marketing agency managing their presence.
Score lower (1-5) for: franchise/chain, large staff (calls likely handled by a receptionist), brand new business with few reviews, polished professional marketing presence suggesting they already have systems in place.

Return ONLY valid JSON: {"score": <number 1-10>, "reason": "<one sentence>"}`;

const FILE_EXTS = /\.(webp|png|jpg|jpeg|gif|svg|ico|pdf|zip|mp4|mp3|woff|woff2|ttf|eot)$/i;
const JUNK_PREFIXES = /^(noreply|no-reply|donotreply|do-not-reply|bounce|mailer-daemon|postmaster|unsubscribe|abuse|spam|webmaster|admin|administrator|root|hostmaster|info|contact|support|help|hello|hi|hey|team|office|mail|email|feedback|enquiry|enquiries|query|queries|sales|marketing|billing|accounts|hr|careers|jobs|press|media|legal|privacy|security|service|services|general|reception|front|desk)@/i;
const JUNK_DOMAINS = /\.(png|jpg|gif|webp|svg|example\.com|sentry\.io|wix\.com|squarespace\.com|shopify\.com|wordpress\.com)$/i;

function isUsableEmail(e) {
  if (!e || FILE_EXTS.test(e)) return false;
  if (JUNK_PREFIXES.test(e)) return false;
  if (JUNK_DOMAINS.test(e.split('@')[1] || '')) return false;
  return true;
}

async function fetchWebsiteData(url) {
  if (!url) return { text: null, email: null };
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    clearTimeout(timeout);
    const raw = await res.text();

    const emailMatches = raw.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    const validEmail = emailMatches.find(e => isUsableEmail(e));
    const email = validEmail ? validEmail.toLowerCase() : null;

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
    .eq('status', 'new');

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

    const noWebsite = !websiteSnippet;
    const status = noWebsite
      ? 'qualified'
      : (score !== null ? (score >= 5 ? 'qualified' : 'disqualified') : 'disqualified');

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
  return { processed, qualified };
}
