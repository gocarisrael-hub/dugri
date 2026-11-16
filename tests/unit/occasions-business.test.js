// @vitest-environment node
// The company pages (audience "business": /asakim and spec pages 25-28), the company variant of the occasion template
// (site/occasion-business.html, renderBusinessPage in server/occasions.js). What these pin:
//   1. every company data file obeys the company rules: the fixed employees question and answer, the quantity-pricing
//      sentence and question with no number, the logo answer, the helper sheet that is prepared for them (never a file or a
//      link), no employee adding words, no price, no tax invoice; and the validator rejects each broken rule
//   2. page 25 (holiday gifts) is seasonal and not live yet; 24, 26, 27 and 28 are live
//   3. the variant: logo row under the hero, the three reasons, the kit with its gift-box and quantity lines, the hub's cards
//      (live pages only), only the "לקוח עסקי" review cards, every button a quote button to #biz or the business WhatsApp,
//      no wizard link and no price, the home's business section shown as the lead form
//   4. the private pages render byte for byte as before (a golden render made with main's renderer)
//   5. routes, sitemap and llms.txt; the home pages' business sections link /asakim
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const siteDir = path.join(__dirname, '..', '..', 'site');
const fixtures = path.join(__dirname, '..', 'fixtures', 'occasion-private');
const occ = require(path.join(serverDir, 'occasions.js'));
const readSite = (f) => fs.readFileSync(path.join(siteDir, f), 'utf8');
const NEW_HTML = readSite('new.html');
const TEMPLATE = readSite('occasion-business.html');
const ETA = 'המשחק מוכן בדרך כלל תוך כ-4 ימי עסקים מרגע שרשימת המילים מוכנה.';

const BUSINESS = [
  ['asakim', 24, true],
  ['matanot-lechag-laovdim', 25, false],
  ['matanot-leeruei-chevra', 26, true],
  ['matana-memutegget', 27, true],
  ['matana-mekorit-laovdim', 28, true],
];
const files = fs.readdirSync(occ.DATA_DIR).filter((f) => f.endsWith('.json'));
const readData = (slug) =>
  JSON.parse(fs.readFileSync(path.join(occ.DATA_DIR, slug + '.json'), 'utf8'));
const known = new Set(files.map((f) => f.replace(/\.json$/, '')));
// a shared piece as it sits on the served page (scoped to new.html's content)
const servedPiece = (h, cls) => {
  const s = h.indexOf(`<section data-edit-scope="new.html" class="${cls}"`);
  return s === -1 ? '' : h.slice(s, h.indexOf('</section>', s) + '</section>'.length);
};
const render = (slug, live) =>
  occ.renderBusinessPage(
    TEMPLATE,
    NEW_HTML,
    occ.resolve(occ.find(slug) || readData(slug), ETA),
    live
  );

