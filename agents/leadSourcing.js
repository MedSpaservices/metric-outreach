import 'dotenv/config';
import supabase from '../shared/db.js';
import { log, updateHealth } from '../shared/logger.js';

const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
const ACTOR_ID = 'WnMxbsRLNbPeYL6ge'; // Google Maps Email Extractor
const BASE = 'https://api.apify.com/v2';

// 5 target cities — EST timezone, large home service market, low agency competition
const CITIES = [
  'Philadelphia, PA',
  'Charlotte, NC',
  'Columbus, OH',
  'Tampa, FL',
  'Nashville, TN',
  'Indianapolis, IN',
  'Louisville, KY',
  'Memphis, TN',
  'Raleigh, NC',
  'Baltimore, MD',
];

// Rotate service type by day of week to maximize variety
const SERVICES = ['plumbers', 'HVAC contractors', 'electricians', 'landscapers', 'handyman services'];

function getTodayService() {
  const day = new Date().getDay(); // 0=Sun, 1=Mon, ...
  return SERVICES[day % SERVICES.length];
}

function fetchWithTimeout(url, options = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function startScrape(city, service) {
  const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(`${service} in ${city}`)}`;

  const res = await fetchWithTimeout(`${BASE}/acts/${ACTOR_ID}/runs?token=${APIFY_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      startUrls: [{ url: searchUrl, method: 'GET' }],
      maxCrawledPlacesPerSearch: 20,
      scrapeContacts: true,
      skipClosedPlaces: true,
      website: 'withWebsite',
      language: 'en',
      includeWebResults: false,
    }),
  });

  if (!res.ok) throw new Error(`Apify start failed (${res.status}): ${await res.text()}`);
  const json = await res.json();
  return { runId: json.data.id, datasetId: json.data.defaultDatasetId };
}

async function pollUntilDone(runId, timeoutMs = 300000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 10000));
    const res = await fetchWithTimeout(`${BASE}/actor-runs/${runId}?token=${APIFY_TOKEN}`);
    if (!res.ok) throw new Error(`Apify status check failed (${res.status})`);
    const json = await res.json();
    const status = json.data.status;
    if (status === 'SUCCEEDED') return;
    if (['FAILED', 'ABORTED', 'TIMED-OUT'].includes(status)) throw new Error(`Apify run ${status}`);
  }
  throw new Error('Apify run timed out after 5 minutes');
}

const VALID_EMAIL = /^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;
const FILE_EXTS = /\.(webp|png|jpg|jpeg|gif|svg|ico|pdf|zip|mp4|mp3|woff|woff2|ttf|eot)$/i;

function isValidEmail(str) {
  if (!str || typeof str !== 'string') return false;
  if (!VALID_EMAIL.test(str)) return false;
  if (FILE_EXTS.test(str)) return false;
  if (str.includes('google.com') || str.includes('maps/')) return false;
  return true;
}

function extractEmail(item) {
  const candidates = [];
  const emailsObj = item.emails;
  if (Array.isArray(emailsObj) && emailsObj.length > 0) {
    if (typeof emailsObj[0] === 'object') candidates.push(emailsObj[0].email ?? null);
    if (typeof emailsObj[0] === 'string') candidates.push(emailsObj[0]);
  }
  if (typeof item.email === 'string') candidates.push(item.email);
  const personal = item.personalEmails;
  if (Array.isArray(personal) && personal.length > 0) candidates.push(personal[0]);
  const company = item.companyEmails;
  if (Array.isArray(company) && company.length > 0) candidates.push(company[0]);

  return candidates.find(isValidEmail) ?? null;
}

async function fetchResults(datasetId) {
  const res = await fetchWithTimeout(`${BASE}/datasets/${datasetId}/items?token=${APIFY_TOKEN}&clean=true`);
  if (!res.ok) throw new Error(`Apify dataset fetch failed (${res.status})`);
  return res.json();
}

async function scrapeCity(city, service) {
  const { runId, datasetId } = await startScrape(city, service);
  await pollUntilDone(runId);
  const items = await fetchResults(datasetId);
  return items;
}

export async function run() {
  await log('info', 'leadSourcing starting');
  const service = getTodayService();
  await log('info', `Today's service: ${service}`);

  let inserted = 0;

  for (const city of CITIES) {
    await log('info', `Scraping: ${service} in ${city}`);

    let items;
    try {
      items = await Promise.race([
        scrapeCity(city, service),
        new Promise((_, reject) => setTimeout(() => reject(new Error('City timeout after 6 minutes')), 6 * 60 * 1000)),
      ]);
    } catch (err) {
      await log('error', `Skipping ${city}`, { error: err.message });
      continue;
    }

    for (const item of items) {
      const lead = {
        business: item.title || item.name || null,
        phone: item.phone || null,
        email: extractEmail(item),
        website: item.website || null,
        city,
        source: 'apify',
        status: 'new',
      };

      if (!lead.business) continue;

      const { error } = await supabase
        .from('metric_leads')
        .upsert(lead, { onConflict: 'business,city', ignoreDuplicates: true });

      if (!error) inserted++;
    }

    await log('info', `${city} done. Running total inserted: ${inserted}`);
  }

  await updateHealth('leadSourcing');
  await log('info', `leadSourcing complete. Inserted: ${inserted}`);
  return { inserted };
}
