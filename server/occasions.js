'use strict';

// ---- B (Catalog & Design): OCCASION LANDING PAGES ----
//
// One page per occasion (/yom-huledet, /yom-huledet-aba, ...), so a search for
// "מתנה ליום הולדת 60 לאמא" lands on a page about exactly that. Every page is the
// same template (site/occasion.html) filled from one data file
// (server/occasions/<slug>.json). The menu and the home page are unchanged: the
// pages are reached from search, the footer's small "לפי אירוע" row, and each
// other.
//
// The data file (validateOccasion is the contract, tests/unit/occasions.test.js
// runs it over every file):
//   slug          the URL path, /<slug>
//   order         the page's number in the owner's plan (spec page 1, 2, ...):
//                 the footer row, the sitemap and llms.txt list pages by it
//   live          only a live page is served, listed in the sitemap/llms.txt and
//                 linked from the footer row; any other known slug answers 404
//   audience      'private' | 'business' (company pages, a later PR, add their own
//                 sections; their helper sheet is "דף עזר שנכין במיוחד בשבילכם",
//                 never a link to a ready-made file, and quantity pricing is only
//                 the sentence "יש כמובן מחירים מיוחדים לכמויות גדולות")
//   label         the short name in the footer row, the breadcrumb and llms.txt
//   title, description, h1
//   blueBox       { lead, body }: what Dugri is, for this buyer
//   catch         the "ומה הקאץ׳?" line
//   pinkBox       the pink box's phrases, coloured in turn like the home page's
//   cta           the order buttons' label
//   steps         { heading, items: [{ title, text }] x3, cta }
//   sampleWords   { heading, words: [8], note } (always labelled as examples)
//   designs       design ids: the deck deals these, the strip shows them first. Built-in and custom ids alike (custom
//                 ones come from /api/custom-designs after first paint; until then the deck deals the listed built-ins);
//                 each needs its art in site/js/home-data.js DESIGN_ART. A NOT_DEALT design (kids) is shown, not dealt.
//   faq           { heading, items: [{ q, a }] x4-5 } (also FAQPage JSON-LD)
//   related       other occasion slugs
//
// "{eta}" in any text is the production time, read from the admin (the pickup
// eta, settings email.pickup_info.eta, "... תוך כ-4 ימי עסקים ...") on every
// request. A page never types the number itself; the validator rejects "N ימי
// עסקים" so it can't creep back in.
//
// Shared pieces are not copied: the reviews row, its sheet, the design view and
// the site footer are read out of site/new.html (the live home page) per request,
// so an owner's edit to the home's reviews or a new review card shows here too.
// The business section is carried hidden (home-new.js wires its form), the
// founders' story is left out.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'occasions');
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DESIGN_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;

