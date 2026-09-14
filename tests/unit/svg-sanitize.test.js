// @vitest-environment jsdom
//
// sanitizeSvgForDom (server/routes/catalog.js) runs before either template SVG
// route (/api/template-image/…, /api/admin/templates/:key/asset-svg/:role) answers.
// Both answer image/svg+xml, and the only way such a response becomes a live
// document is a direct open, which the browser parses as XML. No production path
// hands these responses to an HTML parser (pages use <img src>; the admin checklist
// parses with DOMParser as XML and runs its own allowlist). So the sanitizer
// targets the XML parser, and every attack here is judged by what DOMParser
// (image/svg+xml) builds from the output — nothing is claimed about innerHTML.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..', '..');

const { sanitizeSvgForDom: sanitize } = require(path.join(repo, 'server', 'routes', 'catalog.js'));

const BLOCKED = ['script', 'foreignobject', 'iframe', 'embed', 'object', 'frame', 'frameset'];

// Threats read off the raw string, for output the XML parser rejects. A parse error
// does NOT make a document safe: Chromium runs a script that comes before the first
// fatal error (`<svg><script>alert()</script><g a="<"/></svg>` fires), so a
// malformed tail must never let everything before it count as clean.
function stringThreats(markup) {
  const found = [];
  const blocked = new RegExp('<(?:[^\\s<>/:=]+:)?(?:' + BLOCKED.join('|') + ')[\\s/>]', 'gi');
  for (const m of markup.match(blocked) || []) found.push(m);
  for (const m of markup.match(/[\s"'/]on[a-z]+\s*=/gi) || []) found.push(m.trim());
  const decoded = markup
    .replace(/&#x([0-9a-f]+);?/gi, (m, h) => String.fromCodePoint(parseInt(h, 16) % 0x110000))
    .replace(/&#(\d+);?/g, (m, d) => String.fromCodePoint(parseInt(d, 10) % 0x110000))
    .replace(/[\x00-\x20\x7f-\x9f]+/g, '')
    .toLowerCase();
  if (/(?:java|vb)script:/.test(decoded)) found.push('javascript:');
  return found;
}

// Everything executable the XML parser left in the tree. Attribute values come back
// entity-decoded; the URL parser also drops ASCII whitespace and control
// characters, so those are removed before looking for the scheme.
function xmlThreats(markup) {
  const doc = new window.DOMParser().parseFromString(markup, 'image/svg+xml');
  // Not well-formed: judge the bytes instead (see stringThreats).
  if (doc.getElementsByTagName('parsererror').length) return stringThreats(markup);
  const found = [];
  for (const el of Array.from(doc.getElementsByTagName('*'))) {
    const tag = el.localName.toLowerCase();
    if (BLOCKED.includes(tag)) found.push('<' + tag + '>');
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.localName)) found.push(tag + ' @' + a.name);
      const v = a.value.replace(/[\x00-\x20\x7f-\x9f]+/g, '').toLowerCase();
      if (/(?:java|vb)script:/.test(v)) found.push(tag + ' @' + a.name + '=' + a.value);
    }
  }
  return found;
}

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';
const XHTML = 'xmlns="http://www.w3.org/1999/xhtml"';

// [name, input]. Every input is well-formed XML and is checked to be LIVE under
// DOMParser before sanitizing, so no case can pass by being harmless to begin with.
const ATTACKS = [
  // Frames in the XHTML namespace load a document (a data:text/html one runs script)
  [
    'XHTML frame with a data:text/html src',
    `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:frame src="data:text/html,&lt;script&gt;alert(1)&lt;/script&gt;"/></svg>`,
  ],
  [
    'XHTML frameset holding a frame',
    `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:frameset><h:frame src="https://example.com/"/></h:frameset></svg>`,
  ],

  // Event handlers
  ['handler, double quotes', `<svg ${NS}><g onload="alert(1)"/></svg>`],
  ['handler, single quotes', `<svg ${NS}><g onclick='alert(1)'/></svg>`],
  ['handler, spaces around =', `<svg ${NS}><rect onmouseover = "alert(1)"/></svg>`],
  ['handler on a new line', `<svg ${NS}><rect\nonclick="alert(1)"/></svg>`],
  [
    'animation handler',
    `<svg ${NS}><animate onbegin="alert(1)" attributeName="x" dur="1s"/></svg>`,
  ],
  ['handler on the root', `<svg ${NS} onload="alert(1)"><rect/></svg>`],

  // Nothing is raw text in XML: <style> and <title> hold elements like any parent.
  ['script inside <style>', `<svg ${NS}><style><script>alert(1)</script></style></svg>`],
  [
    'handler inside <style>',
    `<svg ${NS}><style><image href="x" onerror="alert(2)"/></style></svg>`,
  ],
  [
    'set to=javascript: inside <style>',
    `<svg ${NS}><style><set attributeName="href" to="javascript:alert(3)"/></style></svg>`,
  ],
  [
    'the review payload: script + handler + set inside <style>',
    `<svg ${NS}><style><script>alert(1)</script><image href="x" onerror="alert(2)"/><set attributeName="href" to="javascript:alert(3)"/></style></svg>`,
  ],
  ['script inside <title>', `<svg ${NS}><title><script>alert(1)</script></title></svg>`],
  ['script after a comment', `<svg ${NS}><!-- x --><script>alert(1)</script></svg>`],
  [
    'script after CDATA',
    `<svg ${NS}><style><![CDATA[.a{}]]></style><script>alert(1)</script></svg>`,
  ],

  // Script-capable elements
  ['script block', `<svg ${NS}><script>alert(1)</script><rect/></svg>`],
  ['self-closing script', `<svg ${NS}><script href="x.js"/><rect/></svg>`],
  ['upper-case SCRIPT', `<svg ${NS}><SCRIPT>alert(1)</SCRIPT></svg>`],
  [
    'namespace-prefixed script',
    `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
  ],
  [
    'non-ASCII prefix script (é, SVG namespace)',
    `<svg ${NS} xmlns:é="http://www.w3.org/2000/svg"><é:script>alert(1)</é:script></svg>`,
  ],
  [
    'non-ASCII prefix iframe (ש, XHTML namespace)',
    `<svg ${NS} xmlns:ש="http://www.w3.org/1999/xhtml"><ש:iframe src="https://example.com/"></ש:iframe></svg>`,
  ],
  [
    'foreignObject',
    `<svg ${NS}><foreignObject width="9" height="9"><div ${XHTML}>x</div></foreignObject></svg>`,
  ],
  [
    'foreignObject carrying an HTML handler',
    `<svg ${NS}><foreignObject><img ${XHTML} src="x" onerror="alert(1)"/></foreignObject></svg>`,
  ],
  [
    'iframe',
    `<svg ${NS}><foreignObject><iframe ${XHTML} src="https://example.com/"/></foreignObject></svg>`,
  ],
  ['embed', `<svg ${NS}><embed ${XHTML} src="https://example.com/x.swf"/></svg>`],
  ['object', `<svg ${NS}><object ${XHTML} data="https://example.com/x.html"></object></svg>`],

  // javascript: URLs
  ['xlink:href', `<svg ${NS}><a xlink:href="javascript:alert(1)"><rect/></a></svg>`],
  ['href, mixed case', `<svg ${NS}><a href="JaVaScRiPt:alert(1)"><rect/></a></svg>`],
  ['href, leading spaces', `<svg ${NS}><a href="  javascript:alert(1)"><rect/></a></svg>`],
  [
    'href, leading newline reference',
    `<svg ${NS}><a href="&#10;javascript:alert(1)"><rect/></a></svg>`,
  ],
  ['href, single quotes', `<svg ${NS}><a href='javascript:alert(1)'><rect/></a></svg>`],
  ['href, decimal reference', `<svg ${NS}><a href="&#106;avascript:alert(1)"><rect/></a></svg>`],
  ['href, hex reference', `<svg ${NS}><a href="&#x6A;avascript:alert(1)"><rect/></a></svg>`],
  ['href, tab reference', `<svg ${NS}><a href="java&#x09;script:alert(1)"><rect/></a></svg>`],
  [
    'href under another xlink prefix',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript:alert(1)"><rect/></a></svg>`,
  ],
  [
    '<set to>',
    `<svg ${NS}><a><set attributeName="href" to="javascript:alert(1)"/><rect/></a></svg>`,
  ],
  [
    '<animate values>',
    `<svg ${NS}><a><animate attributeName="href" values="#a;javascript:alert(1)"/><rect/></a></svg>`,
  ],
];

describe('the threat helper itself', () => {
  it('flags a script that precedes a fatal XML error instead of calling it clean', () => {
    expect(xmlThreats('<svg><script>alert()</script><g a="<"/></svg>')).not.toEqual([]);
  });
  it('flags a handler, a javascript: URL and a frame in malformed output', () => {
    expect(xmlThreats('<svg><g onload="x()"><a href="&#106;avascript:x"></svg')).toEqual(
      expect.arrayContaining(['onload=', 'javascript:'])
    );
    expect(xmlThreats('<svg><h:frame src="x"/><g a="<"/></svg>').length).toBeGreaterThan(0);
  });
  it('does not flag harmless malformed text', () => {
    expect(xmlThreats('<svg><text>turn on = off<')).toEqual([]);
  });
});

describe('sanitizeSvgForDom — attacks, judged by the XML parser', () => {
  it.each(ATTACKS)('%s', (_name, input) => {
    expect(xmlThreats(input).length).toBeGreaterThan(0);
    expect(xmlThreats(sanitize(input))).toEqual([]);
  });

  it('keeps the rest of the document well-formed and drawing', () => {
    const out = sanitize(
      `<svg ${NS}><style><script>alert(1)</script>.a{fill:red}</style><rect id="keep" onclick="x()"/></svg>`
    );
    const doc = new window.DOMParser().parseFromString(out, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.getElementById('keep')).not.toBeNull();
    expect(doc.getElementsByTagName('style')[0].textContent).toBe('.a{fill:red}');
  });
});

// DTD entity expansion: libxml2 (Chrome's SVG XML parser) expands DOCTYPE entities,
// jsdom does not, so the parser check above cannot see it. The defence is to remove
// the DOCTYPE, leaving nothing to define an entity. Judged on the output string.
describe('sanitizeSvgForDom — DTDs and processing instructions', () => {
  it('strips a DOCTYPE whose entities expand into a script and a javascript: href', () => {
    const input =
      '<!DOCTYPE svg [<!ENTITY x "&#60;script xmlns=&#34;http://www.w3.org/2000/svg&#34;&#62;alert(1)&#60;/script&#62;">' +
      '<!ENTITY j "javascript:alert(1)">]>' +
      '<svg xmlns="http://www.w3.org/2000/svg">&x;<a xlink:href="&j;"><rect/></a></svg>';
    const out = sanitize(input);
    expect(out).not.toMatch(/<!DOCTYPE/i);
    expect(out).not.toMatch(/<!ENTITY/i);
    expect(out).not.toContain(']>');
    expect(out).toContain('<svg');
  });

  it('strips <?xml-stylesheet?> but keeps a plain <?xml?> declaration', () => {
    const styled = sanitize('<?xml-stylesheet href="x.xsl" type="text/xsl"?><svg><rect/></svg>');
    expect(styled).not.toMatch(/xml-stylesheet/i);
    expect(styled).toContain('<svg>');
    const plain =
      '<?xml version="1.0" encoding="UTF-8"?><svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
    expect(sanitize(plain)).toBe(plain);
  });
});

// Malformed input fails safe: no blocked element survives even when the markup is
// not well-formed (the XML parser would render nothing, but the bytes still must
// not carry a script).
describe('sanitizeSvgForDom — malformed input', () => {
  it.each([
    ['an unclosed <script', '<svg><script>alert(1)'],
    ['an unclosed <script tag', '<svg><script src="x"'],
    ['a tag that never closes', '<svg><rect x="1"<script>alert(1)</script>'],
  ])('%s', (_name, input) => {
    expect(sanitize(input)).not.toMatch(/<script/i);
  });
});

// Real artwork must come out BYTE-IDENTICAL: a changed byte in a base64 image is a
// broken card.
const ARTWORK = [
  [
    'gradients, clip paths, masks and <use href="#id">',
    `<svg ${NS} width="223.92" height="312" viewBox="0 0 223.92 312"><defs>` +
      `<linearGradient id="g1" x1="0" y1="0" x2="1" y2="1" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#711d20"/><stop offset="1" stop-color="#fff" stop-opacity="0.5"/></linearGradient>` +
      `<radialGradient id="g2" cx="0.5" cy="0.5" r="0.5"><stop offset="0" stop-color="#000"/></radialGradient>` +
      `<clipPath id="c1"><path d="M0 0h10v10H0z" clip-rule="nonzero"/></clipPath>` +
      `<mask id="m1" maskUnits="userSpaceOnUse"><rect width="10" height="10" fill="#fff"/></mask>` +
      `<filter id="f1" x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB"><feFlood flood-color="#fff" result="white"/><feComposite in="white" in2="SourceAlpha" operator="in"/></filter>` +
      `</defs><g clip-path="url(#c1)" mask="url(#m1)" filter="url(#f1)"><use href="#c1"/><use xlink:href="#g1" x="2"/><rect fill="url(#g1)" transform="matrix(1 0 0 1 0 0)"/></g></svg>`,
  ],
  [
    'embedded PNG whose base64 contains "/on…=" padding',
    `<svg ${NS}><image width="4" height="4" preserveAspectRatio="none" xlink:href="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/onAB=="/><image href="data:image/jpeg;base64,/9j/4AAQSkZJRg/ONload=="/></svg>`,
  ],
  [
    'an inline <style> with an embedded font',
    `<svg ${NS}><style>@font-face{font-family:"Tpl";src:url(data:font/ttf;base64,AAEAAA==) format("truetype")} .t{font-family:Tpl;font-weight:300}</style><text class="t" x="1" y="2" font-family="Montserrat">button onion</text></svg>`,
  ],
  [
    'the de-duplicated background reference',
    `<svg><image xlink:href="/api/template-asset/x/y.png"/><rect fill="#711d20"/></svg>`,
  ],
  [
    'Hebrew title and an ordinary link',
    `<svg ${NS}><title>דוגרי — כרטיס</title><a href="https://dugri-israel.co.il/products.html"><rect/></a></svg>`,
  ],
  // Only tag interiors are scanned for attributes, so character data that reads like
  // a handler is left alone and the card stays valid XML.
  ['text that reads like a handler', `<svg ${NS}><text>turn on = off</text></svg>`],
  ['a comment and CDATA', `<svg ${NS}><!-- on=1 --><style><![CDATA[.a{}]]></style></svg>`],
];

// Real template files from the repo, whole: <use>, filters, masks, gradients, many
// embedded rasters (neon front: 5MB, 50 images), and a de-duplicated card.
const REAL_FILES = [
  'resources/canva/templates/_shared/photo-card/photo.svg',
  'resources/canva/templates/_shared/photo-fallback/1.svg',
  'resources/canva/templates/grapefruit/clean/photo.svg',
  'resources/canva/templates/grapefruit/filled/2.svg',
  'resources/canva/templates/bachelorette/filled/fronts.svg',
  'resources/canva/staging/japanese/board.svg',
  'resources/canva/staging/neon/front.svg',
];

describe('sanitizeSvgForDom — real artwork is unchanged', () => {
  it.each(ARTWORK)('%s', (_name, art) => {
    expect(sanitize(art)).toBe(art);
  });

  it.each(REAL_FILES)('%s', (rel) => {
    const art = fs.readFileSync(path.join(repo, rel), 'utf8');
    const out = sanitize(art);
    // Compare lengths first so a failure does not print megabytes of SVG.
    expect(out.length).toBe(art.length);
    expect(out === art).toBe(true);
  });

  it('leaves a card that reads like a handler as valid XML', () => {
    const art = `<svg ${NS}><text>turn on = off</text></svg>`;
    const doc = new window.DOMParser().parseFromString(sanitize(art), 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.documentElement.textContent).toBe('turn on = off');
  });
});

// Linear time. Each shape is one the review measured or one that would make a
// scanner rescan: a run of unclosed tags ("<a" x 64k took 29.8s before), "<"s that
// start no name, unterminated quotes, comments, CDATA, PIs, declarations, blocked
// elements with no close, and the earlier handler/unclosed-script/re-forming
// shapes. Each must finish well under 100ms (they take a few ms).
describe('sanitizeSvgForDom — linear on adversarial input', () => {
  const LIMIT_MS = 100;
  const R = 64000;
  const SHAPES = [
    ['"<a" x 64k (unclosed tags)', '<a'.repeat(R)],
    ['"<a " x 64k', '<a '.repeat(R)],
    ['"< " x 64k then ">"', '< '.repeat(R) + '>'],
    ['"<a x=\\"" x 64k (unterminated quotes)', '<a x="'.repeat(R)],
    ['"<a>" x 64k (well-formed)', '<a>'.repeat(R)],
    ['"</" x 64k', '</'.repeat(R)],
    ['"<!--" x 64k', '<!--'.repeat(R)],
    ['"<![CDATA[" x 64k', '<![CDATA['.repeat(R)],
    ['"<?" x 64k', '<?'.repeat(R)],
    ['"<!" x 64k', '<!'.repeat(R)],
    ['"<script>" x 64k (never closed)', '<script>'.repeat(R)],
    ['"<script></x>" x 64k', '<script></x>'.repeat(R)],
    ['"<script></script>" x 64k', '<script></script>'.repeat(R)],
    ['"on " x 60k inside a tag', '<svg ' + 'on '.repeat(60000) + '><rect/></svg>'],
    ['an unclosed <script of 640KB', '<svg><script ' + 'a'.repeat(640000)],
    [
      're-forming "<scri…pt>" around a script',
      '<svg>' +
        '<scri'.repeat(20000) +
        '<script>alert(1)</script>' +
        'pt>'.repeat(20000) +
        '</svg>',
    ],
  ];

  it.each(SHAPES)('%s', (_name, input) => {
    sanitize('<svg><rect/></svg>'); // warm up the JIT so the first shape is not penalised
    // Best of five: the question is whether the algorithm is linear, and a busy CI
    // worker can stall any single run; a super-linear shape is slow on every run.
    let ms = Infinity;
    let out = '';
    for (let run = 0; run < 5; run++) {
      const t0 = Date.now();
      out = sanitize(input);
      ms = Math.min(ms, Date.now() - t0);
    }
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(xmlThreats(out)).toEqual([]);
  });
});
