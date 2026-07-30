// template-import.js — mirror the OWNER TEMPLATE STORE from staging onto this
// service: the designs the owner onboarded and calibrated through the admin UI.
//
// Why this is a THIRD import module rather than another entry in store-import's
// table. The other two mirrors move JSON (plus a handful of content-addressed
// images). A template is a DIRECTORY — a dozen SVGs, one or two font binaries,
// a recipe, and a themes.json entry — that only means anything as a complete set.
// Half a template renders nothing, so the unit of work here is the whole dir, and
// the transfer needs its own manifest + per-file fetch. See server/template-store.js
// for the overlay this reads and writes (DATA_DIR/templates).
//
// ADDITIVE semantics, deliberately UNLIKE store-import's mirror. A template the
// owner uploaded here but not on staging is left alone; nothing is ever deleted.
// The reason is asymmetry of harm: a stale extra design is a nuisance the owner
// can remove with one click (DELETE /api/admin/templates/:key), while a deleted
// one is 8MB of hand-calibrated artwork that exists nowhere else. Removal stays
// an explicit, per-template act.
//
// Order of operations — the same discipline as the other two importers:
//   1. fetch + validate the WHOLE manifest (every key and path checked for safety
//      BEFORE a byte is downloaded);
//   2. refuse an empty one (a reset source volume must never be treated as truth);
//   3. download every file into a scratch dir inside the store, verifying each
//      one's sha256 against the manifest;
//   4. back up the owner themes.json — abort if that fails;
//   5. only then swap the scratch dirs into place.
// Nothing live is touched until everything that can fail already has, and the
// swap itself restores the previous dir if any step of it throws.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const store = require('./template-store');
const templates = require('./templates');
const { backupFile } = require('./store-backup');

// Hard ceiling on one import. A template is a few MB; a whole store is tens. This
// is not a security boundary (the source is our own admin-gated service) but a
// runaway guard, so a corrupt manifest can't ask us to stream the volume full.
const MAX_TOTAL_BYTES = Number(process.env.TEMPLATE_IMPORT_MAX_BYTES || 500 * 1024 * 1024);

function msg(e) {
  return String((e && e.message) || e);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// A path RELATIVE to one template dir, as it may appear in a manifest. Rejects
// absolute paths, any traversal segment, and backslashes (a Windows-style
// separator would survive a naive split and land as a literal filename). Returns
// the normalized forward-slash form, or null when the value is unusable.
function safeRelPath(rel) {
  const raw = String(rel == null ? '' : rel);
  if (!raw || raw.includes('\\') || path.isAbsolute(raw)) return null;
  const parts = raw.split('/').filter(Boolean);
  if (!parts.length) return null;
  if (parts.some((p) => p === '.' || p === '..')) return null;
  return parts.join('/');
}

// Every file under one owner template dir, as {rel, bytes, sha256}. Walks
// recursively because fonts legitimately live in a subdirectory
// (fonts/<family>/<file>.ttf — see safeFontRel in templates.js).
function listTemplateFiles(dir) {
  const out = [];
  const walk = (abs, rel) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(childAbs, childRel);
      else if (ent.isFile()) {
        const buf = fs.readFileSync(childAbs);
        out.push({ rel: childRel, bytes: buf.length, sha256: sha256(buf) });
      }
    }
  };
  walk(dir, '');
  return out;
}

