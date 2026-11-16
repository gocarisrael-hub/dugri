// @vitest-environment node
// Occasion pages 20-23 (server/occasions/*.json on the one template). What these pin:
//   1. the owner's texts, word for word: H1, blue box, example words, FAQ questions, and the answers she gave
//      (the grandparents' card size; the players answer; no two-player rule on the surprise date)
//   2. the friends' trip abroad sends the box on the flight and never a parcel abroad
//   3. page 22, Valentine's Day and Tu B'Av, is seasonal and built in full but NOT live: it answers 404 and is out of
//      the sitemap, llms.txt, the footer row and the wizard's list; its "before February 14" answer types no date and
//      its `deadline` stays null until the owner types one
//   4. each page's designs: 3-5 live ones with art, never kids, the listed built-ins dealt on first paint
//   5. pages 20, 21 and 23 are live, served, in the sitemap and llms.txt, and link only to live pages
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { DESIGN_ART, NOT_DEALT, homeDesigns, occasionDesigns } from '../../site/js/home-data.js';
import { PUBLIC_DESIGNS } from '../../site/js/designs.js';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..', '..', 'server');
const siteDir = path.join(__dirname, '..', '..', 'site');
const occ = require(path.join(serverDir, 'occasions.js'));
const seo = require(path.join(serverDir, 'seo.js'));
const NEW_HTML = fs.readFileSync(path.join(siteDir, 'new.html'), 'utf8');
const TEMPLATE = fs.readFileSync(path.join(siteDir, 'occasion.html'), 'utf8');
const ETA = 'המשחק מוכן בדרך כלל תוך כ-4 ימי עסקים מרגע שרשימת המילים מוכנה.';
const LIVE_HERE = ['yom-huledet-saba-savta', 'tiyul-chavura-lechul', 'deit-mafti-a'];
const VALENTINE = 'yom-haahava';

