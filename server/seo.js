'use strict';

// SEARCH AND AI VISIBILITY: what Google, Bing and the AI assistants are told.
//
// The site had none of it: no robots.txt (it fell through to the 404 for an
// extension path), no sitemap, no canonical, no structured data. A search for
// "דוגרי" returned the dictionary word and unrelated events, never the shop —
// "dugri" is a common word, so nothing on the page told a crawler it is a brand
// that sells a product. This module is that telling, in four pieces:
//
//   • robots.txt   — open to every crawler (AI ones included) on production,
//                    closed on every other host so staging never competes with it
//   • sitemap.xml  — the public storefront pages
//   • llms.txt     — a plain-text brief for AI assistants, built from live data
//   • head tags    — canonical, og:url/og:image, noindex on private pages, and
//                    JSON-LD (Organization, WebSite, Product, FAQPage)
//
// PURE (no I/O), like faq.js and reminders.js: index.js reads the live price and
// FAQ and passes them in, so a price change in the admin reaches the structured
// data on the next request with no deploy, and these functions are trivial to
// test.
//
// WHICH HOST IS INDEXABLE is decided by the request's hostname against SEO_HOST,
// not by PUBLIC_BASE_URL: staging has its own PUBLIC_BASE_URL, so "the host we
// were configured with" would have opened staging to Google too. The production
// domain is the default; SEO_HOST overrides it if the domain ever moves.

const DEFAULT_HOST = 'dugri-israel.co.il';

function seoHost() {
  return String(process.env.SEO_HOST || DEFAULT_HOST)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/^www\./, '');
}

function origin() {
  return 'https://' + seoHost();
}

// True only on the production domain (www. or bare). Every other host — the
// Railway staging and production *.up.railway.app names, localhost — gets
// "Disallow: /" and a noindex header, so the only copy a search engine keeps is
// the real one.
function isIndexableHost(hostname) {
  const h = String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/:\d+$/, '')
    .replace(/^www\./, '');
  return h !== '' && h === seoHost();
}

// The storefront pages a visitor can land on from a search. Order = sitemap order.
const PUBLIC_PAGES = [
  { file: 'index.html', path: '/', priority: '1.0' },
  { file: 'products.html', path: '/products.html', priority: '0.9' },
  { file: 'how.html', path: '/how.html', priority: '0.8' },
  { file: 'options.html', path: '/options.html', priority: '0.8' },
  { file: 'product.html', path: '/product.html', priority: '0.7' },
  { file: 'wordlists.html', path: '/wordlists.html', priority: '0.6' },
  { file: 'pickup.html', path: '/pickup.html', priority: '0.5' },
  { file: 'timer.html', path: '/timer.html', priority: '0.4' },
  { file: 'terms.html', path: '/terms.html', priority: '0.2' },
];
const PUBLIC_BY_FILE = new Map(PUBLIC_PAGES.map((p) => [p.file, p]));

// Anything not in PUBLIC_PAGES is private (admin, a buyer's collection, payment
// returns, proofs) and gets noindex. Most of those pages already carry their own
// <meta name="robots">; this covers the ones that don't (pay-done, admin-bench)
// and any page added later — a new page is private until someone lists it above.
function isPublicPage(file) {
  return PUBLIC_BY_FILE.has(file);
}

// Paths crawlers have no business in. /api is NOT blocked: Google renders the
// pages, and the FAQ, prices and design names arrive from /api — blocking it
// would index a page with its content missing.
const DISALLOW = [
  '/admin',
  '/api/admin/',
  '/collect',
  '/coupons',
  '/dashboard',
  '/partner',
  '/pay',
  '/proof',
  '/unsubscribe',
];

function robotsTxt({ indexable }) {
  if (!indexable) return 'User-agent: *\nDisallow: /\n';
  // One `*` group on purpose. A crawler that finds a group naming it obeys ONLY
  // that group, so listing GPTBot or ClaudeBot separately would mean repeating
  // every Disallow per bot (and forgetting one would open /admin to it). The
  // comment names them so nobody "fixes" this by adding a blocking group.
  return [
    '# Search engines and AI assistants (Googlebot, Bingbot, OAI-SearchBot, GPTBot,',
    '# ChatGPT-User, ClaudeBot, Claude-SearchBot, PerplexityBot, ...) are all welcome.',
    'User-agent: *',
    'Allow: /',
    ...DISALLOW.map((p) => 'Disallow: ' + p),
    '',
    'Sitemap: ' + origin() + '/sitemap.xml',
    '',
  ].join('\n');
}

const xmlEscape = (s) =>
  String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// designIds: the PUBLIC design ids, each becoming product.html?design=<id> — the
// pages people actually share. Optional; an empty list leaves the static pages.
function sitemapXml({ designIds = [] } = {}) {
  const base = origin();
  const urls = PUBLIC_PAGES.map((p) => ({ loc: base + p.path, priority: p.priority }));
  for (const id of designIds) {
    if (!safeDesignId(id)) continue;
    urls.push({ loc: base + '/product.html?design=' + encodeURIComponent(id), priority: '0.7' });
  }
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls
      .map((u) => `  <url><loc>${xmlEscape(u.loc)}</loc><priority>${u.priority}</priority></url>`)
      .join('\n') +
    '\n</urlset>\n'
  );
}

