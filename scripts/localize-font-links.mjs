#!/usr/bin/env node
// Make every page load the self-hosted /assets/fonts/fonts.css instead of the
// Google Fonts CDN. In-app mobile browsers (Instagram/WhatsApp/Facebook) throttle
// or block fonts.gstatic.com, so any CDN dependency risks fallback text or a
// stalled first paint.
//
// Two jobs, walking site/ RECURSIVELY (so files under assets/ are covered too):
//   1. Pages that reference the CDN: strip the preconnect hints + the
//      preload/noscript CDN links and drop in the local stylesheet.
//   2. Pages that render brand text (they link /css/tokens.css, which defines
//      --font/--display) but never referenced the CDN: inject the local
//      stylesheet before tokens.css so the brand faces actually load.
//
// The local stylesheet is loaded NON-render-blocking (media="print" flipped to
// "all" onload) with a <noscript> fallback, so first paint never waits on it.
// Idempotent: re-running on an already-localized page is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const HREF = '/assets/fonts/fonts.css';
// Non-render-blocking load + no-JS fallback, matching the pattern the pages used
// for the Google stylesheet.
const BLOCK =
  `    <link rel="stylesheet" href="${HREF}" media="print" onload="this.media='all'" />\n` +
  `    <noscript><link rel="stylesheet" href="${HREF}" /></noscript>\n`;

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(abs));
    else if (e.name.endsWith('.html')) out.push(abs);
  }
  return out;
}

let changed = 0;
for (const abs of walk(SITE)) {
  let src = fs.readFileSync(abs, 'utf8');
  const before = src;
  const usesCdn = /fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src);

  if (usesCdn) {
    // 1. Drop the <noscript> Google-Fonts fallback block entirely.
    src = src.replace(
      /[ \t]*<noscript>\s*<link[^>]*fonts\.googleapis\.com[^>]*>\s*<\/noscript>\n?/gi,
      ''
    );
    // 2. Replace the FIRST CDN stylesheet link with the local (async) block;
    //    remove any further CDN links.
    let replaced = false;
    src = src.replace(/[ \t]*<link\b[^>]*fonts\.googleapis\.com[^>]*>\n?/gi, () => {
      if (replaced) return '';
      replaced = true;
      return BLOCK;
    });
    // 3. Drop the preconnect hints to the font hosts.
    src = src.replace(
      /[ \t]*<link[^>]*rel="preconnect"[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?/gi,
      ''
    );
  } else if (/\/css\/tokens\.css/.test(src) && !src.includes(HREF)) {
    // Brand page with no font stylesheet at all — inject before tokens.css so the
    // --font/--display faces load instead of the system fallback.
    src = src.replace(/([ \t]*<link[^>]*\/css\/tokens\.css[^>]*>\n)/i, BLOCK + '$1');
  }

  if (src !== before) {
    fs.writeFileSync(abs, src);
    changed++;
    console.log('localized', path.relative(SITE, abs));
  }
}
console.log(`done — ${changed} file(s) changed`);
