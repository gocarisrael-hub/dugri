#!/usr/bin/env node
// Rewrite every page's <head> to load the self-hosted /assets/fonts/fonts.css
// instead of the Google Fonts CDN. Removes the preconnect hints, the
// media="print" preload link, and the <noscript> fallback — all pointing at
// fonts.googleapis.com / fonts.gstatic.com — and drops in ONE local stylesheet.
// Idempotent: re-running on an already-localized page is a no-op.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const LOCAL = '    <link rel="stylesheet" href="/assets/fonts/fonts.css" />';

const files = fs.readdirSync(SITE).filter((f) => f.endsWith('.html'));
let changed = 0;
for (const f of files) {
  const abs = path.join(SITE, f);
  let src = fs.readFileSync(abs, 'utf8');
  if (!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(src)) continue;
  const before = src;

  // 1. Drop the <noscript> Google-Fonts fallback block entirely.
  src = src.replace(
    /[ \t]*<noscript>\s*<link[^>]*fonts\.googleapis\.com[^>]*>\s*<\/noscript>\n?/gi,
    ''
  );
  // 2. Replace the primary stylesheet link (with or without media/onload) with
  //    the local one — only the FIRST such link becomes the local stylesheet.
  let replacedPrimary = false;
  src = src.replace(/[ \t]*<link\b[^>]*fonts\.googleapis\.com[^>]*>\n?/gi, (m) => {
    if (replacedPrimary) return '';
    replacedPrimary = true;
    return LOCAL + '\n';
  });
  // 3. Drop the preconnect hints to the font hosts.
  src = src.replace(
    /[ \t]*<link[^>]*rel="preconnect"[^>]*fonts\.(?:googleapis|gstatic)\.com[^>]*>\n?/gi,
    ''
  );

  if (src !== before) {
    fs.writeFileSync(abs, src);
    changed++;
    console.log('localized', f);
  }
}
console.log(`done — ${changed} file(s) changed`);
