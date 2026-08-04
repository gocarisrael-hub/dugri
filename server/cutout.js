// cutout.js — "make this photo transparent", behind ONE function.
//
// Why it exists: the deck's photo card draws each pawn as a die-cut sticker whose
// white outline is generated from the image's OWN alpha (docs/photo-card.md — the
// halo is a <use> of the slot through a filter that dilates SourceAlpha). A photo
// straight off a phone is opaque, so it has no silhouette to trace and prints as a
// white-bordered RECTANGLE. Cutting the background out is therefore not a nicety;
// it is what makes the card work.
//
// The provider is Adobe's Photoshop API `removeBackground`, reached over plain
// REST with an IMS client-credentials token — NOT the Adobe MCP tools, which are
// interactively authenticated and do not exist inside a Node process on Railway.
// Everything Adobe-specific lives in this file, so swapping providers means
// rewriting `cut()` and nothing else.
//
// Contract with the rest of the server:
//   • isConfigured()          — false unless the credentials AND a public base URL
//                               are present. The feature is then completely inert
//                               and the pipeline behaves exactly as it did before.
//   • removeBackground(bytes) — resolves to a transparent RGBA PNG Buffer, or NULL
//                               on any failure whatsoever. It never throws and
//                               never rejects: an order must not be lost to a
//                               background-removal outage.
//   • serveSource(token)      — backs the ONE route this module needs (see below).
//
// Credentials come from the environment (ADOBE_CLIENT_ID / ADOBE_CLIENT_SECRET),
// not from the settings store: server/settings.js and admin-features.html belong to
// another agent, so the admin toggle is a follow-up request in the PR.
//
// ---------------------------------------------------------------------------
// The awkward part: Adobe takes a URL, not bytes.
//
// `POST /v2/remove-background` accepts its input ONLY as an HTTPS GET url
// (`image.source.url`) — there is no multipart, no base64, and the Firefly
// upload-id path is not documented for this endpoint. So we publish the photo at
// an unguessable, in-memory, short-lived URL on our OWN origin for the length of
// the call and drop it immediately afterwards. Nothing is written to disk, the
// token is 128 bits of randomness, and the entry self-expires — a strictly smaller
// exposure than /content-uploads/<hash>, which is public and permanent.
//
// Adobe reportedly domain-allow-lists sources on v2 ("Domain not allowed"). If
// that bites, the failure is a recorded miss like any other — no order is lost —
// and the fix is an Adobe support allow-list for the production domain.

const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const REPO_ROOT = path.join(__dirname, '..');

const CLIENT_ID = process.env.ADOBE_CLIENT_ID || '';
const CLIENT_SECRET = process.env.ADOBE_CLIENT_SECRET || '';

// --- Adobe endpoints --------------------------------------------------------
// IMS client-credentials (server-to-server) token endpoint. Token is valid ~24h.
const IMS_TOKEN_URL =
  process.env.ADOBE_IMS_TOKEN_URL || 'https://ims-na1.adobelogin.com/ims/token/v3';
// The Photoshop APIs take the SHORT scope string; the generative Firefly APIs take
// a longer one. Overridable because Adobe's own docs disagree with themselves here.
const IMS_SCOPES = process.env.ADOBE_IMS_SCOPES || 'openid,AdobeID,read_organizations';
// remove-background is the CURRENT (v2) operation, but it did NOT move to the new
// photoshop-api.adobe.io host with the rest of Photoshop v2 — submit and poll both
// live on image.adobe.io. (`/pie/psdService/*` v1 reached EOL on 2026-07-31.)
const REMOVE_BG_URL =
  process.env.ADOBE_REMOVE_BG_URL || 'https://image.adobe.io/v2/remove-background';

// --- budgets ----------------------------------------------------------------
// How long one cut may take end to end before we give up and use the original.
const DEFAULT_TIMEOUT_MS = Number(process.env.ADOBE_CUTOUT_TIMEOUT_MS || 20000);
// Poll interval while the Adobe job runs (the call is always asynchronous).
const POLL_MS = Number(process.env.ADOBE_CUTOUT_POLL_MS || 900);
// Adobe rate-limits remove-background POSTs hard at 3 per 3 seconds org-wide, so
// four photos fired at once would throttle US. Space our own submissions out.
const SUBMIT_GAP_MS = Number(process.env.ADOBE_CUTOUT_SUBMIT_GAP_MS || 1100);
// How long a published source URL stays fetchable. Only has to outlive one job.
const SOURCE_TTL_MS = Number(process.env.ADOBE_CUTOUT_SOURCE_TTL_MS || 5 * 60 * 1000);
// Remember the last N cuts by input content hash. The wizard previews a photo and
// then uploads the very same bytes minutes later; without this that is two paid
// calls for one photo. Per-process and bounded — a cost optimisation, not a store
// (the durable copy is the file the upload route writes).
const CACHE_MAX = Number(process.env.ADOBE_CUTOUT_CACHE_MAX || 32);

