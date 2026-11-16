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
//   audience      'private' | 'business': a company page (/asakim, ...) is the
//                 business variant, site/occasion-business.html (renderBusinessPage,
//                 validateBusiness: its own sections and rules, below)
//   label         the short name in the footer row, the breadcrumb and llms.txt
//   title, description, h1
//   blueBox       { lead, body }: what Dugri is, for this buyer
//   catch         the "ומה הקאץ׳?" line
//   pinkBox       the pink box's phrases, coloured in turn like the home page's
//   cta           the order buttons' label
//   steps         { heading, items: [{ title, text }] x3, cta }
//   sampleWords   { heading, words: [8], note } (always labelled as examples)
//   designs       design ids: the deck deals these, the strip shows them first. Built-in and custom ids alike (custom
//                 ones come from /api/custom-designs after first paint; until then the deck deals the listed built-ins).
//                 A built-in needs its art in site/js/home-data.js DESIGN_ART; a custom one without an entry there
//                 (hanuka) is drawn from the server's render of its template (homeDesigns), in the fallback colour.
//                 A NOT_DEALT design (site/js/home-data.js; none today) is shown, not dealt.
//   faq           { heading, items: [{ q, a }] x4-5 } (also FAQPage JSON-LD)
//   related       other occasion slugs
//   seasonal      optional, true for a page tied to a date in the year (Hanukkah, Valentine's Day): a marker for
//                 whoever plans the year's pages; nothing is hidden or shown by it
//   deadline      optional, the owner's own line with the last order date before the holiday ("להזמנה עם משלוח
//                 עד החג: ..."), shown under the hero's button; null or absent shows nothing. It is typed by hand
//                 and not computed: the admin's etas say "בדרך כלל כ-N ימי עסקים" and nothing on the site knows
//                 which days are business days or when a holiday falls.
//   showBiz       optional, true shows the home page's business section (its WhatsApp and lead form) on this
//                 page, for a private page bought by a workplace (/gibush); absent or false keeps it hidden. A company
//                 page (audience 'business') has its own lead form (businessLead) and ignores it.
//
// "{eta}" in any text is the production time, read from the admin (the pickup
// eta, settings email.pickup_info.eta, "... תוך כ-4 ימי עסקים ...") on every
// request. A page never types the number itself; the validator rejects "N ימי
// עסקים" so it can't creep back in.
//
// Shared pieces are not copied: the reviews row, its sheet, the design view and
// the site footer are read out of site/new.html (the live home page) per request,
// so an owner's edit to the home's reviews or a new review card shows here too.
// The business section is carried hidden (home-new.js wires its form) unless the
// page sets showBiz, the founders' story is left out.

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
    st.items.length !== (o.audience === 'business' ? 4 : 3) ||
    !st.items.every((i) => i && isStr(i.title) && isStr(i.text))
  )
    e.push(
      'steps: a heading, a cta and three items (four on a company page) with a title and a text'
    );
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
    fq.items.length < (o.audience === 'business' ? 5 : 4) ||
    fq.items.length > (o.audience === 'business' ? 7 : 5) ||
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
  if (o.seasonal !== undefined && typeof o.seasonal !== 'boolean')
    e.push('seasonal must be true or false');
  if (o.deadline !== undefined && o.deadline !== null && !isStr(o.deadline))
    e.push('deadline: a line of text, or null');
  if (o.showBiz !== undefined && typeof o.showBiz !== 'boolean')
    e.push('showBiz must be true or false');
  // a company page's own rules; its quantity-pricing sentence and question are the
  // one place "מחירים" is allowed, so they are taken out before the price rule
  const business = o.audience === 'business';
  if (business) e.push(...validateBusiness(o));
  const text = business ? allText(o).split(QTY_PHRASE).join('') : allText(o);
  if (!/עד 412 מילים אישיות/.test(text)) e.push('says "עד 412 מילים אישיות"');
  for (const [what, bad] of COPY_RULES) if (bad(text)) e.push(what);
  return e;
}

