// store-import.js — mirror the owner-editable STORES from staging onto this
// service, alongside the content overrides that content-import.js already
// handles.
//
// Covers: settings (email templates, WhatsApp triggers, reminder list, prices),
// the playbook notes, the design-image gallery (+ the uploaded files it points
// at), and the owner-created word lists.
//
// MIRROR semantics, chosen deliberately by the owner: the target ends up equal to
// the source, so an item that exists only on the target is DELETED. That makes an
// import destructive, which drives every safety rule below.
//
// Order of operations — the whole point of this module:
//   1. fetch + validate the WHOLE payload;
//   2. refuse an empty one (a reset source volume must never wipe the target);
//   3. fetch every referenced image and write it to the volume;
//   4. back up EVERY store — abort if any backup fails;
//   5. only then replace the stores.
// Nothing is replaced until everything that can fail has already succeeded, so
// the common failure modes (source down, half a payload, a missing image) leave
// the target untouched rather than half-mirrored. A half-import — texts from the
// source but images from before it — is worse than no import, because the owner
// cannot tell by looking which half landed.
const contentStore = require('./content');

function msg(e) {
  return String((e && e.message) || e);
}

// The stores this module mirrors, as a table rather than four copy-pasted blocks
// so a new store is one entry and cannot silently skip a backup.
//   key      — the field name in the wire payload
//   exportFn — read the source's state
//   backupFn — recovery point; throws on real failure
//   replace  — commit
//   isEmpty  — used ONLY for the all-stores-empty refusal below
const STORES = [
  {
    key: 'settings',
    exportFn: (d) => d.settings.exportOverrides(),
    backupFn: (d) => d.settings.backup(),
    replace: (d, v) => d.settings.replaceOverrides(v),
    isEmpty: (v) => !v || Object.keys(v).length === 0,
  },
  {
    key: 'playbook',
    exportFn: (d) => d.playbook.exportNotes(),
    backupFn: (d) => d.playbook.backup(),
    replace: (d, v) => d.playbook.replaceNotes(v),
    isEmpty: (v) => !Array.isArray(v) || v.length === 0,
  },
  {
    key: 'designImages',
    exportFn: (d) => d.designImages.getAll(),
    backupFn: (d) => d.designImages.backup(),
    replace: (d, v) => d.designImages.replaceAll(v),
    isEmpty: (v) => !v || Object.keys(v).length === 0,
  },
  {
    key: 'wordlists',
    exportFn: (d) => d.wordlists.exportOwnerLists(),
    backupFn: (d) => d.wordlists.backup(),
    replace: (d, v) => d.wordlists.replaceOwnerLists(v),
    isEmpty: (v) => !Array.isArray(v) || v.length === 0,
  },
];

// What THIS service exposes for another one to mirror. Contains owner-authored
// configuration only — never orders, customers, words, tokens or secrets.
function exportAll(deps) {
  const out = {};
  for (const s of STORES) out[s.key] = s.exportFn(deps);
  return out;
}

// Run `worker` over `items` with at most `limit` in flight. Never rejects: errors
// are collected so the caller can abort AFTER every in-flight fetch has settled,
// leaving nothing dangling to write a file post-abort.
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

