// Smoke test for a LIVE deployed Dugri instance.
//
// Runs against a real base URL (a staging or production deploy) and exercises
// the paths that break most visibly: the static pages load, the core word-
// collection API round-trips, and the public view exposes the payment flag.
// It performs NO real charge — it only asserts card_enabled is a boolean so a
// misconfigured payment flag is caught.
//
// Node 20+, ES module, zero dependencies (global fetch only). Import
// `runSmoke(baseUrl)` directly (it throws on the first failure) or run it as a
// CLI: `node scripts/smoke.mjs https://staging.example.com` (or set
// SMOKE_BASE_URL). Importing has no side effects.

import { pathToFileURL } from 'node:url';

// Static pages that must return 200 and contain a known marker substring. Each
// marker was copied from the real file in site/ (a title or on-page heading).
const PAGES = [
  { path: '/', marker: 'המשחק שמפוצץ את החדר' },
  { path: '/collect.html', marker: 'אוספים מילים' },
  { path: '/options.html', marker: 'בונים את המשחק' },
  { path: '/admin.html', marker: 'ניהול הזמנות' },
  { path: '/pay-done.html', marker: 'מעבדים את התשלום' },
  { path: '/timer.html', marker: 'טיימר' },
];

function fail(check, url, detail) {
  throw new Error(`SMOKE FAILED [${check}] ${url}${detail ? ' — ' + detail : ''}`);
}

// Trim a single trailing slash so `base + '/path'` never doubles up.
function normalizeBase(baseUrl) {
  return String(baseUrl).replace(/\/+$/, '');
}

async function fetchOrFail(check, url, opts) {
  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    fail(check, url, `request error: ${e && e.message ? e.message : e}`);
  }
  return res;
}

export async function runSmoke(baseUrl) {
  if (!baseUrl) throw new Error('runSmoke: baseUrl is required');
  const base = normalizeBase(baseUrl);

  // a. Static pages: 200 + expected marker.
  for (const page of PAGES) {
    const url = base + page.path;
    const res = await fetchOrFail('static-page', url);
    if (res.status !== 200) fail('static-page', url, `expected 200, got ${res.status}`);
    const body = await res.text();
    if (!body.includes(page.marker)) {
      fail('static-page', url, `missing expected marker "${page.marker}"`);
    }
  }

  // b. Core API flow: create a collection, add words, read them back.
  // Use obviously-fake data so it's unmistakable in any data store.
  const createUrl = base + '/api/collections';
  const createRes = await fetchOrFail('api-create', createUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ honoree_name: 'SMOKE TEST' }),
  });
  if (createRes.status !== 201) {
    fail('api-create', createUrl, `expected 201, got ${createRes.status}`);
  }
  const created = await createRes.json();
  if (!created || !created.id || !created.owner_token) {
    fail('api-create', createUrl, 'response missing id/owner_token');
  }
  const id = created.id;

  const words = ['smoke-1', 'smoke-2', 'smoke-3'];
  const wordsUrl = base + `/api/collections/${id}/words`;
  const wordsRes = await fetchOrFail('api-add-words', wordsUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ words, added_by: 'smoke' }),
  });
  if (wordsRes.status !== 200) {
    fail('api-add-words', wordsUrl, `expected 200, got ${wordsRes.status}`);
  }
  const added = await wordsRes.json();
  if (!added || added.added !== words.length) {
    fail('api-add-words', wordsUrl, `expected added=${words.length}, got ${added && added.added}`);
  }

  // GET the collection (this is also the public view the front-end reads).
  const getUrl = base + `/api/collections/${id}`;
  const getRes = await fetchOrFail('api-get', getUrl);
  if (getRes.status !== 200) fail('api-get', getUrl, `expected 200, got ${getRes.status}`);
  const view = await getRes.json();
  if (typeof view.count !== 'number' || view.count < words.length) {
    fail('api-get', getUrl, `expected count >= ${words.length}, got ${view.count}`);
  }
  const texts = Array.isArray(view.words) ? view.words.map((w) => w.text) : [];
  for (const w of words) {
    if (!texts.includes(w)) fail('api-get', getUrl, `added word "${w}" not reflected in view`);
  }

  // c. Payment flag: card_enabled must be a present boolean (a broken/
  // misconfigured payment config would drop or corrupt it). No charge attempted.
  if (typeof view.card_enabled !== 'boolean') {
    fail('payment-flag', getUrl, `card_enabled is not a boolean (got ${typeof view.card_enabled})`);
  }

  return true;
}

// CLI wrapper — only runs when invoked directly, never on import.
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const baseUrl = process.env.SMOKE_BASE_URL || process.argv[2];
  if (!baseUrl) {
    console.error('Usage: SMOKE_BASE_URL=<url> node scripts/smoke.mjs');
    console.error('   or: node scripts/smoke.mjs <url>');
    process.exit(1);
  }
  runSmoke(baseUrl)
    .then(() => {
      console.log('SMOKE OK ' + normalizeBase(baseUrl));
    })
    .catch((err) => {
      console.error(err && err.message ? err.message : err);
      process.exit(1);
    });
}