const DESIGN_ID_RE = /^[A-Za-z0-9_-]{1,60}$/;
function safeDesignId(id) {
  return typeof id === 'string' && DESIGN_ID_RE.test(id);
}

// The canonical URL of a request: the production origin + the page's clean
// path, with tracking queries (utm_*, fbclid, a collection's ?c=) dropped. The
// one query kept is product.html's ?design=, because each design IS a different
// page; folding them all into /product.html would leave Google one blank product.
// The SPA fallback (a vanity path from an ad, /sale) canonicalises to "/" — it
// serves the home page, and should not be indexed as a second copy of it.
function canonicalUrl(file, query = {}, { fallback = false } = {}) {
  const base = origin();
  if (fallback) return base + '/';
  const page = PUBLIC_BY_FILE.get(file);
  if (!page) return null;
  if (file === 'product.html' && safeDesignId(query.design)) {
    return base + '/product.html?design=' + encodeURIComponent(query.design);
  }
  return base + page.path;
}

const BRAND = {
  name: 'דוגרי',
  alternateName: ['Dugri', 'Dugri Israel', 'דוגרי ישראל', 'דוגרי - משחק מסיבה אישי'],
  instagram: 'https://instagram.com/dugri_israel',
  phone: '+972-55-244-1334',
  businessPhone: '+972-54-657-7715',
};

const PRODUCT_DESCRIPTION =
  'משחק מסיבה מותאם אישית בסגנון ניחוש מילים: שולחים 100 עד 400 מילים על בעל או בעלת השמחה ' +
  '(אנשים, מקומות, בדיחות פנימיות, ביטויים) ומקבלים חפיסת קלפים ולוח משחק מעוצבים. ' +
  'מתנה מקורית למסיבת רווקות, יום הולדת, יום נישואין, חתונה, פרישה ופרידה.';

function organizationLd() {
  const base = origin();
  return {
    '@type': 'Organization',
    '@id': base + '/#organization',
    name: BRAND.name,
    alternateName: BRAND.alternateName,
    url: base + '/',
    logo: base + '/assets/logo.png',
    description: PRODUCT_DESCRIPTION,
    sameAs: [BRAND.instagram],
    areaServed: { '@type': 'Country', name: 'Israel' },
    contactPoint: [
      {
        '@type': 'ContactPoint',
        telephone: BRAND.phone,
        contactType: 'customer service',
        areaServed: 'IL',
        availableLanguage: ['he'],
      },
      {
        '@type': 'ContactPoint',
        telephone: BRAND.businessPhone,
        contactType: 'sales',
        areaServed: 'IL',
        availableLanguage: ['he'],
      },
    ],
  };
}

function websiteLd() {
  const base = origin();
  return {
    '@type': 'WebSite',
    '@id': base + '/#website',
    name: BRAND.name,
    alternateName: BRAND.alternateName,
    url: base + '/',
    inLanguage: 'he-IL',
    publisher: { '@id': base + '/#organization' },
  };
}

// price: the store display price (what the page prints). Omitted when unknown —
// an Offer with a wrong or zero price is worse than no Offer: Google flags a
// structured price that disagrees with the visible one.
function productLd({ price }) {
  const base = origin();
  const ld = {
    '@type': 'Product',
    '@id': base + '/#product',
    name: 'דוגרי - משחק מסיבה אישי בהתאמה אישית',
    description: PRODUCT_DESCRIPTION,
    brand: { '@id': base + '/#organization' },
    image: [base + '/assets/card-real.png', base + '/assets/hero-1.jpg'],
    category: 'Party Games',
    url: base + '/products.html',
  };
  if (Number.isFinite(price) && price > 0) {
    ld.offers = {
      '@type': 'Offer',
      price: String(price),
      priceCurrency: 'ILS',
      availability: 'https://schema.org/InStock',
      url: base + '/products.html',
      seller: { '@id': base + '/#organization' },
    };
  }
  return ld;
}

function faqLd(items) {
  const list = (Array.isArray(items) ? items : []).filter((i) => i && i.q && i.a);
  if (!list.length) return null;
  return {
    '@type': 'FAQPage',
    '@id': origin() + '/#faq',
    mainEntity: list.map((i) => ({
      '@type': 'Question',
      name: String(i.q),
      acceptedAnswer: { '@type': 'Answer', text: String(i.a) },
    })),
  };
}

