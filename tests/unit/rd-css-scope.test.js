// @vitest-environment node
//
// EVERY RULE UNDER site/css/rd/ IS SCOPED TO html.rd. Those files are the
// redesign restyles of the existing pages, one per page plus chrome.css for the
// shared header and consent chip, and every domain agent writes them. The gate
// (server/redesign-gate.js) links them only in redesign mode, but the scope is the
// second guard: a rule that also matched out of the mode would change the live
// site the moment the file was linked anywhere else, so it is refused here,
// whoever's file it is.
//
// The walk is deliberately small: comments stripped, then each top-level rule's
// selectors checked; @media / @supports / @container / @layer blocks are entered
// and checked the same way; @keyframes is allowed (it styles nothing by itself).
// Rules nested inside a scoped rule inherit its scope and are not re-checked.
// Anything else at the top (@font-face, @import, @property…) is refused: fonts
// and globals belong to the shell, redesign.css.
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RD_DIR = path.join(__dirname, '..', '..', 'site', 'css', 'rd');

const SCOPED = /^html\.rd(?![\w-])/;
const ENTER = /^@(media|supports|container|layer)\b/i;
const ALLOW = /^@(-webkit-)?keyframes\b/i;

// The index of the "}" that closes the block opened at `open`.
function blockEnd(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  return css.length;
}

// Split a selector list on its top-level commas (not those inside :is(), :not()…).
function splitSelectors(prelude) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// Every problem in one stylesheet, as readable lines.
function scopeProblems(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const problems = [];
  (function walk(from, to) {
    let i = from;
    while (i < to) {
      const open = css.indexOf('{', i);
      const semi = css.indexOf(';', i);
      const blockAt = open === -1 || open >= to ? to : open;
      if (semi !== -1 && semi < blockAt) {
        const stmt = css.slice(i, semi).trim();
        if (stmt) problems.push('statement outside a scoped rule: ' + stmt);
        i = semi + 1;
        continue;
      }
      if (blockAt === to) {
        const rest = css.slice(i, to).trim();
        if (rest) problems.push('stray text: ' + rest.slice(0, 60));
        return;
      }
      const prelude = css.slice(i, open).trim().replace(/\s+/g, ' ');
      const end = blockEnd(css, open);
      if (prelude.startsWith('@')) {
        if (ENTER.test(prelude)) walk(open + 1, end);
        else if (!ALLOW.test(prelude)) problems.push('at-rule not allowed here: ' + prelude);
      } else {
        for (const sel of splitSelectors(prelude)) {
          if (!SCOPED.test(sel)) problems.push('selector not under html.rd: ' + sel);
        }
      }
      i = end + 1;
    }
  })(0, css.length);
  return problems;
}

const rdFiles = (() => {
  try {
    return fs
      .readdirSync(RD_DIR, { recursive: true })
      .filter((f) => String(f).endsWith('.css'))
      .map((f) => path.join(RD_DIR, String(f)));
  } catch {
    return [];
  }
})();

describe('the scope check itself', () => {
  it('passes scoped rules, media blocks, keyframes and nesting', () => {
    expect(
      scopeProblems(`
        /* a comment { with braces } */
        html.rd h1, html.rd .x:not(.a, .b) { color: red; }
        html.rd.rd-native body { margin: 0 }
        html.rd:not(.rd-native) .btn { & span { color: blue } }
        @media (min-width: 900px) { html.rd .wrap { max-width: 1040px } }
        @supports (display: grid) { @media print { html.rd p { color: #000 } } }
        @keyframes rd-pop { from { opacity: 0 } to { opacity: 1 } }
      `)
    ).toEqual([]);
  });

  it('refuses anything that could match out of the mode', () => {
    expect(
      scopeProblems(`
        h1 { color: red }
        html.rd h1, .btn { color: red }
        html.rdx p { color: red }
        :root { --x: 1 }
        html .rd p { color: red }
        @media (min-width: 900px) { body { margin: 0 } }
        @font-face { font-family: X; src: url(x.woff2) }
        @import url(x.css);
      `)
    ).toEqual([
      'selector not under html.rd: h1',
      'selector not under html.rd: .btn',
      'selector not under html.rd: html.rdx p',
      'selector not under html.rd: :root',
      'selector not under html.rd: html .rd p',
      'selector not under html.rd: body',
      'at-rule not allowed here: @font-face',
      'statement outside a scoped rule: @import url(x.css)',
    ]);
  });
});

describe('site/css/rd/', () => {
  it('every rule in every file is scoped to html.rd', () => {
    const report = rdFiles
      .map((f) => [path.relative(RD_DIR, f), scopeProblems(fs.readFileSync(f, 'utf8'))])
      .filter(([, p]) => p.length)
      .map(([f, p]) => f + ':\n  ' + p.join('\n  '));
    expect(report.join('\n')).toBe('');
  });
});