describe('the company data files', () => {
  it('pages 24-28 exist, in the owner order; 25 is seasonal and not live yet, the others are live', () => {
    for (const [slug, order, live] of BUSINESS) {
      const o = readData(slug);
      expect(o.audience, slug).toBe('business');
      expect(o.order, slug).toBe(order);
      expect(o.live, slug).toBe(live);
    }
    expect(readData('matanot-lechag-laovdim').seasonal).toBe(true);
    const liveBiz = occ
      .live()
      .filter((o) => o.audience === 'business')
      .map((o) => o.slug);
    expect(liveBiz).toEqual([
      'asakim',
      'matanot-leeruei-chevra',
      'matana-memutegget',
      'matana-mekorit-laovdim',
    ]);
  });

  it("carries the owner's H1s, and page 24 the master copy in full", () => {
    expect(readData('asakim').h1).toBe('דוגרי – מתנה שהעובדים עוד לא ראו, כזאת שמדברת בשפה שלכם');
    expect(readData('matanot-lechag-laovdim').h1).toBe('מתנה לחג לעובדים, שמדברת בשפה של החברה');
    expect(readData('matanot-leeruei-chevra').h1).toBe(
      'מתנה לאירוע חברה ולהרמת כוסית, שמדברת בשפה שלכם'
    );
    expect(readData('matana-memutegget').h1).toBe('מתנה פרסונלית לעובדים, שמשדרת את רוח החברה');
    expect(readData('matana-mekorit-laovdim').h1).toBe('מתנה שהעובדים עוד לא ראו');
    const hub = readData('asakim');
    expect(hub.blueBox.body).toBe(
      'דוגרי הוא משחק מילים שנבנה מהמילים של החברה: הערכים, הסלנג, הפרויקטים, והבדיחות שרק מי שעובד אצלכם יבין. מתחלקים לקבוצות, שולפים קלף ומתארים את המילה בלי להגיד אותה. הקבוצה צריכה לנחש כמה שיותר מילים עד שהטיימר מצלצל.'
    );
    expect(hub.why.items).toEqual([
      'משדרת את ערכי החברה דרך המילים שלה, לא רק דרך לוגו על קופסה.',
      'מתאימה לראש השנה, לפסח, לחנוכה, להרמת כוסית ולאירועי חברה (ואפילו לערכות למידה!)',
      'גורמת לעובדים להרגיש חלק ממשהו, ומכניסה את החברה לרגעים הכי טובים שלהם גם בבית.',
    ]);
    expect(hub.kit.items).toEqual([
      '103 קלפים עם מילים עליכם!',
      'לוח משחק בעיצוב ברוח החברה שלכם',
      'חיילי משחק בעיצוב אישי',
      'דף עזר שנכין במיוחד בשבילכם',
    ]);
    expect(hub.kit.box).toBe(
      'אנו יודעים לספק מארזים לבחירתכם שבהם כל עובד יקבל משחק דוגרי כחלק מהמארז – ואת היין, הדבש והפיצוחים וכל מה שרוצים.'
    );
    expect(hub.hub.cards).toEqual([
      'matanot-lechag-laovdim',
      'matanot-leeruei-chevra',
      'matana-memutegget',
      'matana-mekorit-laovdim',
    ]);
  });

  for (const [slug] of BUSINESS) {
    it(`${slug} obeys the format, the copy rules and the company rules`, () => {
      const o = readData(slug);
      expect(occ.validateOccasion(o, known)).toEqual([]);
      expect(o.steps.items).toHaveLength(4);
      expect(o.sampleWords.words).toHaveLength(8);
      expect(o.sampleWords.heading).toBe('מילים שמופיעות במשחקים של חברות');
      expect(o.sampleWords.note).toContain('דוגמאות');
      expect(o.catch).toBe('כל המילים עליכם!');
      expect(o.cta).toBe('לקבלת הצעה לחברה');
      expect(o.steps.cta).toBe('לקבלת הצעה לחברה');
      expect(o.kit.quantity).toBe('יש כמובן מחירים מיוחדים לכמויות גדולות');
      expect(o.kit.items).toContain('דף עזר שנכין במיוחד בשבילכם');
      const faq = o.faq.items;
      expect(faq.find((i) => i.q === 'העובדים צריכים לעשות משהו?').a).toBe(
        'לא. העובדים מקבלים משחק מוכן, ורק פותחים את הקופסה ומשחקים.'
      );
      const qty = faq.find((i) => i.q === 'יש מחירים מיוחדים לכמויות?');
      expect(qty.a).not.toMatch(/\d|₪/);
      for (const i of faq.filter((f) => /לוגו/.test(f.q)))
        expect(i.a).toBe('אפשר לוגו מעל כמות מסוימת, בעיצוב וליווי שלנו.');
      const players = faq.find((i) => /כמה אנשים יכולים לשחק/.test(i.q));
      if (players) expect(players.a).toBe('כמה שרוצים, עדיף בקבוצות.');
      // "מחירים" only in the owner's two quantity lines; never a price, a tax invoice, a link or a ready-made file
      const text = JSON.stringify(o)
        .split('יש כמובן מחירים מיוחדים לכמויות גדולות')
        .join('')
        .split('יש מחירים מיוחדים לכמויות?')
        .join('');
      expect(text).not.toMatch(/₪|מחיר|חשבונית|אליאס|alias|מינימום|https?:|\.pdf/i);
      expect(text).not.toMatch(/\d+\s*ימי עסקים/);
      expect(text).toContain('עד 412 מילים אישיות');
      for (const s of o.related) expect(occ.find(s).live, s).toBe(true);
    });
  }

  it('no private page links a company page that is not live, and none links the holiday page', () => {
    for (const o of occ.live()) expect(o.related, o.slug).not.toContain('matanot-lechag-laovdim');
  });

  it('the validator rejects each broken company rule', () => {
    const good = readData('matanot-leeruei-chevra');
    const bad = (mut) => {
      const o = JSON.parse(JSON.stringify(good));
      mut(o);
      return occ.validateOccasion(o, known).join(' | ');
    };
    expect(bad(() => {})).toBe('');
    const emp = (o) => o.faq.items.find((i) => i.q === 'העובדים צריכים לעשות משהו?');
    const qty = (o) => o.faq.items.find((i) => i.q === 'יש מחירים מיוחדים לכמויות?');
    expect(bad((o) => (emp(o).a = 'כן, קצת.'))).toMatch(/העובדים צריכים לעשות משהו/);
    expect(bad((o) => (o.faq.items = o.faq.items.filter((i) => i !== emp(o))))).toMatch(
      /העובדים צריכים לעשות משהו/
    );
    expect(bad((o) => (o.faq.items = o.faq.items.filter((i) => i !== qty(o))))).toMatch(
      /יש מחירים מיוחדים לכמויות/
    );
    expect(bad((o) => (qty(o).a = 'מ-20 ערכות יש הנחה.'))).toMatch(/names no number/);
    expect(bad((o) => (o.kit.quantity = 'יש הנחות.'))).toMatch(/kit.quantity/);
    expect(bad((o) => (o.kit.items[3] = 'דף עזר לאיסוף מילים'))).toMatch(/helper sheet/);
    expect(bad((o) => (o.kit.box += ' https://dugri-israel.co.il/helper.pdf'))).toMatch(
      /helper sheet/
    );
    expect(bad((o) => (o.faq.items[1].q = 'אפשר לוגו?'))).toMatch(/logo answer/);
    expect(bad((o) => (o.faq.items[1].a = 'כל ערכה ב-49 ש"ח.'))).toMatch(/states a price/);
    expect(bad((o) => (o.faq.items[1].a = 'כן, ותקבלו חשבונית.'))).toMatch(/tax invoice/);
    expect(bad((o) => (o.faq.items[1].a = 'כן, בצבעים שלכם.'))).toMatch(/the design is ours/);
    expect(bad((o) => (o.faq.items[1].a = 'כן, לפי השפה הגרפית שלכם.'))).toMatch(
      /the design is ours/
    );
    expect(bad((o) => (o.cta = 'הזמינו עכשיו'))).toMatch(/cta/);
    expect(bad((o) => (o.steps.cta = 'מתחילים'))).toMatch(/steps.cta/);
    expect(bad((o) => o.steps.items.pop())).toMatch(/four on a company page/);
    expect(bad((o) => o.why.items.pop())).toMatch(/why/);
    expect(bad((o) => (o.hub = { heading: 'x', cards: ['Not A Slug'] }))).toMatch(/hub/);
    // employees adding words, in each wording a page could slip into
    for (const line of [
      'העובדים מוסיפים מילים מהטלפון.',
      'כל עובד כותב מילים על החברה.',
      'שולחים קישור לכל העובדים.',
      'שולחים קישור לצוות, וכולם מוסיפים מילים.',
    ])
      expect(
        bad((o) => (o.faq.items[0].a = line)),
        line
      ).toMatch(/employees add words/);
    // the denial in step 4 is fine
    expect(
      bad((o) => (o.faq.items[0].a = 'העובדים מקבלים משחק מוכן, בלי להוסיף מילים בעצמם.'))
    ).toBe('');
  });

  it('the quantity lines are allowed on a company page only', () => {
    const o = readData('pensia');
    o.faq.items[0].a = 'יש כמובן מחירים מיוחדים לכמויות גדולות';
    expect(occ.validateOccasion(o, known)).toContain('states a price');
  });
});

