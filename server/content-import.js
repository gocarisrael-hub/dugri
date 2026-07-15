// content-import.js — one-click "import ALL content overrides from staging".
//
// Staging and production are SEPARATE Railway services with SEPARATE volumes, so
// content edits made in staging's editor never reach production on their own. This
// module mirrors staging's whole content-overrides store onto THIS service:
//   1. Fetch staging's full overrides object (admin-gated GET /api/admin/content/all).
//   2. Fetch every referenced /content-uploads/<name> image and re-save its bytes
//      here. Filenames are content-addressed (sha256), so a re-save yields the SAME
//      path → the paths stored in the overrides stay valid on this service.
//   3. Back up the current store, then replace it with staging's (a mirror).
//
// Fail-soft AND loss-safe. The overwrite is the very last step, and it is refused
// unless everything up to it succeeded:
//   • an EMPTY staging store never overwrites prod (a reset staging volume must not
//     wipe production — an empty import is never legitimate);
//   • a real BACKUP failure aborts (prod is never overwritten without a recovery
//     point when it had content);
//   • any network error / non-200 / malformed payload / image mismatch aborts with a
//     clear error, and every image THIS import newly wrote is cleaned back off the
//     volume so a failed import leaves the volume exactly as it found it.
const contentStore = require('./content');

function msg(e) {
  return String((e && e.message) || e);
}

// Normalize a URL to a comparable origin: lowercase protocol + host, the leading
// "www." stripped (apex/www of the same site count as one), and the port dropped
// when it's the protocol default (443 for https, 80 for http). Returns null for a
// value that isn't a parseable absolute URL.
function normalizeOrigin(u) {
  try {
    const url = new URL(String(u));
    const proto = url.protocol.toLowerCase(); // includes trailing ':'
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    let port = url.port; // '' when the default for the scheme
    if ((proto === 'https:' && port === '443') || (proto === 'http:' && port === '80')) port = '';
    return proto + '//' + host + (port ? ':' + port : '');
  } catch {
    return null;
  }
}

// Would `stagingUrl` point back at THIS service? Compares parsed origins (protocol +
// host + effective port, www/apex folded) so a :443, www/apex, or trailing-slash
// spelling of the prod host can't slip past the self-import refusal.
function isSelfOrigin(stagingUrl, ownOrigins) {
  const s = normalizeOrigin(stagingUrl);
  if (!s) return false;
  return (ownOrigins || []).some((o) => normalizeOrigin(o) === s);
}