// What THIS service offers another one to mirror: the owner LAYER only, never the
// shipped templates baked into the image. The target has those already (same
// image), and copying them would turn every shipped design on the target into a
// copy-on-write owner entry that stops receiving updates.
//
// The manifest carries metadata only — sizes and digests. The bytes come one file
// at a time from the download route, so a store with a hundred MB of artwork
// never has to be marshalled into a single JSON response.
function exportManifest() {
  const root = store.storeRoot();
  const empty = { themes: {}, recipes: {}, files: [] };
  if (!root || !fs.existsSync(root)) return empty;

  const themes = templates.loadOwnerThemes();
  const files = [];
  const recipes = {};

  for (const name of fs.readdirSync(root)) {
    const dir = store.ownerTemplateDir(name); // null for recipes/ + themes.json
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) continue;
    for (const f of listTemplateFiles(dir)) files.push({ key: name, ...f });
  }

  const recipesDir = store.ownerRecipesDir();
  if (recipesDir && fs.existsSync(recipesDir)) {
    for (const name of fs.readdirSync(recipesDir)) {
      if (!name.endsWith('.json')) continue;
      const key = name.slice(0, -'.json'.length);
      if (!store.ownerRecipePath(key)) continue; // unsafe name — never offer it
      try {
        recipes[key] = JSON.parse(fs.readFileSync(path.join(recipesDir, name), 'utf8'));
      } catch {
        /* a corrupt recipe is skipped, not fatal: the template still imports and
           the target regenerates it with POST /api/admin/templates/:key/redetect */
      }
    }
  }

  return { themes, recipes, files };
}

// Resolve one manifest entry to an absolute path inside the OWNER store, for the
// download route. Returns null when the key or path is unsafe, so the route can
// 404 without ever touching the filesystem. Deliberately does NOT fall through to
// the shipped dir: only the owner layer is exportable.
function ownerFilePath(key, rel) {
  const dir = store.ownerTemplateDir(key);
  const safe = safeRelPath(rel);
  if (!dir || !safe) return null;
  const abs = path.resolve(dir, safe);
  if (!abs.startsWith(dir + path.sep)) return null;
  return abs;
}

// Run `worker` over `items` with at most `limit` in flight. Never rejects: errors
// are collected so the caller aborts only AFTER every in-flight fetch has
// settled, leaving nothing dangling to write a file post-abort.
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

// Validate the whole manifest up front and return { keys, files } or { error }.
// Every key must be a legal owner-store key and every path must be safe; ONE bad
// entry rejects the ENTIRE import rather than being skipped. Skipping is the
// failure mode this module exists to avoid — it produces a template that is
// present, listed, and missing the file nobody noticed.
function validateManifest(manifest) {
  const themes = manifest.themes;
  const recipes = manifest.recipes;
  const files = manifest.files;
  if (!themes || typeof themes !== 'object' || Array.isArray(themes)) {
    return { error: 'staging returned a malformed template manifest (themes)' };
  }
  if (!recipes || typeof recipes !== 'object' || Array.isArray(recipes)) {
    return { error: 'staging returned a malformed template manifest (recipes)' };
  }
  if (!Array.isArray(files)) {
    return { error: 'staging returned a malformed template manifest (files)' };
  }

  const keys = new Set();
  for (const k of Object.keys(themes)) {
    if (!store.ownerTemplateDir(k)) return { error: 'unsafe template key in manifest: ' + k };
    keys.add(k);
  }
  for (const k of Object.keys(recipes)) {
    if (!store.ownerRecipePath(k)) return { error: 'unsafe recipe key in manifest: ' + k };
  }

  const checked = [];
  let total = 0;
  for (const f of files) {
    if (!f || typeof f !== 'object') return { error: 'malformed file entry in manifest' };
    const key = String(f.key || '');
    const rel = safeRelPath(f.rel);
    if (!store.ownerTemplateDir(key)) return { error: 'unsafe template key in manifest: ' + key };
    if (!rel) return { error: 'unsafe file path in manifest: ' + String(f.rel) };
    if (typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256)) {
      return { error: 'missing or malformed sha256 for ' + key + '/' + rel };
    }
    total += Number(f.bytes) || 0;
    keys.add(key);
    checked.push({ key, rel, sha256: f.sha256 });
  }
  if (total > MAX_TOTAL_BYTES) {
    return {
      error:
        'staging template store is ' +
        Math.round(total / 1024 / 1024) +
        'MB, over the ' +
        Math.round(MAX_TOTAL_BYTES / 1024 / 1024) +
        'MB import limit',
    };
  }

  // A theme entry with no files is a registration pointing at nothing. It would
  // list in the admin UI and fail to render, which is worse than not importing
  // it — so it's a hard error, naming the key so the owner knows what to re-upload
  // on staging.
  const withFiles = new Set(checked.map((f) => f.key));
  for (const k of Object.keys(themes)) {
    if (!withFiles.has(k)) return { error: 'template "' + k + '" has no files on staging' };
  }

  return { keys: [...keys], files: checked, bytes: total };
}