describe('the company template', () => {
  const html = render('asakim');

  it('is filled entirely, from the data file and new.html', () => {
    expect(html).not.toMatch(/\{\{\{?\w+\}?\}\}/);
    expect(html).toContain(
      '<h1 id="h1" class="tt">דוגרי – מתנה שהעובדים עוד לא ראו, כזאת שמדברת בשפה שלכם</h1>'
    );
    expect(html).toContain('<span class="big">כל המילים עליכם!</span>');
    expect(html).toContain('<body class="occ-page occ-biz" data-occasion="asakim">');
    const cfg = JSON.parse(html.match(/id="occasion-data">([^<]*)</)[1]);
    expect(cfg).toEqual({
      slug: 'asakim',
      audience: 'business',
      designs: occ.find('asakim').designs,
    });
    expect(html).toContain('/css/occasion-business.css');
  });

  it('shows the logo row right under the hero, the three reasons and the kit with its two lines', () => {
    const hero = html.indexOf('</section>', html.indexOf('<section class="hero"'));
    const logos = html.indexOf(
      '<div class="occ-logos" data-edit-scope="new.html"><div class="logos">'
    );
    expect(logos).toBeGreaterThan(hero);
    expect(logos).toBeLessThan(html.indexOf('id="why"'));
    for (const alt of ['Microsoft', 'Elbit Systems', 'בנק הפועלים', 'H&amp;M', 'סטאר הפקות'])
      expect(html.slice(logos, logos + 900)).toContain(`alt="${alt}"`);
    expect(html.match(/<li><p class="pn sky">/g)).toHaveLength(3);
    expect(html.match(/<li><svg class="ck"/g)).toHaveLength(4);
    expect(html).toContain('<span>דף עזר שנכין במיוחד בשבילכם</span>');
    expect(html).toContain('data-testid="kit-quantity">יש כמובן מחירים מיוחדים לכמויות גדולות</p>');
    expect(html.match(/<li class="step">/g)).toHaveLength(4);
  });

  it("links the hub's cards only to live pages (the holiday page waits for its season)", () => {
    expect(html).toContain('<a href="/matanot-leeruei-chevra" data-ga="nav_click"');
    expect(html).toContain('<a href="/matana-memutegget" data-ga="nav_click"');
    expect(html).toContain('<a href="/matana-mekorit-laovdim" data-ga="nav_click"');
    expect(html).not.toContain('/matanot-lechag-laovdim');
    expect(render('asakim', () => true)).toContain('<a href="/matanot-lechag-laovdim"');
    // no hub on the other pages, and none when no card's page is live
    expect(render('matana-memutegget')).not.toContain('class="occ-hub"');
    expect(render('asakim', () => false)).not.toContain('class="occ-hub"');
  });

  it('shows only the "לקוח עסקי" review cards', () => {
    const recs = servedPiece(html, 'recs');
    const tags = [...recs.matchAll(/class="tag"[^>]*>([^<]*)</g)].map((m) => m[1].trim());
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t).toBe('לקוח עסקי');
    expect(recs).not.toContain('<button class="rc');
    // the home has both kinds, so the filter is doing the work
    expect(occ.piece(NEW_HTML, 'recs')).toContain('<button class="rc');
    const homeBiz = [...occ.piece(NEW_HTML, 'recs').matchAll(/>\s*לקוח עסקי\s*<\/span/g)].length;
    expect(tags).toHaveLength(homeBiz);
  });

  it('every button asks for a quote: #biz or the business WhatsApp, never the wizard, and no price', () => {
    expect(html).not.toContain('options.html');
    expect(html).not.toContain('products.html');
    expect(html).not.toMatch(/₪|data-ga="order_started"|data-ga="nav_order"/);
    const pills = [...html.matchAll(/<a\s+class="pill"\s+href="([^"]*)"[\s\S]*?<\/a\s*>/g)];
    expect(pills.length).toBeGreaterThanOrEqual(7);
    for (const [a, href] of pills) {
      if (href.startsWith('https://wa.me/')) {
        expect(href).toMatch(/^https:\/\/wa\.me\/972546577715/);
        continue;
      }
      expect(href, a).toBe('#biz');
      expect(a).toContain('לקבלת הצעה לחברה');
      expect(a).toContain('data-ga="occasion_cta_click"');
    }
    // the design view's button too, its text the page's (no editable home text over it)
    const flood = html.match(/<a\b[^>]*\bid="floodOrder"[\s\S]*?<\/a\s*>/)[0];
    expect(flood).toContain('href="#biz"');
    expect(flood).toContain('<span>לקבלת הצעה לחברה</span');
    expect(flood).toContain('data-ga="occasion_cta_click"');
    // every WhatsApp link on the page is the business number (the site footer is the home's, unchanged)
    const body = html.slice(0, html.indexOf('<footer class="site-ft"'));
    for (const [, n] of body.matchAll(/wa\.me\/(\d+)/g)) expect(n).toBe('972546577715');
  });

  it("shows the home's business section as the lead form, under the quote heading", () => {
    const biz = servedPiece(html, 'biz');
    expect(biz).toMatch(/^<section data-edit-scope="new\.html" class="biz" id="biz"/);
    expect(biz).toContain('<h2 id="h-biz" class="tt">לקבלת הצעה לחברה</h2>');
    expect(biz).not.toContain('data-edit="new-biz-heading"');
    expect(biz).toContain('<form class="lead" id="lead"');
    expect(biz).toContain('data-ga-cta="business"');
    expect(biz).not.toContain('class="logos"');
    expect(biz).not.toContain('href="/asakim"');
    expect(html.indexOf('id="faq"')).toBeLessThan(html.indexOf('id="biz"'));
  });

  it('every company page renders, with no employee adding words anywhere on it', () => {
    for (const [slug] of BUSINESS) {
      const page = render(slug, () => true);
      expect(page).toContain(`data-occasion="${slug}"`);
      expect(page).toContain('העובדים צריכים לעשות משהו?');
      expect(page).toContain('יש כמובן מחירים מיוחדים לכמויות גדולות');
      expect(page).not.toMatch(/חשבונית|options\.html|₪/);
      expect(page).not.toMatch(/(?:העובדים|כל עובד)\s+(?:מוסיפים|כותבים)/);
    }
  });

  it('escapes the data', () => {
    const o = JSON.parse(JSON.stringify(occ.resolve(occ.find('asakim'), ETA)));
    o.why.items[0] = '<script>x</script>';
    expect(occ.renderBusinessPage(TEMPLATE, NEW_HTML, o)).toContain(
      '&lt;script&gt;x&lt;/script&gt;'
    );
  });

  it('the template a page is served from follows its audience', () => {
    expect(occ.templateFor(occ.find('asakim'))).toBe('occasion-business.html');
    for (const o of occ.live().filter((x) => x.audience === 'private'))
      expect(occ.templateFor(o)).toBe('occasion.html');
  });
});

