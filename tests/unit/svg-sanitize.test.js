// @vitest-environment jsdom
//
// sanitizeSvgForDom (server/routes/catalog.js) is what the two template SVG routes
// run before a card SVG reaches a page:
//   - GET /api/admin/templates/:key/asset-svg/:role — the admin checklist puts it
//     in the DOM with `thumb.innerHTML = svg` (HTML parser, admin session);
//   - GET /api/template-image/:slug/:slot — served as image/svg+xml, so opening the
//     URL directly parses it as an XML document on the site's own origin.
//
// So every case is judged by what a REAL parser builds from the output, in both
// modes, not by string matching: an attack passes only if no script-capable
// element, no on* attribute and no javascript: URL survives into the DOM.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(__dirname, '..', '..');

const { sanitizeSvgForDom: sanitize } = require(path.join(repo, 'server', 'routes', 'catalog.js'));

const BLOCKED = ['script', 'foreignobject', 'iframe', 'embed', 'object'];

// Everything executable a parser left in the tree. Attribute values come back
// entity-decoded from the DOM; the URL parser also drops ASCII whitespace and
// control characters, so they are removed before looking for the scheme.
function threatsIn(elements) {
  const found = [];
  for (const el of elements) {
    const tag = el.localName.toLowerCase();
    if (BLOCKED.includes(tag)) found.push('<' + tag + '>');
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.localName)) found.push(tag + ' @' + a.name);
      const v = a.value.replace(/[\u0000-\u0020\u007f-\u009f]+/g, '').toLowerCase();
      if (/(?:java|vb)script:/.test(v)) found.push(tag + ' @' + a.name + '=' + a.value);
    }
  }
  return found;
}

// The admin thumbnail path, exactly: a <span> whose innerHTML is the response.
function htmlThreats(markup) {
  const host = document.createElement('span');
  host.innerHTML = markup;
  return threatsIn(host.querySelectorAll('*'));
}

// Opening /api/template-image/... directly: an image/svg+xml document. A document
// that is not well-formed renders nothing, so a parse error is not a threat.
function xmlThreats(markup) {
  const doc = new window.DOMParser().parseFromString(markup, 'image/svg+xml');
  if (doc.getElementsByTagName('parsererror').length) return [];
  return threatsIn(doc.getElementsByTagName('*'));
}

const NS = 'xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"';