// The players answer, the same on every page (the owner's wording).
const PLAYERS_ANSWER = 'כמה שרוצים, עדיף בקבוצות.';
// Copy rules every page obeys. Each is [what is wrong, test over the page's text].
const COPY_RULES = [
  // the commercial word game whose trademark the shop avoids, in either script
  ['names the trademarked game', (t) => /אליאס|\balias\b/i.test(t)],
  ['states a price', (t) => /₪|ש["״]ח|\bILS\b|מחיר/i.test(t)],
  ['mentions a tax invoice', (t) => /חשבונית/.test(t)],
  ['states a minimum word count', (t) => /מינימום|לפחות\s*\d+\s*מילים/.test(t)],
  ['types the production time (use {eta})', (t) => /\d+\s*ימי\s*עסקים/.test(t)],
  ['promises shipping abroad', (t) => /משלוח\s+(?:ל|אל\s+)חו["״]ל/.test(t)],
];

const isStr = (v) => typeof v === 'string' && v.trim() !== '';

// Every text a page shows, joined, for the copy rules.
function allText(o) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(o);
  return out.join('\n');
}

// The errors in one data file, [] when it is fine. `known` is the set of every
// slug, so `related` can be checked against it.
function validateOccasion(o, known) {
  const e = [];
  if (!o || typeof o !== 'object' || Array.isArray(o)) return ['not an object'];
  if (!isStr(o.slug) || !SLUG_RE.test(o.slug)) e.push('slug');
  if (typeof o.live !== 'boolean') e.push('live must be true or false');
  if (!Number.isInteger(o.order) || o.order < 1) e.push('order: a page number from 1');
  if (o.audience !== 'private' && o.audience !== 'business') e.push('audience');
  for (const k of ['label', 'title', 'description', 'h1', 'catch', 'cta'])
    if (!isStr(o[k])) e.push(k);
  if (!o.blueBox || !isStr(o.blueBox.lead) || !isStr(o.blueBox.body)) e.push('blueBox');
  if (!Array.isArray(o.pinkBox) || !o.pinkBox.length || !o.pinkBox.every(isStr)) e.push('pinkBox');
  const st = o.steps;
  if (
    !st ||
    !isStr(st.heading) ||
    !isStr(st.cta) ||
    !Array.isArray(st.items) ||
    st.items.length !== 3 ||
    !st.items.every((i) => i && isStr(i.title) && isStr(i.text))
  )
    e.push('steps: a heading, a cta and three items with a title and a text');
  const sw = o.sampleWords;
  if (!sw || !isStr(sw.heading) || !isStr(sw.note)) e.push('sampleWords heading/note');
  if (!sw || !Array.isArray(sw.words) || sw.words.length !== 8 || !sw.words.every(isStr))
    e.push('sampleWords: exactly 8 words');
  if (
    !Array.isArray(o.designs) ||
    !o.designs.length ||
    !o.designs.every((d) => DESIGN_ID_RE.test(d))
  )
    e.push('designs');
  const fq = o.faq;
  if (
    !fq ||
    !isStr(fq.heading) ||
    !Array.isArray(fq.items) ||
    fq.items.length < 4 ||
    fq.items.length > 5 ||
    !fq.items.every((i) => i && isStr(i.q) && isStr(i.a))
  )
    e.push('faq: a heading and 4-5 questions, each with an answer');
  else {
    const players = fq.items.find((i) => /כמה\s+אנשים\s+יכולים\s+לשחק/.test(i.q));
    if (players && players.a !== PLAYERS_ANSWER)
      e.push('the players answer is "' + PLAYERS_ANSWER + '"');
  }
  if (!Array.isArray(o.related) || !o.related.every((s) => isStr(s) && SLUG_RE.test(s)))
    e.push('related');
  else if (known)
    for (const s of o.related) if (!known.has(s)) e.push('related: unknown slug ' + s);
  const text = allText(o);
  if (!/עד 412 מילים אישיות/.test(text)) e.push('says "עד 412 מילים אישיות"');
  for (const [what, bad] of COPY_RULES) if (bad(text)) e.push(what);
  return e;
}

// Every data file in `dir`, keyed by slug. A file that fails validation is left
// out (and named on stderr), so one bad file can never take the others down.
function loadOccasions(dir = DATA_DIR) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return new Map();
  }
  const raw = [];
  for (const f of files.sort()) {
    try {
      raw.push([f, JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))]);
    } catch (err) {
      console.error('[occasions] unreadable', f, err.message);
    }
  }
  const known = new Set(raw.map(([, o]) => o && o.slug));
  const out = new Map();
  for (const [f, o] of raw) {
    const errs = validateOccasion(o, known);
    if (errs.length || f !== o.slug + '.json') {
      console.error('[occasions] skipped', f, errs.join('; ') || 'file name is not <slug>.json');
      continue;
    }
    out.set(o.slug, o);
  }
  return out;
}

const ALL = loadOccasions();
const all = () => ALL;
const byOrder = (a, b) => a.order - b.order || (a.slug < b.slug ? -1 : 1);
const live = () => [...ALL.values()].filter((o) => o.live).sort(byOrder);
const find = (slug) => ALL.get(slug) || null;

// "N ימי עסקים" out of the admin's pickup eta sentence; null when it says none.
function etaPhrase(sentence) {
  const m = String(sentence || '').match(/(\d+)\s*ימי\s*עסקים/);
  return m ? `${m[1]} ימי עסקים` : null;
}

// The occasion with {eta} filled in. With no number in the admin's text the
// phrase reads "כמה ימי עסקים" rather than a typed one.
function resolve(o, eta) {
  const phrase = etaPhrase(eta) || 'כמה ימי עסקים';
  const fill = (v) =>
    typeof v === 'string'
      ? v.replace(/\{eta\}/g, phrase)
      : Array.isArray(v)
        ? v.map(fill)
        : v && typeof v === 'object'
          ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]))
          : v;
  return fill(o);
}

const esc = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );

// The order link every button on the page uses (options.html reads `occasion`).
const orderHref = (slug) => 'options.html?occasion=' + encodeURIComponent(slug);

// The small "לפי אירוע" row: every live page, the current one marked.
function footerRow(list, current) {
  if (!list.length) return '';
  const links = list
    .map(
      (o) =>
        `<a href="/${esc(o.slug)}"${o.slug === current ? ' aria-current="page"' : ''} data-ga="nav_click" data-ga-target="occasion" data-ga-where="footer">${esc(o.label)}</a>`
    )
    .join('<span aria-hidden="true"> · </span>');
  return `<nav class="occ-row" aria-label="לפי אירוע" data-testid="footer-occasions"><span class="occ-row-hd">לפי אירוע:</span> ${links}</nav>`;
}