describe('the private pages are untouched', () => {
  // expected.html was rendered by main's server/occasions.js (before the company variant) from these fixtures: the private
  // renderer must still produce it byte for byte. A change MEANT for the private pages regenerates it (render page.json with
  // the new renderPage into expected.html) and says so in its PR.
  it('renderPage gives the same bytes as before', () => {
    const read = (f) => fs.readFileSync(path.join(fixtures, f), 'utf8');
    const o = occ.resolve(JSON.parse(read('page.json')), 'המשחק מוכן תוך כ-4 ימי עסקים.');
    expect(occ.renderPage(read('template.html'), read('new.html'), o)).toBe(read('expected.html'));
  });

  it('a private page carries none of the company sections', () => {
    for (const o of occ.live().filter((x) => x.audience === 'private')) {
      const page = occ.renderPage(readSite('occasion.html'), NEW_HTML, occ.resolve(o, ETA));
      expect(page, o.slug).not.toMatch(
        /occ-biz|occ-logos|occ-why|occ-kit|occ-hub|occasion-business|לקבלת הצעה לחברה/
      );
      expect(page, o.slug).toMatch(/<section data-edit-scope="new\.html" hidden class="biz"/);
    }
  });
});

describe('the home pages link /asakim', () => {
  it("from new.html's business section and index.html's business band", () => {
    expect(occ.piece(NEW_HTML, 'biz')).toMatch(/<a\s+class="biz-more"\s+href="\/asakim"/);
    const index = readSite('index.html');
    const band = index.slice(
      index.indexOf('<section class="b2b'),
      index.indexOf('</section>', index.indexOf('<section class="b2b'))
    );
    expect(band).toMatch(/<a\s+href="\/asakim"/);
  });
});

