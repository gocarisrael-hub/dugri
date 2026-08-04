// Back up the OWNER TEMPLATE STORE off a live Dugri instance.
//
// The designs the owner onboards and calibrates through the admin UI live on the
// Railway volume (DATA_DIR/templates), NOT in this repo. That volume has no
// history and no snapshots: today the only backed-up templates are the shipped
// ones committed under resources/canva/templates, and those are exactly the ones
// nobody edits. A hand-calibrated design deleted by a stray click exists nowhere
// else.
//
// This pulls the whole owner layer down to a directory: themes.json, every
// recipe, and every file of every template, each verified against the sha256 the
// server published for it. Point it at a folder in a separate git repo and each
// run is a versioned snapshot, off Railway, at no cost — and it stays OUT of this
// repo so it never lands in the 250MB deploy upload.
//
// It reads the same two endpoints staging→prod mirroring already uses
// (server/template-import.js): GET /api/admin/templates/export for the manifest,
// then one GET /api/admin/templates/export/file per file. Owner layer only — the
// shipped templates are in git already.
//
// Node 20+, ES module, zero dependencies (global fetch). Import
// `backupTemplates(...)` or run as a CLI:
//
//   node scripts/backup-templates.mjs --url https://dugri-staging.up.railway.app \
//     --key "$ADMIN_KEY" --out ../dugri-backups/staging
//
// Importing has no side effects.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// A manifest path is server-supplied, so it is treated as hostile: it must stay a
// plain relative path INSIDE the snapshot. A compromised or buggy source must not
// be able to write through `../` into the rest of the backup repo.
function safeJoin(root, ...parts) {
  const rel = parts.join('/');
  if (!rel || rel.startsWith('/') || /(^|\/)\.\.(\/|$)/.test(rel) || rel.includes('\0')) {
    throw new Error(`unsafe path in manifest: ${JSON.stringify(rel.slice(0, 120))}`);
  }
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`path escapes the snapshot: ${JSON.stringify(rel.slice(0, 120))}`);
  }
  return abs;
}

async function getJson(fetchImpl, url) {
  const res = await fetchImpl(url);
  if (!res.ok) throw new Error(`GET ${redact(url)} -> HTTP ${res.status}`);
  return res.json();
}

// Never let the admin secret reach a log line or an error message.
function redact(url) {
  return String(url).replace(/([?&]key=)[^&]*/gi, '$1***');
}

/**
 * Pull the owner template store into `outDir` as a complete snapshot.
 *
 * Written into a scratch directory and swapped in only once every byte has
 * arrived and verified, so an interrupted or half-served backup can never
 * replace a good one with a broken one — the same discipline the importer uses
 * when it writes to a live volume.
 *
 * @returns {Promise<{dir:string, templates:number, files:number, bytes:number, recipes:number}>}
 */