const ROW_MARK = '<!--occasion-row-->';
// Every served page that carries the marker gets the row (the home pages' footers
// and the occasion template); a page without it is returned untouched.
function injectRow(html, current) {
  if (!html.includes(ROW_MARK)) return html;
  return html.split(ROW_MARK).join(footerRow(live(), current));
}

// A piece of new.html: from its opening tag to the first closing tag of the same
// element after it. These pieces hold no element of their own kind inside, which
// tests/unit/occasions.test.js checks against the real file.
const PIECES = {
  recs: ['<section class="recs"', '</section>'],
  sheet: ['<dialog class="sheet"', '</dialog>'],
  flood: ['<dialog class="flood"', '</dialog>'],
  biz: ['<section class="biz"', '</section>'],
  footer: ['<footer class="site-ft"', '</footer>'],
};
function piece(html, name) {
  const [open, close] = PIECES[name];
  const s = html.indexOf(open);
  if (s === -1) return '';
  const end = html.indexOf(close, s);
  return end === -1 ? '' : html.slice(s, end + close.length);
}
// The owner's texts in these pieces are stored under new.html (its content
// bucket); the scope makes the editor read them from there on this page too.
const scoped = (h) => h.replace(/^<(section|dialog)\b/, '<$1 data-edit-scope="new.html"');

// The occasion page: the template with the data and new.html's pieces filled in.
// `o` is already resolved (resolve()).
function renderPage(template, newHtml, o) {
  const href = orderHref(o.slug);
  const tones = ['', 'y', '', 'y', '', 'b'];
  const pink = o.pinkBox
    .map((t, i) =>
      tones[i % tones.length]
        ? `<span class="${tones[i % tones.length]}">${esc(t)}</span>`
        : `<span>${esc(t)}</span>`
    )
    .join('\n            ');
  const steps = o.steps.items
    .map(
      (s, i) =>
        `<li class="step"><span class="num" aria-hidden="true">${i + 1}</span><p class="pn sky"><b>${esc(s.title)}</b> ${esc(s.text)}</p></li>`
    )
    .join('\n          ');
  const words = o.sampleWords.words
    .map(
      (w, i) =>
        `<li style="--tilt: ${[-3, 2, -1.5, 3, -2.5, 1.5, -3.5, 2.5][i % 8]}deg">${esc(w)}</li>`
    )
    .join('\n          ');
  const faq = o.faq.items
    .map(
      (f, i) =>
        `<details${i === 0 ? ' open' : ''}><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`
    )
    .join('\n            ');
  const config = { slug: o.slug, audience: o.audience, designs: o.designs };
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  const biz = piece(newHtml, 'biz').replace(/^<section\b/, '<section hidden');
  const vals = {
    slug: esc(o.slug),
    title: esc(o.title),
    description: esc(o.description),
    h1: esc(o.h1),
    blueLead: esc(o.blueBox.lead),
    blueBody: esc(o.blueBox.body),
    catch: esc(o.catch),
    cta: esc(o.cta),
    href: esc(href),
    stepsHeading: esc(o.steps.heading),
    stepsCta: esc(o.steps.cta),
    wordsHeading: esc(o.sampleWords.heading),
    wordsNote: esc(o.sampleWords.note),
    faqHeading: esc(o.faq.heading),
    label: esc(o.label),
  };
  const raw = {
    pink,
    steps,
    words,
    faq,
    config: json,
    recs: scoped(piece(newHtml, 'recs')),
    sheet: scoped(piece(newHtml, 'sheet')),
    // the design view's order button: the page's link until a design is opened (home-new.js then adds the design)
    flood: scoped(piece(newHtml, 'flood')).replace(
      /(<a\b[^>]*?\shref=")[^"]*("[^>]*\bid="floodOrder")/,
      `$1${esc(href)}$2`
    ),
    biz: scoped(biz),
    footer: piece(newHtml, 'footer'),
  };
  return template
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : m
    )
    .replace(/\{\{(\w+)\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m
    );
}

module.exports = {
  DATA_DIR,
  PLAYERS_ANSWER,
  ROW_MARK,
  validateOccasion,
  loadOccasions,
  all,
  live,
  find,
  etaPhrase,
  resolve,
  orderHref,
  footerRow,
  injectRow,
  piece,
  renderPage,
};
