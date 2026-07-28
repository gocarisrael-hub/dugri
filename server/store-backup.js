// store-backup.js — the shared "back up a JSON store before a destructive
// overwrite" helper, factored out of content.js so every mirrored store gets the
// SAME guarantees instead of four hand-rolled near-copies.
//
// Used by the staging import, which REPLACES a store wholesale. The contract the
// caller depends on:
//   • returns the backup path on success;
//   • returns null when there is NOTHING to back up (no file yet) — safe to proceed;
//   • THROWS on a real copy failure (a file exists but the copy failed) — the
//     caller MUST abort, because overwriting without a recovery point is how an
//     import turns into data loss.
// Old backups are pruned (best-effort) so repeated imports can't fill the volume.
const fs = require('fs');
const path = require('path');

const BACKUP_KEEP = 10;

// Back up `file` next to itself as "<base>.backup-<ms><ext>".
function backupFile(file, opts = {}) {
  if (!fs.existsSync(file)) return null;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${base}.backup-${now}${ext}`);
  fs.copyFileSync(file, dest); // throws on a real failure — the caller aborts
  pruneBackups(dir, base, ext, opts.keep);
  return dest;
}

// Keep only the most recent `keep` backups of one store, by the timestamp in the
// filename. Best-effort on purpose: a prune failure must NEVER break an import —
// the backup it protects has already been written successfully.
function pruneBackups(dir, base, ext, keep) {
  const limit = Number(keep) > 0 ? Number(keep) : BACKUP_KEEP;
  try {
    const re = new RegExp(
      '^' +
        base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '\\.backup-(\\d+)' +
        ext.replace('.', '\\.') +
        '$'
    );
    const found = [];
    for (const name of fs.readdirSync(dir)) {
      const m = re.exec(name);
      if (m) found.push({ name, ts: Number(m[1]) });
    }
    found.sort((a, b) => b.ts - a.ts);
    for (const f of found.slice(limit)) {
      try {
        fs.unlinkSync(path.join(dir, f.name));
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

module.exports = { backupFile, BACKUP_KEEP };
