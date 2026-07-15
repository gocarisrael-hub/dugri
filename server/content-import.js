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
// Fail-soft: any network error, non-200, malformed payload, or image mismatch
// returns a clear { ok:false, status, error } WITHOUT touching the live store — the
// overwrite only happens as the very last step, after every image is safely saved
// and the current store is backed up.
const contentStore = require('./content');

function msg(e) {
  return String((e && e.message) || e);
}

// Would `stagingUrl` point back at THIS service? Compared (trailing-slash- and
// case-insensitively) against every known own-origin so we never mirror onto self.
function isSelfOrigin(stagingUrl, ownOrigins) {
  const s = String(stagingUrl || '')
    .replace(/\/+$/, '')
    .toLowerCase();
  if (!s) return false;
  return (ownOrigins || []).some(
    (o) =>
      String(o || '')
        .replace(/\/+$/, '')
        .toLowerCase() === s
  );
}

// opts = { stagingUrl, ownOrigins, adminKey, fetchImpl?, content? }.
// fetchImpl defaults to the global fetch; content defaults to the real store (both
// injectable so unit tests can stub the network and point at a throwaway store).
async function importFromStaging(opts) {
  opts = opts || {};
  const content = opts.content || contentStore;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const stagingUrl = String(opts.stagingUrl || '').replace(/\/+$/, '');
  const adminKey = opts.adminKey || '';

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

  // 2. Fetch + re-save every referenced image. Content-addressed, so the re-save
  // must reproduce the exact same path — otherwise the mirrored override would point
  // at a file we don't have, so abort (live store still untouched at this point).
  let imagesImported = 0;
  for (const p of imgPaths) {
    try {
      const r = await fetchImpl(stagingUrl + p);
      if (!r || !r.ok) {
        return {
          ok: false,
          status: 502,
          error: 'staging image fetch failed for ' + p + ' (HTTP ' + ((r && r.status) || '?') + ')',
        };
      }
      const ab = await r.arrayBuffer();
      const saved = content.saveImageBytes(Buffer.from(ab));
      if (saved !== p) {
        return {
          ok: false,
          status: 502,
          error: 'image content mismatch for ' + p + ' (re-saved as ' + saved + ')',
        };
      }
      imagesImported++;
    } catch (e) {
      return { ok: false, status: 502, error: 'staging image error for ' + p + ': ' + msg(e) };
    }
  }

  // 3. Back up the current live store BEFORE the destructive overwrite.
  const backup = content.backup();

  // 4. Commit: mirror staging's overrides onto this service's store.
  content.replaceAll(staged);

  let fields = 0;
  for (const page of Object.keys(staged)) fields += Object.keys(staged[page]).length;

  return {
    ok: true,
    pages: Object.keys(staged).length,
    fields,
    images: imagesImported,
    backup,
  };
}

module.exports = { importFromStaging, isSelfOrigin };