// [name, input]. Each input is checked to be a live threat BEFORE sanitizing, so a
// case can never pass by being harmless to begin with.
const ATTACKS = [
  // Event handlers
  ['quoted handler (double)', `<svg ${NS}><g onload="alert(1)"/></svg>`],
  ['quoted handler (single)', `<svg ${NS}><g onclick='alert(1)'/></svg>`],
  ['unquoted handler', `<svg><g onload=alert(1)><rect/></g></svg>`],
  ['unquoted handler, upper case', `<svg ONLOAD=alert(1)><rect/></svg>`],
  ['handler after the tag name and a slash', `<svg/onload=alert(1)><rect/></svg>`],
  ['handler after an attribute name and a slash', `<svg x/onload=alert(1)><rect/></svg>`],
  ['handler glued to a quoted value', `<svg><rect id="a"onclick="alert(1)"/></svg>`],
  ['handler with spaces around =', `<svg ${NS}><rect onmouseover = "alert(1)"/></svg>`],
  ['handler on a new line', `<svg ${NS}><rect\nonclick="alert(1)"/></svg>`],
  ['animation handler', `<svg><animate onbegin=alert(1) attributeName=x dur=1s /></svg>`],
  // A stray "=" starts a fresh attribute name for the HTML parser, so the handler
  // after it is live even though the walk-back used to stop at "=".
  ['handler after a stray = (img)', `<svg><img src=x =/onerror=alert(1)></svg>`],
  ['handler after a stray = (a)', `<svg><a=/onmouseover=alert(1)>x</a></svg>`],
  [
    'handler hidden from a tag-aware scan by an HTML breakout',
    `<svg><p><style><g title="</style><img src=x onerror=alert(1)>"></g></style></p></svg>`,
  ],

  // Script-capable elements
  ['script block', `<svg ${NS}><script>alert(1)</script><rect/></svg>`],
  ['self-closing script', `<svg ${NS}><script href="x.js"/><rect/></svg>`],
  ['unclosed script', `<svg><script>alert(1)`],
  ['upper-case script', `<svg ${NS}><SCRIPT>alert(1)</SCRIPT></svg>`],
  [
    'namespace-prefixed script',
    `<svg ${NS} xmlns:s="http://www.w3.org/2000/svg"><s:script>alert(1)</s:script></svg>`,
  ],
  // A Unicode namespace prefix: an ASCII-only prefix pattern missed these.
  [
    'non-ASCII prefix script (é, SVG ns)',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:é="http://www.w3.org/2000/svg"><é:script>alert(1)</é:script></svg>`,
  ],
  [
    'non-ASCII prefix iframe (ש, XHTML ns)',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:ש="http://www.w3.org/1999/xhtml"><ש:iframe src="https://example.com/"></ש:iframe></svg>`,
  ],
  [
    'foreignObject',
    `<svg ${NS}><foreignObject width="9" height="9"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>`,
  ],
  [
    'foreignObject carrying HTML',
    `<svg><foreignObject><img src=x onerror="alert(1)"></foreignObject></svg>`,
  ],
  [
    'iframe',
    `<svg><foreignObject><iframe src="https://example.com/"></iframe></foreignObject></svg>`,
  ],
  ['embed', `<svg><embed src="https://example.com/x.swf"></svg>`],
  ['object', `<svg><object data="https://example.com/x.html"></object></svg>`],

  // javascript: URLs
  ['javascript: xlink:href', `<svg ${NS}><a xlink:href="javascript:alert(1)"><rect/></a></svg>`],
  ['javascript: href, mixed case', `<svg ${NS}><a href="JaVaScRiPt:alert(1)"><rect/></a></svg>`],
  [
    'javascript: href, leading whitespace',
    `<svg ${NS}><a href="  javascript:alert(1)"><rect/></a></svg>`,
  ],
  [
    'javascript: href, leading newline',
    `<svg ${NS}><a href="\njavascript:alert(1)"><rect/></a></svg>`,
  ],
  ['javascript: href, single quotes', `<svg ${NS}><a href='javascript:alert(1)'><rect/></a></svg>`],
  ['javascript: href, unquoted', `<svg><a href=javascript:alert(1)><rect/></a></svg>`],
  [
    'javascript: href, decimal entity',
    `<svg ${NS}><a href="&#106;avascript:alert(1)"><rect/></a></svg>`,
  ],
  [
    'javascript: href, hex entity',
    `<svg ${NS}><a href="&#x6A;avascript:alert(1)"><rect/></a></svg>`,
  ],
  [
    'javascript: href, entity without semicolon',
    `<svg><a href="&#106avascript:alert(1)"><rect/></a></svg>`,
  ],
  ['javascript: href, &colon;', `<svg><a href="javascript&colon;alert(1)"><rect/></a></svg>`],
  [
    'javascript: href, tab entity',
    `<svg ${NS}><a href="java&#x09;script:alert(1)"><rect/></a></svg>`,
  ],
  [
    'javascript: href under another xlink prefix',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:x="http://www.w3.org/1999/xlink"><a x:href="javascript:alert(1)"><rect/></a></svg>`,
  ],
  [
    'javascript: via <set to>',
    `<svg ${NS}><a><set attributeName="href" to="javascript:alert(1)"/><rect/></a></svg>`,
  ],
  [
    'javascript: via <animate values>',
    `<svg ${NS}><a><animate attributeName="href" values="#a;javascript:alert(1)"/><rect/></a></svg>`,
  ],
];

describe('sanitizeSvgForDom — attacks', () => {
  it.each(ATTACKS)('%s', (_name, input) => {
    // Precondition: the case really is live in at least one of the two parsers.
    expect([...htmlThreats(input), ...xmlThreats(input)].length).toBeGreaterThan(0);
    const out = sanitize(input);
    expect({ html: htmlThreats(out), xml: xmlThreats(out) }).toEqual({ html: [], xml: [] });
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
  // Character data, including "on" and a bare "=", is never scanned for
  // attributes — only tag interiors are — so a title reading like a handler is
  // left intact and the card stays valid XML (a previous version cut through the
  // closing tag and blanked the whole card).
  ['text that reads like a handler', `<svg ${NS}><text>turn on = off</text></svg>`],
  [
    'a comment and CDATA are inert and kept',
    `<svg ${NS}><!-- on=1 --><style><![CDATA[.a{}]]></style></svg>`,
  ],
];

// Real template files from the repo, whole. Chosen to cover <use>, filters, masks,
// gradients and many embedded data:image rasters (neon front: 5MB, 50 images).
const REAL_FILES = [
  'resources/canva/templates/_shared/photo-card/photo.svg',
  'resources/canva/templates/_shared/photo-fallback/1.svg',
  'resources/canva/templates/grapefruit/clean/photo.svg',
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

  it('leaves a card that reads like a handler as valid, unchanged XML', () => {
    const art = `<svg ${NS}><text>turn on = off</text></svg>`;
    const out = sanitize(art);
    expect(out).toBe(art);
    const doc = new window.DOMParser().parseFromString(out, 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror').length).toBe(0);
    expect(doc.documentElement.textContent).toBe('turn on = off');
  });
});

// DTD entity expansion: libxml2 (Chrome's SVG XML parser) expands DOCTYPE
// entities, jsdom does not — which is why the parser-judged cases above can't see
// this one. The defence is to remove the DOCTYPE entirely, so there is nothing
// left to define an entity. Judged on the output string.
describe('sanitizeSvgForDom — DTDs and processing instructions are refused', () => {
  it('strips a DOCTYPE whose entities expand into a script and a javascript: href', () => {
    const input =
      '<!DOCTYPE svg [<!ENTITY x "&#60;script xmlns=&#34;http://www.w3.org/2000/svg&#34;&#62;alert(1)&#60;/script&#62;">' +
      '<!ENTITY j "javascript:alert(1)">]>' +
      '<svg xmlns="http://www.w3.org/2000/svg">&x;<a xlink:href="&j;"><rect/></a></svg>';
    const out = sanitize(input);
    expect(out).not.toMatch(/<!DOCTYPE/i);
    expect(out).not.toMatch(/<!ENTITY/i);
    // The internal subset's "]" and ">" are consumed with the declaration.
    expect(out).not.toContain(']>');
    // The body survives; with no DTD, "&x;"/"&j;" are now undefined entities, so
    // libxml2 errors instead of expanding them into live nodes.
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

// Every crafted input the review flagged as super-linear must finish in near-
// linear time. Generous ceilings (real machines vary); the point is that none is
// the multi-second blow-up the old passes showed (5.9s / 3.7s), not a tight
// benchmark.
describe('sanitizeSvgForDom — linear on adversarial input', () => {
  const LIMIT_MS = 1500;
  function timed(input) {
    const t0 = Date.now();
    const out = sanitize(input);
    return { ms: Date.now() - t0, out };
  }

  it('the handler pattern does not rescan from every "on" (160KB)', () => {
    const { ms, out } = timed('<svg ' + 'on '.repeat(60000) + '><rect/></svg>');
    expect(ms).toBeLessThan(LIMIT_MS);
    // None of those became a live handler (no "on…=" survived as an attribute).
    expect(htmlThreats(out)).toEqual([]);
  });

  it('an unclosed <script does not rescan to the end each pass (640KB)', () => {
    const { ms, out } = timed('<svg><script ' + 'a'.repeat(640000));
    expect(ms).toBeLessThan(LIMIT_MS);
    expect(out).not.toMatch(/<script/i);
  });

  it('nested / re-forming tags settle within the pass cap (deep)', () => {
    // Each removal could reveal another blocked tag; the fixpoint is capped, so
    // this must terminate quickly and leave nothing live.
    const { ms, out } = timed(
      '<svg>' + '<scri'.repeat(20000) + '<script>alert(1)</script>' + 'pt>'.repeat(20000) + '</svg>'
    );
    expect(ms).toBeLessThan(LIMIT_MS);
    // Judged by what a parser builds, not by substring: no live script survives in
    // either the HTML (innerHTML) or the XML (direct-open) reading.
    expect(htmlThreats(out)).toEqual([]);
    expect(xmlThreats(out)).toEqual([]);
  });
});