// The route path this module's temporary source URLs are served from. index.js
// mounts it; keeping the string here means the URL we hand Adobe and the route
// that answers it can never drift apart.
const SOURCE_ROUTE = '/api/pawn-cutout/src';

function publicBaseUrl() {
  const raw = process.env.PUBLIC_BASE_URL || '';
  return raw ? raw.replace(/\/+$/, '') : '';
}

// Adobe has to be able to REACH the source, so an unset (or plain-http, or
// localhost) base URL means the feature stays off rather than failing per photo.
function isConfigured() {
  const base = publicBaseUrl();
  return Boolean(CLIENT_ID && CLIENT_SECRET && /^https:\/\//i.test(base));
}

// ---- the temporary source store --------------------------------------------
const _sources = new Map(); // token -> { bytes, contentType, expiresAt }

function sweepSources(now = Date.now()) {
  for (const [token, entry] of _sources) {
    if (entry.expiresAt <= now) _sources.delete(token);
  }
}

function publishSource(bytes, contentType) {
  sweepSources();
  const token = crypto.randomBytes(16).toString('hex');
  _sources.set(token, { bytes, contentType, expiresAt: Date.now() + SOURCE_TTL_MS });
  return token;
}

/**
 * The published bytes for `token`, or null when it is unknown or expired. The one
 * thing the route needs; it does no access control of its own because the token IS
 * the credential (128 random bits, minutes of life, in memory only).
 */
function serveSource(token) {
  const entry = _sources.get(String(token || ''));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    _sources.delete(token);
    return null;
  }
  return { bytes: entry.bytes, contentType: entry.contentType };
}

// ---- token ------------------------------------------------------------------
// One access token is reused until shortly before it expires. A single in-flight
// promise is shared, so four parallel cutouts fetch one token, not four.
let _token = null; // { value, expiresAt }
let _tokenInFlight = null;

async function accessToken(signal) {
  if (_token && Date.now() < _token.expiresAt) return _token.value;
  if (_tokenInFlight) return _tokenInFlight;
  _tokenInFlight = (async () => {
    const res = await fetch(IMS_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        scope: IMS_SCOPES,
      }),
      signal,
    });
    if (!res.ok) throw new Error('adobe ims http ' + res.status);
    const json = await res.json();
    if (!json || !json.access_token) throw new Error('adobe ims: no access_token');
    // Renew a minute early so a token can never expire mid-request.
    const ttl = Number(json.expires_in || 86400) * 1000;
    _token = { value: json.access_token, expiresAt: Date.now() + Math.max(0, ttl - 60000) };
    return _token.value;
  })();
  try {
    return await _tokenInFlight;
  } catch (e) {
    _token = null;
    throw e;
  } finally {
    _tokenInFlight = null;
  }
}

// ---- cache ------------------------------------------------------------------
const _cache = new Map(); // sha256(input) -> Buffer

function cacheGet(key) {
  const hit = _cache.get(key);
  if (!hit) return null;
  _cache.delete(key); // refresh LRU position
  _cache.set(key, hit);
  return hit;
}

function cachePut(key, buf) {
  _cache.set(key, buf);
  while (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value);
}

// ---- helpers ----------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Enough of a magic-byte sniff to label the source URL's Content-Type. The bytes
// were already typed by content.extFromMagic upstream; this only picks the header.
function mimeOf(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return 'image/png';
  if (buf.length > 12 && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return 'application/octet-stream';
}

// EXIF-rotate + downscale before sending (generator/prepare_photo.py — the same
// shell-out-to-Pillow pattern templates.shrinkSvgImages already uses). Rotating
// MUST happen here: the cutout comes back as a fresh PNG with no EXIF, so a photo
// sent sideways comes back sideways with nothing left to correct it. Best-effort —
// a missing or broken Python just means the original bytes go over the wire.
//
// ASYNC spawn, deliberately not spawnSync: this runs on the BUYER's request path,
// four photos deep, and each resize is a few hundred ms of Pillow. spawnSync would
// block the event loop for all of it and stall every other request on the box.
const PREPARE_TIMEOUT_MS = Number(process.env.ADOBE_CUTOUT_PREPARE_TIMEOUT_MS || 30000);

function prepareForProvider(bytes) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    let child;
    try {
      child = spawn('python3', [path.join(REPO_ROOT, 'generator', 'prepare_photo.py')]);
    } catch {
      return finish(bytes); // no python at all
    }
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      finish(bytes);
    }, PREPARE_TIMEOUT_MS);
    child.stdout.on('data', (d) => chunks.push(d));
    child.on('error', () => {
      clearTimeout(timer);
      finish(bytes);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(chunks);
      finish(code === 0 && out.length > 0 ? out : bytes);
    });
    // A child that dies before reading the photo makes this pipe EPIPE; that is a
    // normal outcome here, not a crash.
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}

