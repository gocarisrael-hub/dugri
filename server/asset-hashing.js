'use strict';

// Content-hashed serving for the storefront's ES modules.
//
// WHY: on 9 Aug production served a fresh index.html (imports `{ srcsetFor, SIZES }`
// from ./js/design-images.js) while a CDN edge kept handing out a day-old
// design-images.js that exported neither name. An ES module that fails to import
// does not degrade — it never runs at all — so the ONE script that draws the
// design rail and updates the celebrations counter died on its import line, and
// the whole store rendered empty. Root cause: a stable JS filename let a stale
// copy pair with new HTML.
//
// FIX: give every module a filename derived from its own bytes — /js/foo.<hash>.js
// — exactly the trick the self-hosted woff2 fonts already use (scripts/fetch-
// fonts.mjs). A new build yields a NEW url, so a stale cache can never be paired
// with new HTML. The mapping is published as an <script type="importmap"> injected
// into the (no-cache) HTML, so the map is always current and remaps EVERY module
// specifier — the entry `type="module" src=`, inline imports, and every intra-graph
// `./sibling.js` — without editing a single source file. Built once at boot; the
// only later filesystem touch is streaming a resolved file.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A hashed module url ends in `.<8 hex>.js` (or `.mjs`). Used both to route
// immutable requests and to keep such names out of the "must revalidate" bucket.
const HASH_RE = /\.[0-9a-f]{8}\.m?js$/;

function shortHash(buf) {
  // sha256, first 8 hex — same shape as the woff2 pipeline (fetch-fonts.mjs).
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

// Every .js/.mjs under <jsDir>, recursively, as absolute paths.
function listModules(jsDir) {
  const out = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (/\.m?js$/.test(e.name) && !HASH_RE.test(e.name)) out.push(full);
    }
  })(jsDir);
  return out;
}

// Build the manifest once. `siteDir` is the served static root (SITE_DIR); modules
// live under siteDir/js and are addressed by their ROOT-absolute url (/js/…), so
// the import map keys resolve identically from every page (/,/index.html,/collect…)
// and from inside a hashed module's own relative imports.
function build(siteDir) {
  const jsDir = path.join(siteDir, 'js');
  const forward = new Map(); // "/js/foo.js"        -> "/js/foo.<hash>.js"
  const reverse = new Map(); // "/js/foo.<hash>.js" -> absolute file path

  for (const file of listModules(jsDir)) {
    let hash;
    try {
      hash = shortHash(fs.readFileSync(file));
    } catch {
      continue;
    }
    const rel = path.relative(siteDir, file).split(path.sep).join('/'); // js/foo.js
    const logical = '/' + rel; // /js/foo.js
    const ext = path.extname(rel); // .js | .mjs
    const hashed = logical.slice(0, -ext.length) + '.' + hash + ext; // /js/foo.<hash>.js
    forward.set(logical, hashed);
    reverse.set(hashed, file);
  }

  const importMap = { imports: Object.fromEntries(forward) };
  const importMapTag = '<script type="importmap">' + JSON.stringify(importMap) + '</script>\n    ';

  // Map a hashed request path back to its real file (or null for an unknown hash).
  function resolveHashed(reqPath) {
    return reverse.get(reqPath) || null;
  }

  // Insert the import map immediately BEFORE the first module <script>. It must
  // precede any module load, and sitting right before the first one keeps it after
  // <meta charset> (the "charset in the first 1024 bytes" rule). Pages with no
  // module script are returned untouched — no module means no import to break.
  function inject(html) {
    if (!forward.size) return html;
    const m = html.match(/<script\b[^>]*\btype\s*=\s*["']?module["']?[^>]*>/i);
    if (!m) return html;
    return html.slice(0, m.index) + importMapTag + html.slice(m.index);
  }

  return { forward, reverse, importMap, importMapTag, resolveHashed, inject };
}

module.exports = { build, shortHash, listModules, HASH_RE };