// opts = { stagingUrl, adminKey, fetchImpl?, concurrency?, now? }
async function importFromStaging(opts) {
  opts = opts || {};
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const stagingUrl = String(opts.stagingUrl || '').replace(/\/+$/, '');
  const adminKey = opts.adminKey || '';
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 4;
  const now = typeof opts.now === 'number' ? opts.now : Date.now();

  const root = store.storeRoot();
  if (!root) {
    return {
      ok: false,
      status: 409,
      error: 'no persistent template store configured (DATA_DIR unset)',
    };
  }
  if (!stagingUrl) return { ok: false, status: 400, error: 'STAGING_URL is not set' };
  if (!fetchImpl) return { ok: false, status: 500, error: 'no fetch implementation available' };

  const q = adminKey ? '?key=' + encodeURIComponent(adminKey) : '';

  // 1. The manifest.
  let manifest;
  try {
    const r = await fetchImpl(stagingUrl + '/api/admin/templates/export' + q);
    if (!r || !r.ok) {
      return {
        ok: false,
        status: 502,
        error:
          'staging template manifest fetch failed (HTTP ' +
          ((r && r.status) || '?') +
          ') — is staging running a build that has /api/admin/templates/export?',
      };
    }
    manifest = (await r.json()) || {};
  } catch (e) {
    return { ok: false, status: 502, error: 'staging template manifest fetch error: ' + msg(e) };
  }

  const checked = validateManifest(manifest);
  if (checked.error) return { ok: false, status: 502, error: checked.error };

  // 2. Refuse an empty store. Additive semantics mean an empty import is harmless
  //    rather than destructive — but it is still always a misconfiguration (wrong
  //    STAGING_URL, reset volume), and reporting it as a successful no-op is how
  //    the owner ends up believing a design shipped when it didn't.
  if (!checked.files.length) {
    return {
      ok: false,
      status: 400,
      error: 'staging has no owner templates to import — nothing was changed',
    };
  }

  // 3. Download EVERYTHING into a scratch dir first. It lives inside the store
  //    root so the final move is a same-filesystem rename (atomic) rather than a
  //    cross-device copy that can half-finish.
  const scratch = path.join(root, '.import-' + now);
  const cleanupScratch = () => {
    try {
      fs.rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* best-effort — never throw out of an abort path */
    }
  };
  try {
    fs.mkdirSync(scratch, { recursive: true });
  } catch (e) {
    return { ok: false, status: 500, error: 'could not create the import scratch dir: ' + msg(e) };
  }

  const errors = await runPool(checked.files, concurrency, async (f) => {
    const url =
      stagingUrl +
      '/api/admin/templates/export/file' +
      (adminKey ? '?key=' + encodeURIComponent(adminKey) + '&' : '?') +
      'template=' +
      encodeURIComponent(f.key) +
      '&path=' +
      encodeURIComponent(f.rel);
    const r = await fetchImpl(url);
    if (!r || !r.ok) {
      throw new Error(
        'file fetch failed for ' + f.key + '/' + f.rel + ' (HTTP ' + ((r && r.status) || '?') + ')'
      );
    }
    const buf = Buffer.from(await r.arrayBuffer());
    // Verify against the manifest digest. A truncated body is the realistic
    // failure here (a proxy timing out mid-stream still yields a 200), and a
    // truncated SVG imports clean and renders broken.
    const got = sha256(buf);
    if (got !== f.sha256) {
      throw new Error('content mismatch for ' + f.key + '/' + f.rel + ' (digest differs)');
    }
    const dest = path.join(scratch, f.key, f.rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
  });
  if (errors.length) {
    cleanupScratch();
    return { ok: false, status: 502, error: 'template import failed: ' + msg(errors[0]) };
  }

  // 4. Back up the owner themes.json before it is rewritten. backupFile returns
  //    null when there is nothing to back up (a first-ever import on a fresh
  //    volume) and THROWS on a real copy failure — which aborts, because
  //    overwriting the theme registry without a recovery point is how an import
  //    turns into losing every design at once.
  let backup;
  try {
    backup = backupFile(store.ownerThemesPath(), { now });
  } catch (e) {
    cleanupScratch();
    return { ok: false, status: 500, error: 'could not back up the owner themes.json: ' + msg(e) };
  }

  // 5. Swap each downloaded dir into place. An existing owner dir is renamed
  //    aside first and only removed once its replacement is in — so a failure
  //    mid-swap restores what was there rather than leaving the key with no dir
  //    at all (which would silently fall back to the shipped template, or to
  //    nothing for an owner-only design).
  const added = [];
  const updated = [];
  const aside = [];
  try {
    for (const key of checked.keys) {
      const src = path.join(scratch, key);
      if (!fs.existsSync(src)) continue; // themes-only key — validateManifest rejects these
      const live = store.ownerTemplateDir(key);
      const existed = fs.existsSync(live);
      if (existed) {
        const parked = live + '.replacing-' + now;
        fs.renameSync(live, parked);
        aside.push({ live, parked });
      }
      fs.renameSync(src, live);
      (existed ? updated : added).push(key);
    }
  } catch (e) {
    // Roll every completed swap back, newest first.
    for (const { live, parked } of aside.reverse()) {
      try {
        fs.rmSync(live, { recursive: true, force: true });
        fs.renameSync(parked, live);
      } catch {
        /* best-effort — the parked copy is still on the volume either way */
      }
    }
    cleanupScratch();
    return {
      ok: false,
      status: 500,
      error: 'could not install the imported templates: ' + msg(e),
      backup,
    };
  }
  // Every swap landed: drop the parked copies.
  for (const { parked } of aside) {
    try {
      fs.rmSync(parked, { recursive: true, force: true });
    } catch {
      /* best-effort — a leftover .replacing- dir is inert, not a template dir */
    }
  }

  // 6. Recipes, then the theme entries LAST. Ordering matters: a theme entry is
  //    what makes a design visible to the admin UI and the generator, so writing
  //    it only after its files and recipe are on disk means the design is never
  //    listed before it can render.
  const recipesDir = store.ownerRecipesDir();
  for (const [key, blob] of Object.entries(manifest.recipes)) {
    const dest = store.ownerRecipePath(key);
    if (!dest) continue; // validated above; belt and braces
    try {
      fs.mkdirSync(recipesDir, { recursive: true });
      fs.writeFileSync(dest, JSON.stringify(blob, null, 1) + '\n', 'utf8');
    } catch {
      /* a recipe is regenerable (POST /api/admin/templates/:key/redetect); losing
         one must not fail an import whose artwork already landed */
    }
  }

  // Additive merge: staging's entries win for the keys it has, ours survive for
  // the keys it doesn't. writeThemesFile is atomic and drops the themes cache, so
  // the public design-name endpoint picks the new designs up without a restart.
  const themesPath = store.ownerThemesPath();
  let merged;
  try {
    merged = { ...templates.loadOwnerThemes(), ...manifest.themes };
    templates.writeThemesFile(themesPath, merged);
  } catch (e) {
    return {
      ok: false,
      status: 500,
      error: 'templates were installed but the theme registry write failed: ' + msg(e),
      backup,
      added,
      updated,
      partial: true,
    };
  }

  cleanupScratch();
  return {
    ok: true,
    added,
    updated,
    templates: added.length + updated.length,
    files: checked.files.length,
    bytes: checked.bytes,
    recipes: Object.keys(manifest.recipes).length,
    backup,
  };
}

module.exports = {
  exportManifest,
  ownerFilePath,
  importFromStaging,
  safeRelPath,
  validateManifest,
  MAX_TOTAL_BYTES,
};