describe('sitemap and llms.txt', () => {
  const seo = require(path.join(serverDir, 'seo.js'));
  it('list the live company pages, not the holiday page', () => {
    const xml = seo.sitemapXml({ designIds: [] });
    const llms = seo.llmsTxt({ price: null, faq: [], eta: '' });
    for (const [slug, , live] of BUSINESS) {
      expect(xml.includes(`/${slug}</loc>`), slug).toBe(live);
      expect(llms.includes(`/${slug})`), slug).toBe(live);
      expect(seo.isPublicPage(seo.occasionFile(slug)), slug).toBe(live);
    }
    expect(llms).toContain('[מתנה שהעובדים עוד לא ראו](');
  });
});

describe('the routes (app)', () => {
  let server;
  let base;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-occ-biz-'));
    for (const f of ['faq.js', 'settings.js', 'notify.js', 'seo.js', 'occasions.js', 'index.js'])
      delete require.cache[require.resolve(path.join(serverDir, f))];
    const app = require(path.join(serverDir, 'index.js'));
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        base = 'http://127.0.0.1:' + server.address().port;
        resolve();
      });
    });
  });

  afterAll(async () => {
    if (server) await new Promise((r) => server.close(r));
    delete process.env.DATA_DIR;
  });

  it('serves the live company pages from the company template, with the admin production time', async () => {
    for (const [slug, , live] of BUSINESS) {
      const r = await fetch(base + '/' + slug);
      expect(r.status, slug).toBe(live ? 200 : 404);
      if (!live) continue;
      const html = await r.text();
      expect(html).toContain(`data-occasion="${slug}"`);
      expect(html).toContain('occ-biz');
      expect(html).toContain('data-testid="footer-occasions"');
      expect(html).not.toContain('{eta}');
    }
  });

  it('never serves the raw company template', async () => {
    expect((await fetch(base + '/occasion-business.html')).status).toBe(404);
    expect((await fetch(base + '/occasion-business')).status).toBe(404);
  });
});