// Run `worker` over `items` with at most `limit` in flight at once. Never rejects:
// every worker error is collected and returned, so the caller can abort AFTER all
// in-flight fetches settle (nothing is left dangling to write a file post-abort).
async function runPool(items, limit, worker) {
  const errors = [];
  let idx = 0;
  const n = Math.min(Math.max(1, limit), items.length);
  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push(
      (async () => {
        while (idx < items.length) {
          const cur = items[idx++];
          try {
            await worker(cur);
          } catch (e) {
            errors.push(e);
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  return errors;
}

// opts = { stagingUrl, ownOrigins, adminKey, fetchImpl?, content?, concurrency? }.
// fetchImpl defaults to the global fetch; content defaults to the real store (both
// injectable so unit tests can stub the network and point at a throwaway store).
async function importFromStaging(opts) {
  opts = opts || {};
  const content = opts.content || contentStore;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const stagingUrl = String(opts.stagingUrl || '').replace(/\/+$/, '');
  const adminKey = opts.adminKey || '';
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 5;

  if (!stagingUrl) {
    return { ok: false, status: 400, error: 'STAGING_URL is not set on this service' };
  }
  if (isSelfOrigin(stagingUrl, opts.ownOrigins)) {
    return {
      ok: false,
      status: 400,
      error: 'STAGING_URL points at this same service — refusing self-import',
    };
  }
  if (!fetchImpl) {
    return { ok: false, status: 500, error: 'no fetch implementation available' };
  }

  // 1. Staging's FULL overrides object (admin-gated on staging → carry the key).
  let overrides;
  try {
    const url =
      stagingUrl +
      '/api/admin/content/all' +
      (adminKey ? '?key=' + encodeURIComponent(adminKey) : '');
    const r = await fetchImpl(url);
    if (!r || !r.ok) {
      return {
        ok: false,
        status: 502,
        error: 'staging overrides fetch failed (HTTP ' + ((r && r.status) || '?') + ')',
      };
    }
    const data = await r.json();
    overrides = data && data.overrides;
  } catch (e) {
    return { ok: false, status: 502, error: 'staging overrides fetch error: ' + msg(e) };
  }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    return { ok: false, status: 502, error: 'staging returned a malformed overrides object' };
  }

  // Stage + validate BEFORE touching the live store. sanitizeStore drops anything
  // off-shape/off-origin, so a corrupt staging payload can never corrupt prod.
  const staged = content.sanitizeStore(overrides);
  const imgPaths = content.collectImagePaths(staged);
  let fields = 0;
  for (const page of Object.keys(staged)) fields += Object.keys(staged[page]).length;

  // An EMPTY staging store must NEVER overwrite production. A reset staging volume
  // (redeploy without a persisted volume) returns {}, which passes the malformed
  // guard above but would wipe every prod text + image. There is no legitimate empty
  // import, so refuse it here — before any image is fetched or the store is touched.
  if (fields === 0 && imgPaths.length === 0) {
    return {
      ok: false,
      status: 400,
      error: 'staging has no content to import — nothing was changed',
    };
  }

  // Track the image paths THIS import newly saved so a later abort can remove them —
  // a failed import must leave the volume exactly as it found it. Content-addressed,
  // so cleanup NEVER deletes a hash the live (pre-overwrite) store still references.
  const written = [];
  function cleanupWritten() {
    for (const p of written) {
      try {
        if (!content.isImageReferenced(p)) content.deleteUpload(p);
      } catch {
        /* best-effort cleanup — never throw out of an abort path */
      }
    }
  }

  // 2. Fetch + re-save every DISTINCT referenced image, with bounded concurrency (a
  // large gallery fetched serially can exceed the request timeout). Content-addressed,
  // so the re-save must reproduce the exact same path — a mismatch means the mirrored
  // override would dangle, so it's a hard error. Any failure aborts before commit.
  const errors = await runPool(imgPaths, concurrency, async (p) => {
    const r = await fetchImpl(stagingUrl + p);
    if (!r || !r.ok) {
      throw new Error(
        'staging image fetch failed for ' + p + ' (HTTP ' + ((r && r.status) || '?') + ')'
      );
    }
    const ab = await r.arrayBuffer();
    const saved = content.saveImageBytes(Buffer.from(ab));
    written.push(saved); // track even a mismatch so cleanup reclaims it
    if (saved !== p) {
      throw new Error('image content mismatch for ' + p + ' (re-saved as ' + saved + ')');
    }
  });
  if (errors.length) {
    cleanupWritten();
    return { ok: false, status: 502, error: 'staging image import failed: ' + msg(errors[0]) };
  }

  // 3. Back up the current live store BEFORE the destructive overwrite. backup()
  // returns the path on success, null when there is NOTHING to back up (no existing
  // overrides file — safe to proceed), and THROWS on a real copy failure (an existing
  // store but the volume write failed). Prod must never be overwritten without a
  // recovery point when it had content, so a real failure aborts (and cleans up).
  let backup;
  try {
    backup = content.backup();
  } catch (e) {
    cleanupWritten();
    return {
      ok: false,
      status: 500,
      error: 'could not back up the current content before import: ' + msg(e),
    };
  }

  // 4. Commit: mirror staging's overrides onto this service's store.
  content.replaceAll(staged);

  return {
    ok: true,
    pages: Object.keys(staged).length,
    fields,
    images: imgPaths.length,
    backup,
  };
}

module.exports = { importFromStaging, isSelfOrigin, normalizeOrigin };
