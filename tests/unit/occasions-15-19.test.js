// @vitest-environment node
// Occasion pages 15-19 (server/occasions/<slug>.json on the shared template): the farewell before moving abroad, the end
// of a year or course, the surprise party, army enlistment and the bachelor party. What these pin:
//   1. each page carries the owner's H1, blue box, example words and questions (occasion-pages spec), and its own label
//   2. the farewell page says shipping is inside Israel only and tells buyers to order to an Israeli address; no page
//      promises a parcel abroad
//   3. the bachelorette page (2) now points to the bachelor page (19) and back
//   4. each page's designs: 3-5 live ones with art, never ברוקלין (kids), the built-ins dealt on first paint
//   5. each page is in the sitemap and in llms.txt's "לפי אירוע"
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homeDesigns, occasionDesigns, DESIGN_ART } from '../../site/js/home-data.js';
import { PUBLIC_DESIGNS } from '../../site/js/designs.js';

const require = createRequire(import.meta.url);
const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'server');
const occ = require(path.join(serverDir, 'occasions.js'));
const seo = require(path.join(serverDir, 'seo.js'));
const ETA = 'המשחק מוכן בדרך כלל תוך כ-4 ימי עסקים מרגע שרשימת המילים מוכנה.';

const PAGES = [
  {
    slug: 'preida',
    order: 15,
    label: 'פרידה ומעבר לחו״ל',
    h1: 'מתנת פרידה לחברה שעוברת לחו״ל',
    body: 'לפני הטיסה, כל החברים מוסיפים עד 412 מילים אישיות עליה. משחקים במסיבת הפרידה, והחפיסה טסה איתה בתיק.',
    words: [
      'הדירה ברמת גן',
      'הפלאפל של שישי',
      '"אני חוזרת אחרי שנה"',
      'הרילוקיישן',
      'הבוס הישן',
      'הים בגורדון',
      'הקבוצה של הצבא',
      'המזוודה שלא נסגרה',
    ],
    questions: [
      'אפשר לשלוח לחו״ל?',
      'אפשר להוסיף מילים גם מחברים בחו״ל?',
      'כמה אנשים יכולים לשחק?',
      'מתאים גם לפרידה מעבודה?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['posttrip', 'tarifa', 'grapefruit', 'birthday'],
  },
  {
    slug: 'siyum',
    order: 16,
    label: 'סוף שנה וסיום קורס',
    h1: 'מתנת סוף שנה לקבוצה, לקורס או לצוות',
    body: 'כל הקבוצה מוסיפה עד 412 מילים אישיות על השנה שעברה ביחד: המדריכה, הטיול, הבדיחה שכולם מבינים. משחקים במסיבת הסיום.',
    words: [
      'המדריכה',
      'הטיול לצפון',
      '"מי לקח את המפתח?"',
      'המבחן של יוני',
      'המטבח המשותף',
      'השיר של השכבה',
      'הקבוצה בוואטסאפ',
      'יום ספורט',
    ],
    questions: [
      'מתאים לקומונה, לקורס ולשנת שירות?',
      'אפשר על המדריך או המורה?',
      'כמה אנשים יכולים לשחק?',
      'אפשר כמה עותקים לכל הקבוצה?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['birthday', 'grapefruit', 'japanese', 'tarifa'],
  },
  {
    slug: 'mesibat-hafta-a',
    order: 17,
    label: 'מסיבת הפתעה',
    h1: 'משחק למסיבת הפתעה, שכל המוזמנים כותבים מראש',
    body: 'כל מי שמוזמן מוסיף בשקט עד 412 מילים אישיות, ובמסיבה פותחים קופסה שכולה על מי שלא ידע כלום.',
    words: [
      '"לא חשדתי בכלום"',
      'הקבוצה הסודית',
      'הגיל האמיתי',
      'התחביב החדש',
      'החתול',
      'הטיול האחרון',
      'הבדיחה מהחתונה',
      'השיר שלה בקריוקי',
    ],
    questions: [
      'איך שומרים על ההפתעה?',
      'מי רואה את המילים?',
      'כמה אנשים יכולים לשחק?',
      'אפשר להזמין יומיים לפני?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['birthday', 'grapefruit', 'japanese', 'marriage', 'tarifa'],
  },
  {
    slug: 'giyus',
    order: 18,
    label: 'גיוס לצה״ל',
    h1: 'מתנה לגיוס לצה״ל, שכל המשפחה והחברים כותבים',
    body: 'לפני הבקו״ם, כל מי שאוהב אותו מוסיף עד 412 מילים אישיות: הכיתה, החוג, הטיול אחרי י״ב, המשפט שאמא אומרת בכל בוקר. משחקים במסיבת הגיוס, והחפיסה נשארת בבית לשבת הראשונה.',
    words: [
      '"תתקשר כשאתה מגיע"',
      'הטיול אחרי י״ב',
      'המאמן מהכדורגל',
      'הנעליים שעוד לא נכנסו',
      'ארוחת שישי',
      'החבר הכי טוב מהגן',
      'המסיבה בכיתה י״א',
      'השיער לפני הגיוס',
    ],
    questions: [
      'מתאים גם לבת שמתגייסת?',
      'כמה זמן לפני הגיוס להזמין?',
      'כמה אנשים יכולים לשחק?',
      'אפשר להוסיף מילים מהסבים?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['football-boys', 'posttrip', 'japanese', 'grapefruit'],
  },
  {
    slug: 'mesibat-ravakim',
    order: 19,
    label: 'מסיבת רווקים',
    h1: 'משחק למסיבת רווקים, שכל החברים כותבים על החתן',
    body: 'כל החבר׳ה מוסיפים עד 412 מילים אישיות על החתן: הצבא, הטיול אחרי, האקסיות, הפדיחה מהליגה של שישי. מתחלקים לקבוצות ומגלים מי באמת מכיר אותו.',
    words: [
      'המילואים',
      'הליגה של שישי',
      'הטיול לדרום אמריקה',
      '"עוד אחד ונזוז"',
      'הכינוי מהצבא',
      'הרכב הראשון',
      'הפיפ״א בלילות',
      'הכלה בדייט הראשון',
    ],
    questions: [
      'אפשר לקחת לסוף שבוע בחו״ל?',
      'החתן יראה את המילים?',
      'כמה אנשים יכולים לשחק?',
      'מתאים לרווקים ורווקות ביחד?',
      'תוך כמה זמן זה מגיע?',
    ],
    designs: ['football-boys', 'japanese', 'posttrip', 'tarifa'],
  },
];

// what /api/custom-designs sends for the owner's uploaded designs these pages list
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
const base = homeDesigns(PUBLIC_DESIGNS);
const withCustom = homeDesigns([
  ...PUBLIC_DESIGNS,
  ...['grapefruit', 'football-boys', 'tarifa', 'daniel-amit'].map(custom),
]);

describe('pages 15-19', () => {
  for (const p of PAGES) {
    describe(`page ${p.order}, /${p.slug}`, () => {
      const o = () => occ.find(p.slug);

      it("is live and carries the owner's H1, blue box, example words and questions", () => {
        expect(o(), p.slug).toBeTruthy();
        expect(o().order).toBe(p.order);
        expect(o().live).toBe(true);
        expect(o().audience).toBe('private');
        expect(o().label).toBe(p.label);
        expect(o().h1).toBe(p.h1);
        expect(o().blueBox.body).toBe(p.body);
        expect(o().sampleWords.words).toEqual(p.words);
        expect(o().faq.items.map((i) => i.q)).toEqual(p.questions);
        expect(o().faq.items.find((i) => i.q === 'כמה אנשים יכולים לשחק?').a).toBe(
          'כמה שרוצים, עדיף בקבוצות.'
        );
        expect(occ.validateOccasion(o(), new Set(occ.all().keys()))).toEqual([]);
      });

      it('fills the production time from the admin, never a typed one', () => {
        expect(JSON.stringify(o())).not.toMatch(/\d+\s*ימי עסקים/);
        const r = occ.resolve(o(), ETA);
        expect(r.description).toContain('תוך 4 ימי עסקים');
        expect(JSON.stringify(r)).not.toContain('{eta}');
      });

      it('lists 3-5 live designs with art, never ברוקלין; deals its built-ins first, then all of them', () => {
        const list = o().designs;
        expect(list).toEqual(p.designs);
        expect(list.length).toBeGreaterThanOrEqual(3);
        expect(list.length).toBeLessThanOrEqual(5);
        expect(list).not.toContain('kids');
        for (const id of list) expect(DESIGN_ART[id], id).toBeTruthy();
        const builtIn = list.filter((id) => PUBLIC_DESIGNS.some((d) => d.id === id));
        expect(builtIn.length).toBeGreaterThan(0);
        const first = occasionDesigns(base, o());
        expect(first.filter((d) => d.deal).map((d) => d.id)).toEqual(builtIn);
        const later = occasionDesigns(withCustom, o());
        expect(later.map((d) => d.id).slice(0, list.length)).toEqual(list);
        expect(later.filter((d) => d.deal).map((d) => d.id)).toEqual(list);
        for (const d of later) expect(d.href).toMatch(new RegExp(`&occasion=${p.slug}$`));
      });

      it('links only live pages', () => {
        expect(o().related.length).toBeGreaterThan(0);
        for (const s of o().related) expect(occ.find(s) && occ.find(s).live, s).toBe(true);
      });

      it('is in the sitemap, with its own canonical, and in llms.txt under "לפי אירוע"', () => {
        expect(seo.PUBLIC_PAGES.some((x) => x.occasion && x.path === '/' + p.slug)).toBe(true);
        expect(seo.sitemapXml()).toContain(`<loc>https://dugri-israel.co.il/${p.slug}</loc>`);
        expect(seo.isPublicPage(seo.occasionFile(p.slug))).toBe(true);
        const t = seo.llmsTxt({ price: null, faq: [] });
        expect(t.slice(t.indexOf('## לפי אירוע'))).toContain(
          `- [${p.h1}](https://dugri-israel.co.il/${p.slug})`
        );
      });
    });
  }

  it('the farewell page says shipping is inside Israel only, and to order to an Israeli address before the flight', () => {
    const o = occ.find('preida');
    const ship = o.faq.items.find((i) => i.q === 'אפשר לשלוח לחו״ל?');
    // the first question, so it opens with the page
    expect(o.faq.items[0]).toBe(ship);
    expect(ship.a).toContain('רק בתוך ישראל');
    expect(ship.a).toContain('מזמינים לכתובת בארץ לפני הטיסה');
    // and the steps say it too, without the FAQ open
    expect(o.steps.items[2].text).toContain('רק בתוך ישראל');
    expect(o.steps.items[2].text).toContain('לכתובת בארץ');
  });

  it('no page promises a parcel abroad; the "take it abroad" answers send the box on the flight', () => {
    for (const p of PAGES) {
      const t = JSON.stringify(occ.find(p.slug));
      expect(t, p.slug).not.toMatch(/משלוח\s+(?:ל|אל\s+)חו["״]ל|שולחים\s+לחו["״]ל|נשלח\s+לחו["״]ל/);
      expect(t, p.slug).not.toMatch(/משלוחים\s+(?:גם\s+)?לחו["״]ל/);
    }
    const weekend = occ.find('mesibat-ravakim').faq.items.find((i) => /בחו״ל/.test(i.q));
    expect(weekend.a).toContain('לטיסה');
    expect(weekend.a).toContain('רק בתוך ישראל');
  });

  it('the enlistment and army release pages point to each other (same family, two years later)', () => {
    expect(occ.find('giyus').related).toContain('shichrur');
    expect(occ.find('shichrur').related).toContain('giyus');
  });

  it('the bachelorette and bachelor pages point to each other', () => {
    expect(occ.find('mesibat-ravakot').related).toContain('mesibat-ravakim');
    expect(occ.find('mesibat-ravakim').related).toContain('mesibat-ravakot');
    // and the footer row on page 2 links page 19
    const row = occ.footerRow(occ.live(), 'mesibat-ravakot');
    expect(row).toContain('<a href="/mesibat-ravakim" data-ga');
  });

  // owner decisions 2026-11-16: the title prints on the cards; no built-in discount for copies; never ship to the guest of honour
  it('the title is written on the cards, copies carry no discount, nothing ships to the guest of honour', () => {
    for (const slug of [...PAGES.map((p) => p.slug), 'mesibat-ravakot']) {
      const o = occ.find(slug);
      const t = JSON.stringify(o);
      expect(t, slug).not.toContain('על הקופסה');
      expect(o.steps.items[0].text, slug).toContain('על הקלפים');
      expect(t, slug).not.toMatch(/הנחה|מבצע|זול/);
      expect(t, slug).not.toMatch(/(?:משלוח|שולחים)\s+(?:ישר\s+)?(?:אליו|אליה|אליהם|לחוגג|לבעל)/);
    }
  });

  it('every label is its own (the wizard pre-fills it as the event type)', () => {
    const labels = occ.live().map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