// Adobe hands us back URLs (the status URL, then the result URL). Only ever follow
// https — a provider response must not be able to point us at an internal address.
function httpsOnly(url) {
  try {
    return new URL(String(url)).protocol === 'https:' ? String(url) : null;
  } catch {
    return null;
  }
}

// The docs are internally inconsistent about where the finished image lands
// (`outputs[].url` in the status migration guide, `outputs[].destination.url` in
// the storage guide), so read both.
function resultUrlOf(json) {
  const outputs = (json && json.result && json.result.outputs) || [];
  for (const o of outputs) {
    const u = httpsOnly(o && ((o.destination && o.destination.url) || o.url || o.href));
    if (u) return u;
  }
  return null;
}

// Our own submissions are spaced out so a four-photo order can't trip Adobe's
// 3-POSTs-per-3-seconds limit on itself.
let _nextSubmitAt = 0;
async function submitSlot() {
  const wait = _nextSubmitAt - Date.now();
  _nextSubmitAt = Math.max(Date.now(), _nextSubmitAt) + SUBMIT_GAP_MS;
  if (wait > 0) await sleep(wait);
}

// ---- the provider call ------------------------------------------------------
// Submit → poll → download. Throws on anything unexpected; removeBackground turns
// every throw into a null.
async function cut(bytes, signal) {
  const prepared = await prepareForProvider(bytes);
  const token = publishSource(prepared, mimeOf(prepared));
  try {
    const bearer = await accessToken(signal);
    const sourceUrl = publicBaseUrl() + SOURCE_ROUTE + '/' + token;
    const headers = {
      Authorization: 'Bearer ' + bearer,
      'x-api-key': CLIENT_ID,
      'Content-Type': 'application/json',
    };
    await submitSlot();
    const submit = await fetch(REMOVE_BG_URL, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        image: { source: { url: sourceUrl } },
        // "cutout" = subject on transparent ground (vs "mask" = greyscale matte).
        // PNG because it is the only listed output that carries an alpha channel.
        mode: 'cutout',
        output: { mediaType: 'image/png' },
      }),
    });
    if (!submit.ok) throw new Error('adobe remove-background http ' + submit.status);
    const job = await submit.json();
    const statusUrl =
      httpsOnly(job && job.statusUrl) ||
      httpsOnly(submit.headers.get('location')) ||
      (job && job.jobId
        ? 'https://image.adobe.io/v2/status/' + encodeURIComponent(job.jobId)
        : null);
    if (!statusUrl) throw new Error('adobe remove-background: no status url');

    // Poll until terminal. The AbortSignal is the real deadline: once the caller's
    // budget runs out the fetch throws and the whole cut degrades to null.
    for (;;) {
      await sleep(POLL_MS);
      if (signal && signal.aborted) throw new Error('adobe cutout timed out');
      const res = await fetch(statusUrl, {
        headers: { Authorization: 'Bearer ' + bearer, 'x-api-key': CLIENT_ID },
        signal,
      });
      if (!res.ok) throw new Error('adobe status http ' + res.status);
      const json = await res.json();
      const status = String((json && json.status) || '').toLowerCase();
      if (status === 'failed') throw new Error('adobe cutout failed');
      if (status !== 'succeeded') continue; // pending | running | not_started
      const url = resultUrlOf(json);
      if (!url) throw new Error('adobe cutout: no output url');
      // The result URL is pre-signed Adobe-hosted storage — no auth header.
      const out = await fetch(url, { signal });
      if (!out.ok) throw new Error('adobe result http ' + out.status);
      return Buffer.from(await out.arrayBuffer());
    }
  } finally {
    _sources.delete(token); // the job is over; stop serving the photo immediately
  }
}

/**
 * A transparent RGBA PNG of `bytes` with the background removed, or null.
 *
 * NEVER throws. Unconfigured, down, throttled, timed out, or handed something it
 * cannot read — every one of those is a null, and the caller keeps the original
 * photo. Losing a cut costs the owner a manual crop; losing an upload costs an order.
 */
async function removeBackground(bytes, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!isConfigured() || !Buffer.isBuffer(bytes) || !bytes.length) return null;
  const key = crypto.createHash('sha256').update(bytes).digest('hex');
  const cached = cacheGet(key);
  if (cached) return cached;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const png = await cut(bytes, controller.signal);
    if (png && png.length) {
      cachePut(key, png);
      return png;
    }
    return null;
  } catch {
    return null; // best-effort by contract
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  isConfigured,
  removeBackground,
  serveSource,
  SOURCE_ROUTE,
  // Exposed for tests only — no network, no state that outlives the process.
  _internals: {
    publishSource,
    sweepSources,
    prepareForProvider,
    mimeOf,
    resultUrlOf,
    httpsOnly,
    cache: _cache,
    sources: _sources,
    resetToken() {
      _token = null;
      _tokenInFlight = null;
    },
  },
};