// opts = { stagingUrl, adminKey, deps, fetchImpl?, concurrency? }
// `deps` carries the four store modules (injectable so tests need no DATA_DIR).
async function importFromStaging(opts) {
  opts = opts || {};
  const deps = opts.deps || {};
  const content = opts.content || contentStore;
  const fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  const stagingUrl = String(opts.stagingUrl || '').replace(/\/+$/, '');
  const adminKey = opts.adminKey || '';
  const concurrency = Number(opts.concurrency) > 0 ? Number(opts.concurrency) : 5;

  if (!stagingUrl) return { ok: false, status: 400, error: 'STAGING_URL is not set' };
  if (!fetchImpl) return { ok: false, status: 500, error: 'no fetch implementation available' };

  // 1. Fetch the source's whole payload.
  let payload;
  try {
    const url =
      stagingUrl +
      '/api/admin/stores/export' +
      (adminKey ? '?key=' + encodeURIComponent(adminKey) : '');
    const r = await fetchImpl(url);
    if (!r || !r.ok) {
      return {
        ok: false,
        status: 502,
        error:
          'staging stores fetch failed (HTTP ' +
          ((r && r.status) || '?') +
          ') — is staging running a build that has /api/admin/stores/export?',
      };
    }
    payload = (await r.json()) || {};
  } catch (e) {
    return { ok: false, status: 502, error: 'staging stores fetch error: ' + msg(e) };
  }
  const stores = payload && payload.stores;
  if (!stores || typeof stores !== 'object' || Array.isArray(stores)) {
    return { ok: false, status: 502, error: 'staging returned a malformed stores payload' };
  }

  // 2. Refuse a wholly empty payload. A source whose volume was reset returns
  //    empty for every store — structurally valid, and under mirror semantics it
  //    would DELETE every text, price, note, gallery and word list on this
  //    service. There is no legitimate empty import.
  if (STORES.every((s) => s.isEmpty(stores[s.key]))) {
    return {
      ok: false,
      status: 400,
      error: 'staging has nothing to import — nothing was changed',
    };
  }

  // 3. Fetch every image the incoming gallery references, BEFORE any store is
  //    replaced. Mirroring the JSON without the bytes would leave every override
  //    pointing at a file absent from this volume.
  const imgPaths = deps.designImages.collectImagePaths(stores.designImages || {});
  const written = [];
  function cleanupWritten() {
    for (const p of written) {
      try {
        if (!content.isImageReferenced(p)) content.deleteUpload(p);
      } catch {
        /* best-effort — never throw out of an abort path */
      }
    }
  }
  const imgErrors = await runPool(imgPaths, concurrency, async (p) => {
    const r = await fetchImpl(stagingUrl + p);
    if (!r || !r.ok) {
      throw new Error('image fetch failed for ' + p + ' (HTTP ' + ((r && r.status) || '?') + ')');
    }
    const ab = await r.arrayBuffer();
    const { path: saved, created } = content.saveImageBytes(Buffer.from(ab));
    // Only reclaim what THIS import created: a created:false path already existed
    // and may be referenced by the live store, so deleting it on abort would be
    // the data loss we're trying to prevent.
    if (created) written.push(saved);
    if (saved !== p) {
      throw new Error('image content mismatch for ' + p + ' (re-saved as ' + saved + ')');
    }
  });
  if (imgErrors.length) {
    cleanupWritten();
    return { ok: false, status: 502, error: 'gallery image import failed: ' + msg(imgErrors[0]) };
  }

  // 4. Back up EVERY store before replacing ANY. A backup that throws means this
  //    service has data it cannot protect, so nothing is overwritten at all.
  const backups = {};
  for (const s of STORES) {
    try {
      backups[s.key] = s.backupFn(deps);
    } catch (e) {
      cleanupWritten();
      return { ok: false, status: 500, error: 'backup failed for ' + s.key + ': ' + msg(e) };
    }
  }

  // 5. Commit. Each replace validates its own payload and rolls its own memory
  //    back on a failed save. A failure here is the one case that CAN leave a
  //    partial state, so it is reported with the exact store that failed and the
  //    backup paths — the operator's recovery path. Ordering puts the cheap,
  //    most-validated store first so a malformed payload fails before the
  //    file-touching ones run.
  const applied = [];
  for (const s of STORES) {
    const incoming = stores[s.key];
    if (incoming === undefined) continue; // source lacks this store — leave ours alone
    try {
      s.replace(deps, incoming);
      applied.push(s.key);
    } catch (e) {
      return {
        ok: false,
        status: 500,
        error: 'import failed while applying ' + s.key + ': ' + msg(e),
        applied,
        backups,
        partial: applied.length > 0,
      };
    }
  }

  return {
    ok: true,
    applied,
    backups,
    images: imgPaths.length,
    imagesWritten: written.length,
  };
}

module.exports = { exportAll, importFromStaging, STORES };