// the owner's texts (occasion-pages spec, pages 20-23)
const PAGES = {
  'yom-huledet-saba-savta': {
    order: 20,
    label: 'יום הולדת לסבא וסבתא',
    h1: 'מתנה ליום הולדת לסבא או לסבתא, שכל הנכדים כותבים',
    body: '70, 80 או 90: הילדים, הנכדים והנינים מוסיפים עד 412 מילים אישיות על סבא או סבתא, מהעלייה לארץ ועד העוגה של שישי. משחקים בארוחה המשפחתית, וכולם מגלים סיפורים שלא שמעו.',
    words: [
      'העוגה של שישי',
      'הסיפור מהצבא',
      '"אתם רעבים?"',
      'הרדיו בבוקר',
      'הטיול לצפון',
      'התמונה מהחתונה',
      'הספה בסלון',
      '"בזמני זה היה אחרת"',
    ],
    faq: [
      'סבתא תצליח לשחק?',
      'אפשר להוסיף מילים מכל הדורות?',
      'כמה אנשים יכולים לשחק?',
      'הכתב מספיק גדול לסבא וסבתא?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['marriage', 'grapefruit', 'birthday', 'japanese'],
  },
  'tiyul-chavura-lechul': {
    order: 21,
    label: 'טיול חברים לחו״ל',
    h1: 'משחק לטיול עם החבר׳ה בחו״ל, שכל המילים בו עליכם',
    body: 'לפני הטיסה לאתונה, לבודפשט או לסופ״ש ברודוס, כל החבורה מוסיפה עד 412 מילים אישיות על כולם. בערב הראשון בדירה פותחים את הקופסה.',
    words: [
      'הטיסה שאיחרנו אליה',
      '"מי מחזיק את הדרכונים?"',
      'הדירה מהאיירביאנבי',
      'הקבוצה בוואטסאפ',
      'הצבא',
      'המועדון ההוא',
      'ההוסטל בתאילנד',
      '"רק בירה אחת"',
    ],
    faq: [
      'אפשר לקחת בטיסה?',
      'המשחק על כל החבורה או על אחד?',
      'כמה אנשים יכולים לשחק?',
      'מתי להזמין לפני הטיסה?',
      'אפשר גם לרווקות בחו״ל?',
    ],
    designs: ['posttrip', 'tarifa', 'bachelorette', 'japanese', 'grapefruit'],
  },
  'yom-haahava': {
    order: 22,
    label: 'יום האהבה וט״ו באב',
    h1: 'מתנה ליום האהבה ולט״ו באב, משחק שכולו עליכם',
    body: 'את או אתה כותבים עד 412 מילים אישיות על הזוגיות: הדייט הראשון, הבדיחות הפנימיות, המקום שלכם. מתנה שאי אפשר לקנות בחנות, למשחק עם החברים.',
    words: [
      'הדייט הראשון',
      'המקום שלנו',
      '"מי בוחר סרט?"',
      'השיר שלנו',
      'החופשה הראשונה',
      'הכינוי שרק אני אומר',
      'ההתנצלות עם הפרחים',
      'הארוחה ששרפנו',
    ],
    faq: [
      'אפשר שהחברים יוסיפו מילים?',
      'כמה אנשים יכולים לשחק?',
      'מה להזמין כדי שיגיע לפני ה-14 בפברואר?',
      'יש עיצוב רומנטי?',
    ],
    designs: ['bachelorette', 'marriage', 'grapefruit', 'tarifa'],
  },
  'deit-mafti-a': {
    order: 23,
    label: 'דייט מפתיע',
    h1: 'דייט מפתיע בבית: משחק שכל המילים בו על שניכם',
    body: 'מבשלים, מדליקים נרות ופותחים קופסה עם עד 412 מילים אישיות על הזוגיות. כל קלף הוא זיכרון, וכל תור נגמר בצחוק.',
    words: [
      'הפעם הראשונה שנפגשנו',
      'הטיול שהשתבש',
      '"אני לא רעבה"',
      'הסדרה שראינו בלילה אחד',
      'החתול',
      'הדירה הראשונה',
      'הדייט במסעדה ההיא',
      'השיר מהחתונה',
    ],
    faq: [
      'אפשר להפתיע בלי שהוא ידע?',
      'מתאים גם לזוג נשוי שנים?',
      'כמה אנשים יכולים לשחק?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['marriage', 'bachelorette', 'grapefruit', 'posttrip'],
  },
};
const answer = (slug, q) => occ.find(slug).faq.items.find((i) => i.q === q).a;

describe('pages 20-23: the data files', () => {
  const known = new Set([...occ.all().keys()]);

  for (const [slug, want] of Object.entries(PAGES)) {
    it(`page ${want.order}, /${slug}, carries the owner's texts and passes the validator`, () => {
      const o = occ.find(slug);
      expect(o, slug).toBeTruthy();
      expect(occ.validateOccasion(o, known)).toEqual([]);
      expect(o.order).toBe(want.order);
      expect(o.audience).toBe('private');
      expect(o.label).toBe(want.label);
      expect(o.h1).toBe(want.h1);
      expect(o.blueBox.body).toBe(want.body);
      expect(o.sampleWords.words).toEqual(want.words);
      expect(o.sampleWords.note).toContain('דוגמאות');
      expect(o.faq.items.map((i) => i.q)).toEqual(want.faq);
      expect(answer(slug, 'כמה אנשים יכולים לשחק?')).toBe('כמה שרוצים, עדיף בקבוצות.');
      const text = JSON.stringify(o);
      expect(text).toContain('{eta}');
      expect(text).not.toMatch(/₪|מחיר|חשבונית|אליאס|alias|מינימום|\d+\s*ימי עסקים/i);
      // owner 2026-11-16: the title is printed on the cards, not the box; no discount for copies; nothing is sent
      // straight to the guest of honour as a surprise
      expect(text).not.toMatch(/(?:כותבים|כותרת)\s+על\s+הקופסה|על הקופסה כותבים/);
      expect(o.steps.items[0].text).toContain('על הקלפים');
      expect(text).not.toMatch(/הנחה|מבצע|זול יותר/);
      expect(text).not.toMatch(
        /(?:שולחים|משלוח|נשלח)\s+(?:ישר\s+)?(?:אל|ל)(?:סבא|סבתא|בן הזוג|בת הזוג)/
      );
    });
  }

  it('every label is its own (the wizard pre-fills it)', () => {
    const labels = [...occ.all().values()].map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("the grandparents' page answers the card size in the owner's words", () => {
    expect(answer('yom-huledet-saba-savta', 'הכתב מספיק גדול לסבא וסבתא?')).toBe(
      'כן, הקלפים בגרסה הרגילה גדולים וקריאים.'
    );
  });

  it("the friends' trip sends the box on the flight, never a parcel abroad", () => {
    for (const q of ['אפשר לקחת בטיסה?', 'אפשר גם לרווקות בחו״ל?']) {
      const a = answer('tiyul-chavura-lechul', q);
      expect(a).toContain('לטיסה');
      expect(a).toContain('רק בתוך ישראל');
      expect(a).toContain('לכתובת בארץ');
    }
    expect(JSON.stringify(occ.find('tiyul-chavura-lechul'))).not.toMatch(
      /משלוח(?:ים)?\s+(?:ל|אל\s+|גם\s+ל)חו["״]ל|שולחים\s+לחו["״]ל/
    );
  });

  it('the surprise date has no two-player rule of its own: the players answer is the fixed one', () => {
    const o = occ.find('deit-mafti-a');
    expect(answer('deit-mafti-a', 'כמה אנשים יכולים לשחק?')).toBe(occ.PLAYERS_ANSWER);
    expect(JSON.stringify(o)).not.toMatch(/שני שחקנים|לשני אנשים|בשניים/);
  });

  for (const slug of LIVE_HERE)
    it(`/${slug} is live and links only to live pages`, () => {
      const o = occ.find(slug);
      expect(o.live).toBe(true);
      for (const s of o.related) expect(occ.find(s) && occ.find(s).live, s).toBe(true);
    });

  it('links the pages that are live: 20 to the anniversary page, 21 to the bachelor party, 22 and 23 to the couples pages, 23 to the surprise party', () => {
    expect(occ.find('yom-huledet-saba-savta').related).toContain('yom-nisuin');
    expect(occ.find(VALENTINE).related).toEqual(['zug', 'yom-huledet-ben-zug']);
    expect(occ.find('deit-mafti-a').related).toEqual([
      'zug',
      'yom-huledet-ben-zug',
      'mesibat-hafta-a',
    ]);
    expect(occ.find('tiyul-chavura-lechul').related).toContain('mesibat-ravakim');
  });

  it('no live page links to the Valentine page while it is not live', () => {
    for (const o of occ.live()) expect(JSON.stringify(o)).not.toContain(VALENTINE);
  });
});

describe('page 22, /yom-haahava: seasonal, built, not live', () => {
  const o = () => occ.find(VALENTINE);

  it('is marked seasonal and not live, with no typed deadline', () => {
    expect(o().seasonal).toBe(true);
    expect(o().live).toBe(false);
    expect(o().deadline).toBe(null);
  });

  it('the "before February 14" answer types no date and no day count: the admin\'s eta, the 16:00 rule, WhatsApp', () => {
    const a = answer(VALENTINE, 'מה להזמין כדי שיגיע לפני ה-14 בפברואר?');
    expect(a).toContain('{eta}');
    expect(a).toContain('בוואטסאפ');
    expect(a.replace('16:00', '')).not.toMatch(/\d/);
    expect(a).not.toMatch(/ינואר|פברואר|יולי|אוגוסט/);
    const resolved = occ.resolve(o(), ETA);
    expect(resolved.faq.items[2].a).toContain('לאיסוף עצמי המשחק מוכן תוך 4 ימי עסקים');
  });

  it('is built in full: the template fills with nothing left over and no last order date', () => {
    const html = occ.renderPage(TEMPLATE, NEW_HTML, occ.resolve(o(), ETA));
    expect(html).not.toMatch(/\{\{\{?\w+\}?\}\}/);
    expect(html).toContain(`<h1 id="h1" class="tt">${PAGES[VALENTINE].h1}</h1>`);
    expect(html).not.toContain('occ-deadline');
    expect(html).not.toContain('{eta}');
  });

  it('stays out of live(), the sitemap, llms.txt and the footer row', () => {
    expect(occ.live().map((p) => p.slug)).not.toContain(VALENTINE);
    expect(seo.PUBLIC_PAGES.map((p) => p.path)).not.toContain('/' + VALENTINE);
    expect(seo.isPublicPage(seo.occasionFile(VALENTINE))).toBe(false);
    expect(seo.sitemapXml()).not.toContain(VALENTINE);
    expect(seo.llmsTxt({ price: null, faq: [] })).not.toContain(VALENTINE);
    expect(occ.footerRow(occ.live(), null)).not.toContain(VALENTINE);
  });
});

describe('pages 20-23: the designs', () => {
  const base = homeDesigns(PUBLIC_DESIGNS);
  for (const [slug, want] of Object.entries(PAGES))
    it(`/${slug} lists 3-5 designs with art, never kids, and deals its built-ins on first paint`, () => {
      const list = occ.find(slug).designs;
      expect(list).toEqual(want.designs);
      expect(list.length).toBeGreaterThanOrEqual(3);
      expect(list.length).toBeLessThanOrEqual(5);
      for (const id of list) {
        expect(DESIGN_ART[id], id).toBeTruthy();
        expect(NOT_DEALT.has(id), id).toBe(false);
      }
      const builtIn = list.filter((id) => PUBLIC_DESIGNS.some((d) => d.id === id));
      expect(builtIn.length).toBeGreaterThan(0);
      const first = occasionDesigns(base, occ.find(slug));
      expect(first.filter((d) => d.deal).map((d) => d.id)).toEqual(builtIn);
    });
});

describe('pages 20-23: search and AI', () => {
  it('the live ones are in the sitemap and in llms.txt under "לפי אירוע", with their H1', () => {
    const xml = seo.sitemapXml();
    const llms = seo.llmsTxt({ price: null, faq: [] });
    const sec = llms.slice(llms.indexOf('## לפי אירוע'));
    for (const slug of LIVE_HERE) {
      expect(seo.isPublicPage(seo.occasionFile(slug)), slug).toBe(true);
      expect(xml).toContain(`<loc>https://dugri-israel.co.il/${slug}</loc>`);
      expect(sec).toContain(`- [${PAGES[slug].h1}](https://dugri-israel.co.il/${slug})`);
    }
  });

  it('the footer row links the live ones by their labels', () => {
    const row = occ.footerRow(occ.live(), 'deit-mafti-a');
    for (const slug of LIVE_HERE) expect(row).toContain(`>${PAGES[slug].label}</a>`);
    expect(row).toContain('<a href="/deit-mafti-a" aria-current="page"');
  });
});

describe('pages 20-23: the routes (app)', () => {
  let server;
  let base;

  beforeAll(async () => {
    process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dugri-occ-20-23-'));
    for (const f of ['faq.js', 'settings.js', 'notify.js', 'seo.js', 'occasions.js', 'index.js']) {
      delete require.cache[require.resolve(path.join(serverDir, f))];
    }
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

  it('serves pages 20, 21 and 23, each with its own H1 and order link', async () => {
    for (const slug of LIVE_HERE) {
      const r = await fetch(base + '/' + slug);
      expect(r.status, slug).toBe(200);
      const html = await r.text();
      expect(html).toContain(`data-occasion="${slug}"`);
      expect(html).toContain(`<h1 id="h1" class="tt">${PAGES[slug].h1}</h1>`);
      expect(html).toContain(`href="options.html?occasion=${slug}"`);
      expect(html).not.toContain('{eta}');
      expect(html).not.toMatch(/₪/);
    }
  });

  it('page 22 answers 404 and is in neither the sitemap, llms.txt, the footer row nor the wizard list', async () => {
    expect((await fetch(base + '/' + VALENTINE)).status).toBe(404);
    expect(await (await fetch(base + '/sitemap.xml')).text()).not.toContain(VALENTINE);
    expect(await (await fetch(base + '/llms.txt')).text()).not.toContain(VALENTINE);
    const home = await (await fetch(base + '/')).text();
    expect(home).toContain('href="/deit-mafti-a"');
    expect(home).not.toContain(VALENTINE);
    const list = await (await fetch(base + '/api/occasions')).json();
    const slugs = list.occasions.map((o) => o.slug);
    expect(slugs).toEqual(expect.arrayContaining(LIVE_HERE));
    expect(slugs).not.toContain(VALENTINE);
  });
});