// ---- the company pages (audience 'business', spec "Pages for welfare managers") ----
// The words come from the company, gathered by the welfare manager with a helper
// sheet Dugri prepares for each company; employees receive a finished game and add
// no words. A company page sells through a quote, never the order wizard: every
// button is the lead button. The owner's fixed texts:
const BUSINESS_CTA = 'לקבלת הצעה לחברה';
const HELPER_SHEET = 'דף עזר שנכין במיוחד בשבילכם';
const QTY_PHRASE = 'מחירים מיוחדים לכמויות';
const QTY_LINE = 'יש כמובן מחירים מיוחדים לכמויות גדולות';
const QTY_Q = 'יש מחירים מיוחדים לכמויות?';
const EMPLOYEES_Q = 'העובדים צריכים לעשות משהו?';
const EMPLOYEES_A = 'לא. העובדים מקבלים משחק מוכן, ורק פותחים את הקופסה ומשחקים.';
const LOGO_A = 'אפשר לוגו מעל כמות מסוימת, בעיצוב וליווי שלנו';
// "employees add words" in any wording a page could slip into (the step that says
// "בלי להוסיף מילים בעצמם" is the denial, and passes)
const EMPLOYEES_ADD = [
  /(?:ה?עובדים|כל\s+עובד|הצוות)\s+(?:מוסיפ|יוסיפ|כותב|יכתב|שולח|ישלח)\S*\s+(?:את\s+)?(?:ה?מילים|מילה)/,
  /(?<!בלי\s)(?:מוסיפים|תוסיפו|יוסיפו)\s+(?:ה?מילים|מילה)/,
  /קישור\s+(?:ל|אל\s+)(?:כל\s+)?ה?(?:עובדים|צוות|משרד)/,
];
const listOf = (v, n) => Array.isArray(v) && v.length === n && v.every(isStr);
const noDot = (s) => String(s).trim().replace(/\.$/, '');

function validateBusiness(o) {
  const e = [];
  if (o.cta !== BUSINESS_CTA) e.push('cta: "' + BUSINESS_CTA + '"');
  if (o.steps && o.steps.cta !== BUSINESS_CTA) e.push('steps.cta: "' + BUSINESS_CTA + '"');
  if (!o.why || !isStr(o.why.heading) || !listOf(o.why.items, 3))
    e.push('why: a heading and three reasons');
  const kit = o.kit;
  if (!kit || !isStr(kit.heading) || !listOf(kit.items, 4) || !isStr(kit.box))
    e.push('kit: a heading, four items and the gift-box line');
  else if (!kit.items.includes(HELPER_SHEET))
    e.push('kit: the helper sheet is "' + HELPER_SHEET + '"');
  if (!kit || kit.quantity !== QTY_LINE) e.push('kit.quantity: "' + QTY_LINE + '"');
  if (o.hub !== undefined) {
    const h = o.hub;
    if (
      !h ||
      !isStr(h.heading) ||
      !Array.isArray(h.cards) ||
      !h.cards.length ||
      !h.cards.every((c) => isStr(c) && SLUG_RE.test(c))
    )
      e.push('hub: a heading and the slugs of the pages it links');
  }
  const items = (o.faq && Array.isArray(o.faq.items) ? o.faq.items : []).filter(Boolean);
  const emp = items.find((i) => i.q === EMPLOYEES_Q);
  if (!emp || emp.a !== EMPLOYEES_A) e.push('faq: "' + EMPLOYEES_Q + '" → "' + EMPLOYEES_A + '"');
  const qty = items.find((i) => i.q === QTY_Q);
  if (!qty) e.push('faq: "' + QTY_Q + '"');
  else if (/\d|₪/.test(String(qty.a))) e.push('faq: the quantity answer names no number');
  for (const i of items)
    if (/לוגו/.test(String(i.q)) && noDot(i.a) !== LOGO_A)
      e.push('faq: the logo answer is "' + LOGO_A + '"');
  // the look is ours, in the company's spirit: an answer never promises the company's own colours or graphic language
  // (the master copy's step 3, "בצבעים ובלוגו שלכם", is the owner's text and stays)
  if (items.some((i) => /צבע(?:ים|י)\s+(?:שלכם|שלכן|החברה)|ה?שפה\s+הגרפית/.test(String(i.a))))
    e.push(
      "faq: the design is ours, in the company's spirit; never their colours or graphic language"
    );
  const text = allText(o);
  if (EMPLOYEES_ADD.some((re) => re.test(text))) e.push('says employees add words');
  if (/דף\s+עזר\s+לאיסוף/.test(text) || /https?:|\.pdf\b/i.test(text))
    e.push('the helper sheet is prepared for them, never a ready-made file or a link');
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
  const biz = o.showBiz
    ? piece(newHtml, 'biz')
    : piece(newHtml, 'biz').replace(/^<section\b/, '<section hidden');
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
    deadline: isStr(o.deadline)
      ? `<p class="occ-deadline" data-testid="occ-deadline">${esc(o.deadline)}</p>`
      : '',
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

// ---- the company variant (audience 'business'): site/occasion-business.html ----
// The private renderer above is left exactly as it is: a company page fills its own
// slots first, then hands the rest to renderPage with new.html's pieces adapted
// (only the "לקוח עסקי" review cards; the design view's button is the lead button),
// so the shared slots are filled by the same code on both kinds of page.

// The template a page is served from.
const templateFor = (o) =>
  o && o.audience === 'business' ? 'occasion-business.html' : 'occasion.html';

const BIZ_LEDE = 'ספרו לנו לאיזה חג או אירוע, כמה ערכות ומה רוצים במארז, ונחזור אליכם עם הצעה.';
const BIZ_TAG = 'לקוח עסקי';
// one review card in the row: a logo card (div) or a review (button), neither holding its own kind
const CARD_RE = /<(div|button) class="rc\b[^"]*"[^>]*>[\s\S]*?<\/\1>/g;
const isBizCard = (card) => new RegExp('class="tag"[^>]*>\\s*' + BIZ_TAG + '\\s*</span').test(card);
// the cards a company page shows: only the business customers'
const bizReviews = (recs) => recs.replace(CARD_RE, (card) => (isBizCard(card) ? card : ''));