export async function backupTemplates({
  baseUrl,
  adminKey,
  outDir,
  fetchImpl = fetch,
  allowEmpty = false,
  log = () => {},
}) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!adminKey) throw new Error('adminKey is required');
  if (!outDir) throw new Error('outDir is required');

  const base = String(baseUrl).replace(/\/+$/, '');
  const k = encodeURIComponent(adminKey);
  const manifest = await getJson(fetchImpl, `${base}/api/admin/templates/export?key=${k}`);

  const files = Array.isArray(manifest && manifest.files) ? manifest.files : [];
  const themes = (manifest && manifest.themes) || {};
  const recipes = (manifest && manifest.recipes) || {};

  // An empty manifest is what a RESET volume looks like, and it is indistinguish-
  // able from "the owner really has no templates". Refusing it by default means a
  // wiped source can never quietly overwrite a good snapshot with nothing.
  if (!allowEmpty && !files.length && !Object.keys(themes).length) {
    throw new Error(
      'the source reported an EMPTY template store. That is what a reset volume ' +
        'looks like, so the existing backup was left untouched. Pass allowEmpty ' +
        'if the store is genuinely empty.'
    );
  }

  const finalDir = path.resolve(outDir);
  const scratch = finalDir + '.incoming';
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });

  let bytes = 0;
  for (const entry of files) {
    const { key, rel } = entry || {};
    if (!key || !rel) throw new Error(`malformed manifest entry: ${JSON.stringify(entry)}`);
    const dest = safeJoin(scratch, 'templates', String(key), String(rel));
    const url =
      `${base}/api/admin/templates/export/file?key=${k}` +
      `&template=${encodeURIComponent(key)}&path=${encodeURIComponent(rel)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`GET ${key}/${rel} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());

    // Verify against the digest the manifest published. A silent truncation is
    // the failure mode that matters: a backup that restores corrupt artwork is
    // worse than a backup that loudly refused to finish.
    if (entry.sha256 && sha256(buf) !== entry.sha256) {
      throw new Error(`checksum mismatch for ${key}/${rel} — backup aborted, nothing replaced`);
    }
    if (entry.bytes != null && buf.length !== entry.bytes) {
      throw new Error(
        `size mismatch for ${key}/${rel}: got ${buf.length}, manifest says ${entry.bytes}`
      );
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, buf);
    bytes += buf.length;
  }

  // themes.json is the registry: without it the files are anonymous directories.
  fs.writeFileSync(path.join(scratch, 'themes.json'), JSON.stringify(themes, null, 1) + '\n');
  const recipeKeys = Object.keys(recipes);
  if (recipeKeys.length) {
    fs.mkdirSync(path.join(scratch, 'recipes'), { recursive: true });
    for (const key of recipeKeys) {
      const dest = safeJoin(scratch, 'recipes', `${key}.json`);
      fs.writeFileSync(dest, JSON.stringify(recipes[key], null, 1) + '\n');
    }
  }
  // The manifest itself, so a restore can re-verify offline without the server.
  fs.writeFileSync(
    path.join(scratch, 'manifest.json'),
    JSON.stringify({ source: base, files, themeKeys: Object.keys(themes) }, null, 1) + '\n'
  );

  // Swap last: everything above can fail, and until this line the previous
  // snapshot is still the one on disk.
  const previous = finalDir + '.previous';
  fs.rmSync(previous, { recursive: true, force: true });
  if (fs.existsSync(finalDir)) fs.renameSync(finalDir, previous);
  fs.mkdirSync(path.dirname(finalDir), { recursive: true });
  fs.renameSync(scratch, finalDir);
  fs.rmSync(previous, { recursive: true, force: true });

  const templateKeys = new Set(files.map((f) => f.key));
  const summary = {
    dir: finalDir,
    templates: templateKeys.size,
    files: files.length,
    recipes: recipeKeys.length,
    bytes,
  };
  log(
    `backed up ${summary.templates} templates, ${summary.files} files ` +
      `(${(bytes / 1e6).toFixed(1)} MB) -> ${finalDir}`
  );
  return summary;
}

function arg(name, argv) {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
}

async function main(argv) {
  const baseUrl = arg('url', argv) || process.env.BACKUP_URL || process.env.STAGING_URL;
  const adminKey = arg('key', argv) || process.env.BACKUP_ADMIN_KEY || process.env.ADMIN_KEY;
  const outDir = arg('out', argv) || process.env.BACKUP_OUT;
  if (!baseUrl || !adminKey || !outDir) {
    console.error(
      'usage: node scripts/backup-templates.mjs --url <base> --key <admin key> --out <dir>\n' +
        '   env: BACKUP_URL / BACKUP_ADMIN_KEY / BACKUP_OUT\n' +
        '   --allow-empty  accept a source that reports no templates'
    );
    process.exitCode = 2;
    return;
  }
  await backupTemplates({
    baseUrl,
    adminKey,
    outDir,
    allowEmpty: argv.includes('--allow-empty'),
    log: (m) => console.log(m),
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error('backup FAILED:', redact(String((e && e.message) || e)));
    process.exit(1);
  });
}