// JSON inside <script> must not be able to close the tag: an FAQ answer is owner
// text, and "</script>" in it would end the block and spill the rest into the
// page. Escaping <, > and & as \u-sequences keeps it valid JSON and inert HTML.
function scriptSafeJson(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

const attrEscape = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

// The tags for one page. `html` is passed so a tag the page already carries is
// not duplicated (a page with its own og:image keeps it).
function headTags({ file, query, fallback = false, indexable, price, faq, html = '' }) {
  const out = [];
  const isPublic = fallback || isPublicPage(file);
  if (!indexable || !isPublic) {
    if (!/<meta\s+name="robots"/i.test(html)) out.push('<meta name="robots" content="noindex" />');
    return out.join('\n    ');
  }
  const canonical = canonicalUrl(file, query, { fallback });
  if (canonical) {
    out.push(`<link rel="canonical" href="${attrEscape(canonical)}" />`);
    if (!/property="og:url"/i.test(html))
      out.push(`<meta property="og:url" content="${attrEscape(canonical)}" />`);
  }
  if (!/property="og:image"/i.test(html))
    out.push(`<meta property="og:image" content="${origin()}/assets/hero-1.jpg" />`);
  if (!/property="og:site_name"/i.test(html))
    out.push('<meta property="og:site_name" content="דוגרי" />');
  if (!/property="og:locale"/i.test(html))
    out.push('<meta property="og:locale" content="he_IL" />');

  const graph = [organizationLd(), websiteLd()];
  const isHome = fallback || file === 'index.html';
  if (isHome || file === 'products.html') graph.push(productLd({ price }));
  if (isHome) {
    const f = faqLd(faq);
    if (f) graph.push(f);
  }
  out.push(
    '<script type="application/ld+json">' +
      scriptSafeJson({ '@context': 'https://schema.org', '@graph': graph }) +
      '</script>'
  );
  return out.join('\n    ');
}

// Insert before </head>; a page without one is returned untouched.
function inject(html, tags) {
  if (!tags) return html;
  const i = html.search(/<\/head>/i);
  if (i === -1) return html;
  return html.slice(0, i) + '    ' + tags + '\n  ' + html.slice(i);
}

// llms.txt (llmstxt.org): a Markdown brief an AI assistant can read in one go,
// instead of reconstructing the business from carousels and scripts. Built from
// the same live price and FAQ the pages show, so it can't drift from them.
function llmsTxt({ price, faq }) {
  const base = origin();
  const lines = [
    '# דוגרי (Dugri)',
    '',
    '> דוגרי הוא משחק מסיבה אישי בהתאמה אישית מישראל: משחק ניחוש מילים בקבוצות שכל המילים בו הן על בעל או בעלת השמחה. ' +
      'Dugri is an Israeli personalized party game: a team word-guessing game where every word is about the guest of honour.',
    '',
    'דוגרי (באנגלית Dugri, אתר: dugri-israel.co.il) הוא מותג ולא רק המילה בעברית. מזמינים באתר, אוספים 100 עד 400 מילים על החוגג או החוגגת ' +
      '(לבד או עם חברים, דרך קישור שיתוף), ומקבלים חפיסת קלפים ולוח משחק מעוצבים. מתאים למסיבת רווקות ורווקים, יום הולדת (במיוחד עגול), ' +
      'יום נישואין, חתונה, זוגות, פרישה, פרידה ואירועי חברה.',
    '',
    '## עובדות עיקריות',
    '',
    '- איך משחקים: מתחלקים לקבוצות, שולפים קלף ומתארים את המילה בלי להגיד אותה; הקבוצה מנחשת כמה שיותר עד שהטיימר מצלצל.',
    '- כמה מילים: מינימום 100, עד 400. נשלח דף עזר עם קטגוריות ודוגמאות.',
    '- זמן אספקה: עד 4 ימי עסקים מרגע שליחת רשימת המילים (לא מרגע התשלום).',
    '- איסוף עצמי: בית הדפוס גלאור, התחייה 14 תל אביב, כניסה B, קומה ראשונה (ראשון עד חמישי).',
  ];
  if (Number.isFinite(price) && price > 0) lines.push(`- מחיר: ${price} ₪ (מחיר עדכני באתר).`);
  lines.push(
    '- לעסקים ולכמויות: וואטסאפ 054-657-7715.',
    '- שירות לקוחות: וואטסאפ 055-244-1334. אינסטגרם: @dugri_israel.',
    '',
    '## עמודים',
    '',
    `- [דף הבית](${base}/): מה זה דוגרי, ביקורות ושאלות נפוצות`,
    `- [העיצובים](${base}/products.html): כל עיצובי המשחק`,
    `- [איך זה עובד](${base}/how.html)`,
    `- [הזמנה](${base}/options.html)`,
    `- [רשימות מילים](${base}/wordlists.html): רעיונות למילים`,
    `- [איסוף עצמי](${base}/pickup.html)`,
    `- [טיימר 60 שניות](${base}/timer.html)`,
    `- [תקנון](${base}/terms.html)`
  );
  const list = (Array.isArray(faq) ? faq : []).filter((i) => i && i.q && i.a);
  if (list.length) {
    lines.push('', '## שאלות נפוצות', '');
    for (const i of list) lines.push(`### ${String(i.q).trim()}`, '', String(i.a).trim(), '');
  }
  return lines.join('\n').replace(/\n+$/, '') + '\n';
}

module.exports = {
  DEFAULT_HOST,
  PUBLIC_PAGES,
  seoHost,
  origin,
  isIndexableHost,
  isPublicPage,
  robotsTxt,
  sitemapXml,
  canonicalUrl,
  headTags,
  inject,
  llmsTxt,
  scriptSafeJson,
};