// new.html as a company page uses it: reviews from business customers only, and the
// design view's button asks for a quote instead of opening the wizard.
function businessHome(newHtml) {
  const recs = piece(newHtml, 'recs');
  const flood = piece(newHtml, 'flood');
  const lead = flood.replace(/<a\b[^>]*\bid="floodOrder"[\s\S]*?<\/a\s*>/, (a) =>
    a
      .replace(/\shref="[^"]*"/, ' href="#biz"')
      .replace(/data-ga="order_started"/, 'data-ga="occasion_cta_click"')
      .replace(/<span data-edit="new-view-cta">[^<]*<\/span/, `<span>${BUSINESS_CTA}</span`)
  );
  return newHtml.replace(recs, () => bizReviews(recs)).replace(flood, () => lead);
}

// The home's business section, shown, as the page's lead form: its heading is the
// page's button text, its lede asks what the quote needs, and the logos (under the
// hero here) and the home's link to /asakim are left out.
function businessLead(newHtml) {
  return scoped(piece(newHtml, 'biz'))
    .replace(/<h2 id="h-biz"[^>]*>[^<]*<\/h2>/, `<h2 id="h-biz" class="tt">${BUSINESS_CTA}</h2>`)
    .replace(/<p class="lede"[^>]*>[^<]*<\/p>/, `<p class="lede">${esc(BIZ_LEDE)}</p>`)
    .replace(/\s*<div class="logos">[\s\S]*?<\/div>/, '')
    .replace(/\s*<a\b[^>]*\bhref="\/asakim"[\s\S]*?<\/a\s*>/, '');
}

// The "כבר שיחקו" logo row, read out of the home's business section.
function logoRow(newHtml) {
  const biz = piece(newHtml, 'biz');
  const m = biz.match(/<div class="logos">[\s\S]*?<\/div>/);
  return m ? `<div class="occ-logos" data-edit-scope="new.html">${m[0]}</div>` : '';
}

const CHECK =
  '<svg class="ck" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 12.5l5 5L20 6.5" /></svg>';

// A company page (`o` already resolved). `isLive` says which hub cards may link.
function renderBusinessPage(template, newHtml, o, isLive = (s) => !!(find(s) && find(s).live)) {
  const why = o.why.items
    .map((t) => `<li><p class="pn sky">${esc(t)}</p></li>`)
    .join('\n          ');
  const kit = o.kit.items
    .map((t) => `<li>${CHECK}<span>${esc(t)}</span></li>`)
    .join('\n          ');
  const cards = (o.hub ? o.hub.cards : [])
    .filter((s) => s !== o.slug && isLive(s) && find(s))
    .map(
      (s) =>
        `<li><a href="/${esc(s)}" data-ga="nav_click" data-ga-target="occasion" data-ga-where="hub"><b>${esc(find(s).label)}</b><span>${esc(find(s).h1)}</span></a></li>`
    )
    .join('\n          ');
  const hub = cards
    ? `<section class="occ-hub" id="hub" aria-labelledby="h-hub">
      <div class="occ-in">
        <h2 id="h-hub" class="tt">${esc(o.hub.heading)}</h2>
        <ul class="hub-cards">
          ${cards}
        </ul>
      </div>
    </section>`
    : '';
  const raw = {
    why,
    kit,
    hub,
    logos: logoRow(newHtml),
    bizLead: businessLead(newHtml),
  };
  const vals = {
    whyHeading: esc(o.why.heading),
    kitHeading: esc(o.kit.heading),
    kitBox: esc(o.kit.box),
    kitQuantity: esc(o.kit.quantity),
  };
  const filled = template
    .replace(/\{\{\{(\w+)\}\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(raw, k) ? raw[k] : m
    )
    .replace(/\{\{(\w+)\}\}/g, (m, k) =>
      Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : m
    );
  // renderPage points the design view's button at the wizard; here it is the lead button
  return renderPage(filled, businessHome(newHtml), o).replace(
    /(<a\b[^>]*?\shref=")[^"]*("[^>]*\bid="floodOrder")/,
    '$1#biz$2'
  );
}

module.exports = {
  DATA_DIR,
  BUSINESS_CTA,
  HELPER_SHEET,
  QTY_LINE,
  EMPLOYEES_Q,
  EMPLOYEES_A,
  LOGO_A,
  templateFor,
  renderBusinessPage,
  bizReviews,
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
