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
// into the (no-cache) HTML, so the map is always current and remaps every module
// specifier an `import` statement resolves — every intra-graph `./sibling.js` —
// without editing a single source file. Built once at boot; the only later
// filesystem touch is streaming a resolved file.
//
// AN IMPORT MAP IS NOT ENOUGH, and on 2 Sep production proved it. A map only
// resolves module SPECIFIERS: it never touches a `<script src>` (not even a module
// entry's src), and it has never heard of a stylesheet. So the four classic scripts
// (consent/header/editor/start-explainer), every module ENTRY point and every .css
// still went out under stable names — and Cloudflare rewrites their `no-cache` to
// `max-age=86400` and holds an edge copy far longer. Measured on the live site that
// day: the edge was serving a 26-day-old tokens.css (3.5KB against the current
// 9KB — no `.amt` isolate, so prices rendered "₪ 239 199") and a 26-day-old
// editor.js. Which copy a shopper got depended on their browser and their edge, so
// the site genuinely looked different in Instagram's webview than in Safari.
//
// Hence rewriteTags(): the SAME manifest, applied to the tags themselves. Every
// `<script src="js/…">` and `<link href="…css">` on a served page is swapped for its
// hashed twin, so a stale cached copy can never be paired with fresh HTML no matter
// what an edge does with our headers — a unique name is the only cache instruction
// that cannot be overridden.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// A hashed asset url ends in `.<8 hex>` before its extension. HASH_RE stays
// js-only (it is what the "must revalidate" bucket in index.js tests against);
// HASH_ANY_RE covers stylesheets too, and keeps already-hashed names from being
// hashed twice when the manifest is built.
const HASH_RE = /\.[0-9a-f]{8}\.m?js$/;
const HASH_ANY_RE = /\.[0-9a-f]{8}\.(m?js|css)$/;
// The files worth content-addressing: scripts and stylesheets, the two kinds a
// stale copy can break a page with.
const HASHABLE_RE = /\.(m?js|css)$/;

function shortHash(buf) {
  // sha256, first 8 hex — same shape as the woff2 pipeline (fetch-fonts.mjs).
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

// Every hashable file (.js/.mjs/.css) under <root>, recursively, as absolute paths.
// Already-hashed names are skipped so a rebuild never hashes a hash.
function listAssets(root) {
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
      else if (HASHABLE_RE.test(e.name) && !HASH_ANY_RE.test(e.name)) out.push(full);
    }
  })(root);
  return out;
}

// The directories we content-address, relative to the served root. `js` and `css`
// are the storefront's own; `assets/fonts` is there for fonts.css, which names the
// hashed woff2 files — a stale copy of it points at woff2 names a later
// fetch-fonts run may no longer serve. Everything else under assets/ (images,
// hundreds of them) is left alone: it is not walked, so boot stays cheap.
const ASSET_DIRS = ['js', 'css', 'assets/fonts'];

// Build the manifest once. `siteDir` is the served static root (SITE_DIR); assets
// are addressed by their ROOT-absolute url (/js/…, /css/…), so the import map keys
// resolve identically from every page (/,/index.html,/collect…) and from inside a
// hashed module's own relative imports.
function build(siteDir) {
  const forward = new Map(); // "/css/tokens.css"   -> "/css/tokens.<hash>.css"
  const reverse = new Map(); // "/js/foo.<hash>.js" -> absolute file path

  const files = ASSET_DIRS.flatMap((d) => listAssets(path.join(siteDir, d)));
  for (const file of files) {
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

  // ONLY modules belong in the import map — it resolves `import` specifiers, and a
  // stylesheet is never one. Stylesheets ride the tag rewrite below instead.
  const importMap = {
    imports: Object.fromEntries([...forward].filter(([logical]) => /\.m?js$/.test(logical))),
  };
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

  // Swap every `<script src>` / stylesheet `<link href>` that points at an asset we
  // hashed for its hashed url. This is what protects the tags an import map cannot
  // reach: the classic scripts, the module ENTRY points, and the stylesheets.
  //
  // Deliberately narrow, because this rewrites bytes on every page we serve:
  //   • Only src=/href= attribute values, matched with the quotes around them, so
  //     the same string sitting in prose or in an inline script is untouched.
  //   • Only OUR paths. A value is normalised to root-absolute (`js/x.js` and
  //     `/js/x.js` are the same asset) and then has to be a key in the manifest —
  //     which no absolute url can be, so Google Fonts, the Cloudflare injections and
  //     any CDN pass straight through.
  //   • A value carrying a query or fragment is left alone: it is asking for
  //     something specific, and a hashed name would drop it.
  function rewriteTags(html) {
    if (!forward.size) return html;
    return html.replace(/\b(src|href)=("|')([^"'>]+)\2/gi, (whole, attr, q, value) => {
      if (/^[a-z][a-z0-9+.-]*:|^\/\/|[?#]/i.test(value)) return whole;
      const logical = value.startsWith('/') ? value : '/' + value.replace(/^\.\//, '');
      const hashed = forward.get(logical);
      return hashed ? attr + '=' + q + hashed + q : whole;
    });
  }

  return { forward, reverse, importMap, importMapTag, resolveHashed, inject, rewriteTags };
}

module.exports = { build, shortHash, listAssets, HASH_RE, HASH_ANY_RE };
