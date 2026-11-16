// @vitest-environment node
// Occasion pages 9-13 (server/occasions/<slug>.json on the shared template): partner's birthday, bat and bar mitzvah,
// engagement party, wedding gift and couples, a new baby. What these pin:
//   1. the owner's texts (H1, blue box, 8 example words, FAQ questions) word for word, from the occasion-pages spec
//   2. each page's own event-type label, live, private, in the owner's page order
//   3. its designs: 3-5, each drawable before the volume answers, never `kids`, built-ins dealt on first paint
//   4. the page renders fully, with every order link carrying its slug, and is in the sitemap and llms.txt
//   5. the new-baby page never says "בייבי שאוור"
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { DESIGN_ART, homeDesigns, occasionDesigns } from '../../site/js/home-data.js';
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

const SPEC = {
  'yom-huledet-ben-zug': {
    order: 9,
    label: 'יום הולדת לבן הזוג',
    h1: 'מתנה ליום הולדת לבן הזוג, שכל החברים כותבים',
    body: 'את מתחילה את הרשימה, והחברים, האחים והחברים מהעבודה מוסיפים עד 412 מילים אישיות. ביום ההולדת פותחים קופסה שכולה עליו.',
    words: [
      'הדייט הראשון',
      'ה-PlayStation',
      'המילואים',
      '"עוד חמש דקות"',
      'הקבוצה של שישי',
      'אמא שלו',
      'הטיול לברלין',
      'השקשוקה שלו',
    ],
    questions: [
      'איך מפתיעים בלי שהוא ידע?',
      'גם לבת זוג?',
      'כמה אנשים יכולים לשחק?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['birthday', 'japanese', 'football-boys', 'posttrip', 'tarifa'],
  },
  'bat-mitzva': {
    order: 10,
    label: 'בת מצווה ובר מצווה',
    h1: 'מתנה לבת מצווה שכל המשפחה והחברות כותבות',
    body: 'ההורים, הסבים והחברות מהכיתה מוסיפים עד 412 מילים אישיות עליה: מהגן ועד הטיול השנתי. משחקים במסיבה או בשבת המשפחתית.',
    words: [
      'הגננת רותי',
      'החוג של יום שלישי',
      'הטיול השנתי',
      '"רק עוד פרק אחד"',
      'הכלבה שלנו',
      'הקבוצה של הבנות',
      'החופש הגדול',
      'השיר שהיא שרה במקלחת',
    ],
    questions: [
      'מתאים גם לבר מצווה?',
      'ילדים בכיתה ו׳ יכולים לשחק?',
      'כמה אנשים יכולים לשחק?',
      'אפשר מתנה מהדודים?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['birthday', 'bachelorette', 'grapefruit', 'football-boys'],
  },
  'mesibat-erusin': {
    order: 11,
    label: 'מסיבת אירוסין',
    h1: 'משחק למסיבת אירוסין, שכל החברים של הזוג כותבים',
    body: 'משחק על שניהם: איך הכירו, הדייט הכושל, מי אמר "אני אוהב" ראשון. החברים משני הצדדים מוסיפים עד 412 מילים אישיות ומגלים מי מכיר את הזוג הכי טוב.',
    words: [
      'הדייט בטיילת',
      'הטינדר',
      'ההצעה בנחל',
      '"זה לא היה דייט"',
      'החתול שלהם',
      'הדירה הראשונה',
      'הטיול לרומא',
      'ההורים בארוחה הראשונה',
    ],
    questions: [
      'אפשר על שני בני הזוג?',
      'מתאים למסיבת אירוסין?',
      'כמה אנשים יכולים לשחק?',
      'אפשר להזמין גם לחינה?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['marriage', 'bachelorette', 'grapefruit', 'tarifa', 'birthday'],
  },
  zug: {
    order: 12,
    label: 'חתונה וזוגות',
    h1: 'מתנה מקורית לחתן וכלה, משחק שכולו עליהם',
    body: 'במקום עוד צ׳ק: משחק עם עד 412 מילים אישיות על הזוג, שהם משחקים עם החברים בשבת שאחרי החתונה ושומרים למזכרת.',
    words: [
      'ההצעה',
      'הדייט הראשון',
      '"מי שוטף כלים?"',
      'ירח הדבש',
      'המריבה על השם',
      'השמלה',
      'האולם שכמעט סגרו',
      'הריקוד הראשון',
    ],
    questions: [
      'אפשר לתת בחתונה עצמה?',
      'אפשר מכמה חברים ביחד?',
      'כמה אנשים יכולים לשחק?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['marriage', 'posttrip', 'grapefruit', 'tarifa', 'bachelorette'],
  },
  leida: {
    order: 13,
    label: 'לידה, ברית ובריתה',
    h1: 'מתנה ללידה, לברית או לבריתה, שכל המשפחה והחברות כותבות',
    body: 'לפני הלידה או אחרי הברית: המשפחה והחברות מוסיפות עד 412 מילים אישיות על ההורים הטריים, ההריון, השמות שנפסלו והדברים שהם אמרו שלא יעשו אף פעם.',
    words: [
      'השם שנפסל',
      'הבחילות בבוקר',
      '"אני לא אהיה אמא כזאת"',
      'העגלה שבחרו שבוע',
      'החדר של התינוק',
      'האולטרסאונד',
      'השוקולד בשתיים בלילה',
      'הלילה הראשון בבית',
    ],
    questions: [
      'מתאים לברית ולבריתה?',
      'אפשר לתת לפני הלידה?',
      'אפשר לשלב את האבא?',
      'כמה אנשים יכולים לשחק?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['grapefruit', 'birthday', 'marriage', 'posttrip'],
  },
};

const base = homeDesigns(PUBLIC_DESIGNS);
// what /api/custom-designs sends for the owner's uploaded designs, after loadCustomDesigns() (site/js/designs.js)
const custom = (id) => ({
  id,
  name: id,
  custom: true,
  public: true,
  img: {
    front: `/api/template-image/${id}/front`,
    back: `/api/template-image/${id}/back`,
    board: `/api/template-image/${id}/board`,
  },
});
const withCustom = homeDesigns([
  ...PUBLIC_DESIGNS,
  ...['daniel-amit', 'grapefruit', 'football-boys', 'tarifa'].map(custom),
]);

describe('occasion pages 9-13', () => {
  for (const [slug, want] of Object.entries(SPEC)) {
    describe(`page ${want.order}, /${slug}`, () => {
      const o = () => occ.find(slug);

      it("is live, private, valid, and carries the owner's H1, blue box, example words and questions", () => {
        expect(o(), slug).toBeTruthy();
        expect(o().order).toBe(want.order);
        expect(o().live).toBe(true);
        expect(o().audience).toBe('private');
        expect(o().label).toBe(want.label);
        expect(o().h1).toBe(want.h1);
        expect(o().blueBox.body).toBe(want.body);
        expect(o().sampleWords.words).toEqual(want.words);
        expect(o().faq.items.map((i) => i.q)).toEqual(want.questions);
        expect(occ.validateOccasion(o(), new Set(occ.all().keys()))).toEqual([]);
        const text = JSON.stringify(o());
        expect(text).toContain('{eta}');
        expect(text).not.toMatch(/₪|מחיר|חשבונית|אליאס|alias|מינימום|\d+\s*ימי עסקים/i);
        const players = o().faq.items.find((i) => /כמה אנשים יכולים לשחק/.test(i.q));
        expect(players.a).toBe('כמה שרוצים, עדיף בקבוצות.');
      });

      it('links only pages that are live', () => {
        for (const s of o().related) expect(occ.find(s) && occ.find(s).live, s).toBe(true);
      });

      it('lists 3-5 drawable designs, never kids, and deals its built-ins first, then all of them', () => {
        const list = o().designs;
        expect(list).toEqual(want.designs);
        expect(list.length).toBeGreaterThanOrEqual(3);
        expect(list.length).toBeLessThanOrEqual(5);
        expect(list).not.toContain('kids');
        for (const id of list) expect(DESIGN_ART[id], id).toBeTruthy();
        const builtIn = list.filter((id) => PUBLIC_DESIGNS.some((d) => d.id === id));
        expect(builtIn.length).toBeGreaterThan(0);
        expect(
          occasionDesigns(base, o())
            .filter((d) => d.deal)
            .map((d) => d.id)
        ).toEqual(builtIn);
        const later = occasionDesigns(withCustom, o());
        expect(later.map((d) => d.id).slice(0, list.length)).toEqual(list);
        expect(later.filter((d) => d.deal).map((d) => d.id)).toEqual(list);
        for (const d of later) expect(d.href).toMatch(new RegExp(`&occasion=${slug}$`));
      });

      it('renders fully from its data file, every order link carrying the slug', () => {
        const html = occ.renderPage(TEMPLATE, NEW_HTML, occ.resolve(o(), ETA));
        expect(html).not.toMatch(/\{\{\{?\w+\}?\}\}/);
        expect(html).not.toContain('{eta}');
        expect(html).toContain('תוך 4 ימי עסקים');
        expect(html).toContain(`<h1 id="h1" class="tt">${want.h1.replace(/"/g, '&quot;')}</h1>`);
        expect(html).toContain(`data-occasion="${slug}"`);
        const hrefs = [...html.matchAll(/href="(options\.html[^"]*)"/g)].map((m) => m[1]);
        expect(hrefs.length).toBeGreaterThan(0);
        for (const h of hrefs) expect(h).toBe(`options.html?occasion=${slug}`);
      });

      it('is public, in the sitemap with its own canonical, and in llms.txt under "לפי אירוע"', () => {
        const pages = seo.PUBLIC_PAGES.filter((p) => p.occasion).map((p) => p.path);
        expect(pages).toContain('/' + slug);
        expect(seo.isPublicPage(seo.occasionFile(slug))).toBe(true);
        expect(seo.sitemapXml()).toContain(`<loc>https://dugri-israel.co.il/${slug}</loc>`);
        expect(seo.canonicalUrl(seo.occasionFile(slug), { utm_source: 'ig' })).toBe(
          `https://dugri-israel.co.il/${slug}`
        );
        const t = seo.llmsTxt({ price: null, faq: [] });
        expect(t.slice(t.indexOf('## לפי אירוע'))).toContain(
          `- [${want.h1}](https://dugri-israel.co.il/${slug})`
        );
      });
    });
  }

  it('the footer row links all five under their labels, the pages in page order', () => {
    const row = occ.footerRow(occ.live(), 'zug');
    for (const [slug, want] of Object.entries(SPEC)) {
      const cur = slug === 'zug' ? ' aria-current="page"' : '';
      expect(row).toContain(`<a href="/${slug}"${cur} data-ga="nav_click"`);
      expect(row).toMatch(new RegExp(`href="/${slug}"[^>]*>${want.label}</a>`));
    }
    const order = occ.live().map((o) => o.order);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('the new-baby page never says "בייבי שאוור" (buyers search לידה, ברית, בריתה)', () => {
    const text = JSON.stringify(occ.find('leida'));
    expect(text).not.toMatch(/בייבי|שאוור|baby\s*shower/i);
    for (const w of ['לידה', 'ברית', 'בריתה']) expect(text).toContain(w);
  });

  it('the bat mitzvah page covers the bar mitzvah too, without the kids design', () => {
    const o = occ.find('bat-mitzva');
    expect(o.faq.items[0].a).toContain('בר המצווה');
    expect(o.designs).not.toContain('kids');
  });
});
