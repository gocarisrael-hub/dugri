# Inventory: what must survive the redesign

Phase 1 of REDESIGN_PLAN.md, written 2026-10-12 against `4d9744e` (origin/main). Read-only survey of groups A, B and C plus the shared pieces. Group B (options, collect, proof, pickup, pay-success, pay-done, timer, wordlists) must keep flow, fields, logic, IDs and selectors unchanged; this file is that safety net. Group A is redesigned freely but must keep every hook listed here working.

How to read it: each page has (a) content that must survive, (b) behaviour and the hooks it depends on (IDs, classes JS touches, data-\* attributes, `data-edit` keys, `data-testid`, analytics, API calls), (c) dynamic data and where it comes from, (d) what is only old styling and may be thrown away. Sections end with drop candidates and the top must-keep items.

## Rules that apply to every page

- **Live copy lives in the content store, not the HTML.** Every `data-edit`, `data-edit-img`, `data-edit-pd` and `data-edit-photos` element's shipped text is only the default; the owner's overrides are stored per page by key (`GET /api/content?page=<file>`, written by the editor at `?edit=1` with the admin key). Renaming or deleting a key silently orphans her edit. `tests/unit/site-editability.test.js` pins keys per page. Example: production `how.html` says "תוך 48 שעות" and the home story is signed "הדר ועלמה" through overrides, while the repo HTML says otherwise. Mockups must start from production.
- **`<meta name="dugri:page" content="<file>">`** picks the content bucket (also for extensionless URLs such as `/how`, `/pickup`).
- **The inline GA stub is also the Meta-pixel switch.** `server/meta-pixel.js` injects the pixel only into pages containing the literal `window.dataLayer = window.dataLayer || []`. Keep that head stub byte-identical, with `js/consent.js` (defer) and `js/analytics.js` (module). `tests/unit/analytics-coverage.test.js` pins these tags.
- **Asset hashing.** `server/asset-hashing.js` rewrites plain `src`/`href` paths to content-hashed names and injects an importmap before the first `<script type="module">`. New CSS/JS must live under `site/` and be referenced plainly (no query strings).
- **Fonts** load only via `/assets/fonts/fonts.css`; `tests/e2e/fonts-self-hosted.spec.js` fails on any Google Fonts request.
- **`hidden` attribute vs CSS `display`.** proof, pay-success, wordlists and collect toggle visibility with `hidden`; collect also uses a `.hidden` class, and an element needs both cleared to show. A new `display:` rule un-hides things. Add `[hidden]{display:none!important}` in the new base CSS and keep the `.hidden` rules.
- **Prices and versions** come only from `/api/pricing` (server/settings.js `pricing.*`, edited in `site/admin-pricing.html`). Price hooks: `.amt`, `.was`, `[data-price-now]`, `[data-price-was]`, `[data-sale-label]`, `#saleBanner[data-sale-banner]`, `html[data-sale]` rules in tokens.css.
- **WhatsApp numbers** 972552441334 (support) and 972546577715 (business) are asserted by `tests/e2e/wa-numbers.spec.js` and appear hardcoded in several pages and scripts.
- **Fixed URLs.** `/pickup` and `unsubscribe.html?e&t` are in emails already sent; `pay-done.html` (and `?error`) is registered with the payment provider; `collect.html?c&k`, `proof.html?c&t` and `partner.html?t` are sent to customers; `/timer.html` is linked from every menu and possibly printed on boards (not verifiable from the repo, see the timer section).

## Screenshot notes

`redesign/screens/<group>-<page>-<390|1440>.png`, full page, cookie notice pre-dismissed (`localStorage.dugri_cookie_notice = 'shown'`), analytics requests blocked, lazy media forced to load.

- From production (real content): index, how, products, product (`?design=bachelorette`), options, pickup, pay-success, timer, wordlists, terms.
- From the local server in this worktree (seeded test collection, no production orders): collect.
- Local with mocked API responses, because these pages need a private token: partner (`/api/partner/*` mocked with fictional figures), proof (`/api/collections/*/proof*` mocked; cards are the repo's sample `card-front.png` / `card-back.png`), unsubscribe (`/api/unsubscribe/status` mocked as subscribed, fictional address).
- pay-done is shot in its `?error` state, the only state that stays on screen at top level (success redirects to pay-success at once).
- Fixed bars (options bottom bar, how sticky bar, collect WhatsApp float) appear mid-page in full-page captures; that is a capture artefact.

## Group A: storefront pages and shared pieces

Source: worktree `/Users/hadar/projects/dugri-redesign` at `4d9744e` (= origin/main at time of reading). Read-only; nothing edited.

Conventions below: "key" = a `data-edit` content key (owner overrides stored per page via `/api/content?page=<file>`). Every `data-edit*` element's shipped text IS the default; the store holds only overrides, so a renamed/removed key silently orphans the owner's saved edit. `tests/unit/site-editability.test.js` pins keys per page; `tests/unit/analytics-coverage.test.js` pins the GA stub on buyer pages (index, products, product, how, options, collect, pay-success...).

Every buyer page head (index/how/products/product) carries, in order: `<meta name="dugri:page" content="<file>">` (editor uses it to pick the content bucket, also for extensionless URLs like `/how`), the inline GA stub (`window.dataLayer = window.dataLayer || []` + `gtag('consent','default',{analytics_storage:'denied'})`, also the server's marker for Meta pixel injection), `js/consent.js` (defer), `js/analytics.js` (module), favicon/manifest/PWA metas, `/assets/fonts/fonts.css` (print-swap preload + noscript), `/css/tokens.css`.

### 1. site/index.html (home)

#### (a) Content that must survive (in order)

1. Header (shared `.hdr`, see Shared pieces). CTA "הזמינו עכשיו" -> products.html. Menu: להזמנה (options.html, explainer), החנות, המלצות (#reviews), הסיפור שלנו (#story), שאלות (#faq), טיימר (timer.html).
2. Sale strip `#saleBanner` (hidden, empty; filled from `/api/pricing` sale.banner).
3. Hero `#top`: 3 photo slides (assets/hero-1/2/3.jpg), each title + CTA "לרכישה ›" -> products.html.
   - h1 "מסיבת רווקות לחברה הכי טובה? יום נישואין? אבא בן 50? יש לנו את המתנה המושלמת"
   - "דוגרי, המתנה הכי אישית ומקורית שאפשר לתת" (slide 2: CTA above title)
   - "מחפשים מתנה בלי פילטרים? מזל שאתם כאן"
4. Marquee ribbon: "מפעילים את הטיימר ◆ מנחשים מילים ◆ הכל עליכם" (aria-hidden, duplicated 8x for the loop).
5. `#about` "מה זה דוגרי?" + body + stat box: count `[data-testid=orders-count]` (shipped 23) + "חגיגות עד היום".
6. (Optional, injected) promo/new-game block before or after `#products`.
7. `#products` "העיצובים שלנו" + sub "כל עיצוב מתאים לכל חגיגה - את הכותרת אתם כותבים" + rail `#productsTrack` + ghost CTA "מעבר אל החנות ›" -> products.html.
8. `#reviews` "מה מספרים עלינו" / "ככה זה נראה כשהמשחק מגיע לשולחן" / ★★★★★ + 4 WhatsApp screenshot images (assets/testimonials/review-1..4.jpg, real alt texts) + `#reviewsControls`.
9. `#story` kicker "הסיפור שלנו", h2 "למה התחלנו את דוגרי", 2 paragraphs, sign "הצוות של דוגרי", 2 photos (assets/gallery-1/2.jpg).
10. `#faq` "שאלות נפוצות" + `#faqList` with 6 shipped `<details>` (defaults; replaced by `/api/faq`).
11. `#order` final: "מוכנים להפתיע?" + sub + CTA "בונים את המשחק ›" -> products.html + WhatsApp "יש שאלה? דברו איתנו בוואטסאפ" (`#waCtaLink`).
12. `#business` B2B band: "דוגרי לעסקים", sub, trio (מתנה לצוות / כנסים וגיבושים / משחק ממותג), WhatsApp CTA to the B2B number 972546577715 with prefilled Hebrew text (literal href).
13. Footer (inline, see Shared pieces).

#### (b) Behaviour and JS hooks

- Scripts: consent.js, analytics.js (module), header.js, editor.js, start-explainer.js (all defer); inline module importing carousel.js, designs.js (`PUBLIC_DESIGNS, syncDesignNames, loadCustomDesigns`), pricing.js (`fetchPricing, applySale, restampSale, PRICING_FALLBACK`), faq.js (`initFaq`), promo.js (`initPromo`), design-images.js (`loadDesignImages, galleryFor, srcsetFor, SIZES`), lazy-media.js (`defer, watchTrack`). Two classic inline scripts: scroll reveal (`[data-reveal]` -> `.is-in`) and CONFIG (WhatsApp/IG hrefs).
- Hero: `.hero-track` -> `initCarousel(.., {mode:'fade', interval:6000, loop:true, dots:false, arrows:false})`; slides `.hero-slide`, bg `img.hero-slide__bg`.
- Products rail: `#productsTrack`; cards built in JS: `a.home-prod-card[data-design-id][data-label][data-ga=order_started][data-ga-cta=home-products]` -> `product.html?design=<id>`; children `.home-prod-thumb > img[data-store-default]` (deferred via lazy-media), `.sale-flag[data-sale-label]` ("מחיר השקה"), `.home-prod-name` (name trimmed to 3 words), `.home-prod-price` (`.amt` + `s.was > .amt`). `initCarousel(track,{mode:'scroller', loop:true, dots:false})`; teardown via `track.__carousel.destroy()`; clones get `data-carousel-clone` and are re-stamped (names/images/sale) by selector.
- Counter: `[data-testid="orders-count"]`, only replaced by a positive number.
- Reviews: `#reviewsTrack` -> `initCarousel({mode:'slideshow', loop:true, autoplay:false, dots:true, arrows:true, dotsInto/arrowsInto:#reviewsControls})`. Review images are EAGER on purpose (lazy broke loop positioning).
- FAQ: `initFaq(#faqList)`; if `/api/faq` returns empty list the whole `<section>` is hidden.
- Promo: `initPromo()` anchors on `#products` (`rail.before/after`), section `data-testid=home-promo`, classes `.sec-title.promo-head`, `.promo-badge`, `.promo-photos[data-count]`, `.promo-cta`, buttons `data-ga=order_started data-ga-cta=home-promo`. Deliberately no `data-reveal`.
- CONFIG script: sets `#waLink` and `#waCtaLink` href to `https://wa.me/972552441334?text=היי! אני רוצה להזמין משחק דוגרי`; `#igLink` / `#igLabel` (@dugri_israel). `window.dugriSetPlanSum` fed from pricing.
- Explainer trigger: `a[data-start-explainer]` = menu item `[data-testid=nav-order-flow]` (only one on the page).
- IDs: about business faq faqList igLabel igLink navMenu order products productsTrack reviews reviewsControls reviewsTrack saleBanner story top waCtaLink waLink.
- data-testid: b2b-wa footer-b2b footer-pickup footer-terms footer-wordlists hero-marquee home-about home-products home-products-sub nav-menu nav-order-flow nav-toggle order-now orders-count proof-reviews sale-banner.
- data-edit keys (49):
  - nav: index-nav-order, index-nav-orderflow, index-nav-shop, index-nav-reviews, index-nav-story, index-nav-faq, index-nav-timer
  - hero: index-hero-1-title, index-hero-2-title, index-hero-3-title, index-hero-cta-1, index-hero-cta-2, index-hero-cta-3
  - marquee: index-marquee-1, -2, -3 (each repeated 8x; editor sets all nodes with the key)
  - about: index-about-heading, index-about-body, index-stat-label
  - products: index-products-heading, index-products-sub, index-products-cta
  - reviews: index-reviews-heading, index-reviews-sub
  - story: index-story-kicker, index-story-heading, index-story-p1, index-story-p2, index-story-sign
  - faq: index-faq-heading
  - final: index-final-heading, index-final-sub, index-final-cta, index-final-wa
  - b2b: index-b2b-heading, index-b2b-sub, index-b2b-1-title, index-b2b-1-body, index-b2b-2-title, index-b2b-2-body, index-b2b-3-title, index-b2b-3-body, index-b2b-cta
  - footer: index-footer-brand, index-footer-wa-label, index-footer-mail-label, index-footer-b2b-label, index-footer-b2b, index-footer-tag
- data-edit-img (9): index-hero-1, index-hero-2, index-hero-3, index-review-1..4, index-story-photo-1, index-story-photo-2.
- data-ga: `order_started` with data-ga-cta = nav, nav-menu, hero (x3), home-products (CTA + every rail card), final; `contact_click` with data-ga-channel/where = whatsapp/final, whatsapp/b2b-band, whatsapp/footer, call/footer, instagram/footer. Explainer adds GA events order_explainer_opened/continue/whatsapp.
- Fetches: /api/pricing, /api/stats/orders, /api/faq, /api/promo, /api/design-names, /api/custom-designs, /api/design-images, /api/content?page=index.html (editor), /api/track (attribution).
- URL params: `?edit=1&key=` (editor), `?explainer=1` (opens explainer on load), utm\_\*/fbclid/gclid (attribution).

#### (c) Dynamic data and source

- Store price/was on rail: `/api/pricing` -> routes/commerce.js `registerPricing` -> `db.effectivePricing()` -> settings `pricing.store_now` (199) / `store_was` (239). Fallback `PRICING_FALLBACK` in js/pricing.js.
- Sale mode: same payload `sale {on,label,banner}` from `db.saleInfo()` (settings `pricing.sale_on`, `sale_label`, `sale_banner` with {now}/{was}/{saving}; on only if was > now). `applySale` sets `html[data-sale=on|off]`, fills `[data-sale-label]` and `[data-sale-banner]`.
- Counter: `/api/stats/orders` -> commerce.js: `ORDERS_COUNT_BASE` env (default 23) + `db.countPaidOrders()`.
- Designs: bundled `js/designs.generated.js` via `PUBLIC_DESIGNS` (designs.js); names from `/api/design-names` (catalog.js 814, themes.json display_he on the volume); uploaded templates from `/api/custom-designs` (catalog.js 861); images from `/api/design-images` (catalog.js 1147; owner gallery config + srcsets for /content-uploads ladders).
- FAQ: `/api/faq` (platform.js 1824) -> `faq.publicFaq(settings faq.list)`, default `DEFAULT_FAQ` in server/faq.js (must mirror the HTML defaults).
- Promo: `/api/promo` (catalog.js 1345) -> `promo.publicPromo(settings promo.block)`, default OFF; edited in admin-newgame.html.
- Text/images: `/api/content?page=index.html` (platform.js 340), uploads served by `/content-uploads/:name` (16-hex + webp/jpg/png).

#### (d) Old styling, safe to discard

The 900-line inline `<style>` (hero scrim, marquee animation, `.stat-box`, `.home-prod-*` card look, `.review` frames, `.story-*`, `.b2b-trio`, footer icon colours incl. Instagram gradient stops #fdf497/#fd5949/#d6249f), inline `style="justify-content:center"`, reveal animation CSS. Keep only the behavioural classes listed in (b).

#### Flags

- Dead code: CONFIG `tranzilaTerminal`, `successUrl: 'https://YOUR-DOMAIN/'`, `plans`, `pay()` and `window.dugriSetPlanSum` (fed by pricing but nothing calls `pay()`). Payment is PeleCard/Tranzila server-side.
- Meta description / about body say "מוכנים להדפסה" (ready to print) while the product is a printed deck picked up at Galor print shop (FAQ). Slightly stale.
- FAQ default "כמה מילים צריך לשלוח? מינימום 100, ועד 400" contradicts collect.html (WORD_GOAL 70, DEFAULT_MAX_WORDS 412, "מינימום 70"), settings reminder "70+ המילים", how.html "מינימום 70", and product buy-note "ללא הגבלת מילים". Same text is in server/faq.js DEFAULT_FAQ; the live text is whatever the owner saved in admin-faq.
- `og:image` TODO.
- Two WhatsApp numbers: support 972552441334 and B2B 972546577715 (FAQ, footer b2b line, b2b band). Both hardcoded.

### 2. site/how.html ("איך זה עובד")

#### (a) Content

1. OLD nav `.nav` (not the shared header): logo, links העיצובים שלנו (products), איך זה עובד? (self), הצצה (index.html#gallery), המלצות (index.html#proof), טיימר, CTA הזמנה (products).
2. Header `#top`: h1 "איך זה עובד?", lede "שלושה צעדים פשוטים - שולחים מילים, אנחנו מעצבים, ואתם מדפיסים ומשחקים. הנה כל התהליך ומה בדיוק מקבלים בקובץ.", CTA "בונים את המשחק · 199 ₪ ~~239 ₪~~" -> products.html, ghost "חזרה לעמוד הבית".
3. `#how` 3 steps: ממלאים בלי להתאמץ ("...מינימום 70", hint "שלחנו לכם דף עזר..."), אנחנו עושים את הקסם, מדפיסים ומשחקים ("PDF מוכן, מתאים לכל בית דפוס... עד 4 ימי עסקים").
4. `#included` "מה מקבלים" / "חבילה שלמה, נשלחת במייל או בוואטסאפ": 4 items (חפיסת קלפים, לוח משחק, חוקים, הדפסה בלי כאב ראש) + note "הכל כלול בקובץ אחד - ב-199 ₪."
5. `#order` final "מוכנים להפתיע אותה?" + priced CTA + WhatsApp `#waCtaLink`.
6. Footer (inline copy, no b2b line).
7. Sticky bottom bar `.sticky`: `#stickyOrder` "מזמינים · price" + `#waSticky`.

#### (b) Hooks

- Scripts: consent.js, analytics.js, editor.js. NOT header.js, NOT start-explainer.js, no header.css/carousel.css.
- Inline classic script 1: reveal (`.reveal`, `.stagger` -> `.is-in`, adds `html.reveal-on`), confetti into `#confetti` (element does not exist: dead), nav toggle `.nav-toggle` / `#navLinks.open`.
- Inline script 2: CONFIG + dynamic `import('./js/pricing.js')` -> `applySale`, fills every `[data-price-now]` and `[data-price-was]`; WhatsApp hrefs for `#waLink #waCtaLink #waSticky`; IG; dead `pay()`.
- IDs: how igLabel igLink included navLinks order stickyOrder top waCtaLink waLink waSticky. testids: footer-pickup footer-terms footer-wordlists nav-links nav-toggle.
- data-edit keys (39): nav how-nav-designs, how-nav-how, how-nav-peek, how-nav-reviews, how-nav-timer, how-nav-order; hero how-hero-heading, how-hero-lede, how-hero-back; steps how-steps-heading, how-steps-sub, how-step1-title, how-step1-body, how-step1-hint, how-step2-title, how-step2-body, how-step3-title, how-step3-body; included how-included-heading, how-included-sub, how-item1..4-title, how-item1..4-body, how-delivery-note; final how-final-heading, how-final-sub, how-final-wa; sticky how-sticky-wa; footer how-footer-brand, how-footer-wa-label, how-footer-mail-label, how-footer-tag. (The priced CTAs carry no data-edit.)
- data-ga: order_started cta = nav, how-hero, final, sticky; contact_click whatsapp final/footer/sticky, call footer, instagram footer.
- Fetches: /api/pricing, /api/content?page=how.html, /api/track.

#### (c) Dynamic data

Only prices (`[data-price-now]`, `[data-price-was]` from `/api/pricing` store) and sale switch (hides `.was` when off). No sale banner element. "199 ₪" inside `how-delivery-note` is literal text, NOT updated by pricing.

#### (d) Old styling

Entire 1350-line inline `<style>`. Large dead CSS for removed sections: .audience/.aud-card/.aud-emoji, .occasions, .vclips/.hero-video, .launch-offer, .urgency, .guarantee, .trust, .plan-promise, .anchor, .addons, .btn-reassure, .faq, .gphoto, .tagline, .brand-logo, confetti/sparkle (sage palette #8ca287 etc., off-brand).

#### Flags (verified)

- Stale product description: describes a print-it-yourself PDF ("אתם מדפיסים", "PDF מוכן, מתאים לכל בית דפוס", "מה בדיוק מקבלים בקובץ", "נשלחת במייל או בוואטסאפ", "הכל כלול בקובץ אחד", "הוראות... איפה גוזרים"). The live product is a printed deck: pricing defaults `pdf_enabled:false`, `pickup_enabled:true`, index FAQ says pickup at Galor print shop.
- Word count: "מינימום 70" matches collect.html but contradicts the index FAQ (100-400).
- Hardcoded "ב-199 ₪" in an editable note; hardcoded 199/239 in CTAs (overwritten by JS).
- Dead nav anchors: index.html#gallery and #proof do not exist on index (index has #reviews, no gallery).
- Inbound links: options.html fixed nav (`options-nav-how`, visible), pickup.html menu, admin-ads.html landing-page option `/how.html`, admin-newgame placeholder `/how.html`, editor.js page picker. NOT linked from index/products/product or any footer.

### 3. site/products.html (store grid)

#### (a) Content

1. Shared header; CTA "הזמינו עכשיו" -> products.html. Menu: החנות, המלצות, הסיפור שלנו, שאלות, טיימר (no "להזמנה" item, unlike index).
2. `.store` head: h1 "העיצובים שלנו", sub "בוחרים עיצוב, כותבים את הכותרת שלכם. אותו משחק - לכל אירוע וכל חגיגה.", B2B line "לעסקים: מזמינים כמה יחידות לצוות או לאירוע גדול? דברו איתנו ›" (B2B WhatsApp link with prefilled text).
3. `#storeGrid` product cards (JS).
4. Footer (inline, with b2b line).

#### (b) Hooks

- Scripts: consent, analytics, header.js, editor.js, start-explainer.js; inline module importing carousel.js, designs.js (`PUBLIC_DESIGNS, syncDesignNames, loadCustomDesigns`), pricing.js, design-images.js, lazy-media.js, product.js (`overrideKeys, overrideText`).
- Card DOM: `article.product-card[data-testid=product-card][data-design-id]` > `.product-card__media` (`.sale-flag[data-sale-label]`, `.product-card__track` of `a.product-card__slide[data-label]` > `img` (first: `data-testid=product-image`, `data-store-default`)), `.product-card__dots`, `a.product-card__caption[data-testid=product-link]` > `.product-name`, `.product-price` (`.now > .amt`, `s.was > .amt`). Links `product.html?design=<id>`. Multi-image cards: `initCarousel(track,{mode:'slideshow', autoplay:false, loop:false, dots:true, dotsInto/arrowsInto: dots})`.
- Grid CSS var `--card-aspect` set to `1 / 1` when any design is portrait.
- Error fallback: `.store-fallback` + `a.btn[href=options.html][data-start-explainer]` (the only explainer trigger on this page).
- Name precedence: content override `product-<id>-name` (from `/api/content?page=product.html`) > `/api/design-names` > bundled name.
- IDs: igLabel igLink navMenu storeGrid waLink. testids: footer-b2b footer-pickup footer-terms footer-wordlists nav-menu nav-toggle order-now store-b2b store-grid store-sub (+ product-card, product-image, product-link from JS).
- data-edit keys (17): products-nav-order, products-nav-shop, products-nav-reviews, products-nav-story, products-nav-faq, products-nav-timer, products-heading, products-sub, products-b2b-label, products-b2b, products-b2b-cta, products-footer-brand, products-footer-wa-label, products-footer-mail-label, products-footer-b2b-label, products-footer-b2b, products-footer-tag.
- data-ga: order_started nav; contact_click whatsapp store-b2b / footer, call footer, instagram footer. Cards carry no data-ga.
- Fetches: /api/pricing, /api/design-names, /api/custom-designs, /api/design-images, /api/content?page=product.html (names) and ?page=products.html (editor), /api/track.

#### (c) Dynamic data

Prices + sale (`/api/pricing`), catalog (bundled + `/api/custom-designs`), names, gallery images per design (`galleryFor(map, d, 'products')`, `/api/design-images`, uploads under /content-uploads with srcset). No sale banner element here (only flags + struck prices).

#### (d) Old styling

Inline `<style>` (~490 lines): grid layout, card media/caption look, dots, store head typography. Footer `#waLink` here has a literal href `https://wa.me/972552441334` (no prefilled text, no CONFIG script).

### 4. site/product.html (PDP, `?design=<id>`)

#### (a) Content

1. Shared header plus `.hdr-lead` back link `a.pdp-back[data-testid=pdp-back]` "לחנות" (history.back when same-origin referrer).
2. `.pdp-gallery` (sale flag, `#galleryTrack`, `#galleryDots`, zoom button `#galleryZoomOpen`).
3. `.pdp-head`: `h1#pdpTitle` (design name), price `#pdpPriceNow` / `#pdpPriceWas`, buy block: `a#pdpBuy` "מתחילים לבנות את המשחק ›" (explainer -> `options.html?design=<id>&step=2`), note "מבצע השקה" (`.buy-note-sale`, hidden when sale off) + "מוכן תוך 4 ימי עסקים · ללא הגבלת מילים".
4. `.pdp-title-note` "הכותרת נכתבת על ידכם" + body ("...למשל "40 לרונית". היא מודפסת על הקלפים ועל הלוח.").
5. `.pdp-sec` "על העיצוב" + `#pdpAbout` (per-design ABOUT text in product.js, or GENERIC).
6. `.pdp-sec` "מה בפנים" (icon assets/icons/whats-inside.svg) list of 4: חפיסת קלפים מותאמת אישית / לוח משחק / דף חוקים / הוראות הדפסה וגזירה.
7. `.pdp-related` "עוד עיצובים" / "אותו משחק, כל עיצוב במגוון צבעים" + `#relatedTrack` + "מעבר אל החנות ›".
8. Footer; fullscreen zoom overlay `#pdpZoom` (`#pdpZoomTrack`, `#pdpZoomDots`, `#pdpZoomClose`).

#### (b) Hooks (js/product.js, module, auto-boots when `#galleryTrack` exists)

- Reads `?design=` (falls back to first public design; custom designs switch in after `/api/custom-designs`).
- Gallery slides `.pdp-gallery-slide`, zoom slides `.pdp-zoom-slide` (pinch-zoom.js), aspect via `.pdp-gallery` (LANDSCAPE 841.92/595.5 vs PORTRAIT 1/1).
- Related rail cards `a.pdp-rel-card[data-design-id][data-label]` (aria-current on the current one) > `.pdp-rel-thumb img`, `.pdp-rel-name`, `.pdp-rel-price`; carousel mode scroller.
- Per-design editing: elements with `data-edit-pd="<field>"` get `data-edit="product-<id>-<field>"` stamped at runtime, with fallback to legacy `product-<field>`. `#pdpTitle` -> `product-<id>-name`, `#pdpAbout` -> `product-<id>-about`, gallery gets `data-edit-photos="product-<id>-photos"` (owner photo array, listens to `dugri:photos-changed`). Uses `window.dugriEditor.onReady/notifyInjected`.
- data-edit-pd fields (10): about-heading, buy-cta, buy-note-sale, buy-note-rest, inside-1..4, related-heading, related-sub. (A removed `inside-5` is retired by having no element.)
- Static data-edit keys (16): product-back-label, product-nav-order, product-nav-shop, product-nav-reviews, product-nav-story, product-nav-faq, product-nav-timer, product-title-note-heading, product-title-note-body, product-store-cta, product-footer-brand, product-footer-wa-label, product-footer-mail-label, product-footer-b2b-label, product-footer-b2b, product-footer-tag. "מה בפנים" heading is not editable.
- IDs: galleryDots galleryTrack galleryZoomOpen igLabel igLink navMenu pdpAbout pdpBuy pdpPriceNow pdpPriceWas pdpTitle pdpZoom pdpZoomClose pdpZoomDots pdpZoomTrack relatedTrack waLink.
- testids: footer-b2b footer-pickup footer-terms footer-wordlists gallery-enlarge nav-menu nav-toggle order-now pdp-back pdp-buy pdp-buy-block pdp-buy-note pdp-gallery pdp-related pdp-title-note pdp-zoom pdp-zoom-close sale-flag.
- data-ga: order_started nav, pdp; contact_click footer x3.
- Fetches: /api/content?page=product.html (shared with editor), /api/pricing, /api/design-names, /api/design-images, /api/custom-designs, /api/track. `document.title` = "<name> · דוגרי".

#### (c) Dynamic data

Price (store now/was), sale flag/note, names, owner photos (content `product-<id>-photos` imgs, validated `/content-uploads/<16hex>.<ext>`), design gallery config, board slide shown only when design ships a board or owner uploaded one.

#### (d) Old styling

Inline `<style>` (~850 lines). Hardcoded `79 ₪` / `129 ₪` in the price markup (old PDF prices) are overwritten on boot by product.js (seed 199/239, then `/api/pricing`). Note product.js seeds its own `PRICE=199, WAS=239` rather than `PRICING_FALLBACK`.

#### Flags

- "ללא הגבלת מילים" vs "מינימום 70 / max 412" vs FAQ "100-400".
- "הוראות הדפסה וגזירה" in "מה בפנים" suggests a self-print PDF; product is a printed deck.

### 5. site/partner.html (affiliate earnings report)

#### (a) Content

Private, `noindex,nofollow`. Title "הרווחים שלי — דוגרי". `#app` (hidden until loaded): h1 `#hello` ("הרווחים של <name>"), `#rate` (commission wording, fixed vs %; customer discount %), `#code`; 4 tiles: מכירות `#tSales`, הרווחת `#tEarned`, שולם לך `#tPaid`, נותר לתשלום `#tOwed`; table `#sales` (הזמנה, תאריך, עותקים, הלקוחה שילמה, היא חסכה, הרווח שלך) in `#salesWrap` (empty message "עוד לא נרשמו מכירות עם הקוד שלך."); `#payTitle` + `#payouts` (תאריך, סכום, הערה) shown only if payouts; foot WhatsApp link. `#err` message box ("הקישור חסר..." / "הקישור לא תקין או שאינו בתוקף...").

#### (b) Hooks

Inline module only (no consent/analytics/editor/header: intentionally not a buyer page). `?t=<token>` -> `GET /api/partner/:token` (routes/commerce.js 973, `db.getCouponByToken` + `db.partnerReport`; uniform 404). Fields used: coupon.partner_name, commission_type, commission_value, discount_pct, code; totals.sales/earned/paid_out/outstanding; sales[].order_no/paid_at/quantity/charged_total/customer_saved/amount; payouts[].date/amount/note. Classes `.num`, `.earn`, `.tile.owed`. E2E: tests/e2e/partner-coupons.spec.js.

#### (c) Data

Coupons store (admin coupons.html sets partner fields; `POST /api/admin/coupons/:id/rotate-token` retires a link).

#### (d) Styling

Inline `<style>` (~110 lines) on tokens.css. No header/footer.

#### Inbound links (verified)

Only site/coupons.html (admin): copy-link `location.origin + '/partner.html?t=' + c.report_token` and a view button. Nothing public links to it. Keep it out of any nav/sitemap.

### SHARED PIECES

#### Header: css/header.css + js/header.js

- Used on index, products, product (and pickup per its own menu). how.html and options.html use the OLD `.nav/.nav-toggle/#navLinks` pattern with inline toggle code.
- Markup is duplicated inline per page (not injected). Classes: `.hdr`, `.hdr-inner`, `.hdr-lead` (product only), `.hdr-toggle`, `.hdr-logo`, `.hdr-order.nav-cta`, `.hdr-menu` (`.open`), `#navMenu`, role=menu/menuitem.
- header.js binds `[data-testid=nav-toggle]` and `[data-testid=nav-menu]` (fallback `#navMenu`): toggles `.open` + aria-expanded, closes on link click, outside click, Esc (returns focus).
- Order CTA: `.hdr-order[data-testid=order-now][data-ga=order_started][data-ga-cta=nav]` -> products.html, key `<page>-nav-order`.

#### Footer

Duplicated inline on every page (index/how/products/product), page-prefixed keys. Elements: brand `<page>-footer-brand`; icons `a.foot-icon.fi-wa#waLink`, `.fi-call` (tel:+972552441334), `.fi-ig#igLink` + `#igLabel`; `.foot-contact` (phone 0552441334, mailto dugri.israel@gmail.com; label keys `-footer-wa-label`, `-footer-mail-label`); `.foot-b2b[data-testid=footer-b2b]` (index/products/product, keys `-footer-b2b-label`, `-footer-b2b`; how has none); tag "צילמתם? תייגו אותנו"; `.foot-legal` links pickup.html `footer-pickup`, terms.html `footer-terms`, wordlists.html `footer-wordlists`. `.visually-hidden` labels. GA contact_click footer channels whatsapp/call/instagram. A redesign could inject it once, but keys must keep their page prefixes or existing overrides orphan.

#### WhatsApp help button: css/wa-help.css

Static markup only in options.html (`.wa-help.wa-help--docked`, `data-testid=wa-help`) and collect.html (`.wa-help`, key `collect-wa-help-label`, `--wa-help-bottom`/`--pay-bar-h`). NOT on any of the 5 pages. start-explainer.js mirrors its look inline (em units) for its WhatsApp link.

#### carousel.js (+ css/carousel.css)

`initCarousel(root, opts)` -> `{next, prev, goTo, current, pause, play, destroy}`; idempotent via `root.__carousel`. Modes: `scroller` (free glide + turbo, children get `.carousel-card`), `slideshow` (snap, `.carousel-slide`), `fade` (stacked crossfade, never clones). Options: interval (5000), autoplay, loop, dots, arrows (default on, suppressed on coarse pointers), dotsInto, arrowsInto. Adds `.carousel-track`, `.carousel--<mode>`, role=group, aria-roledescription. Loop clones carry `data-carousel-clone` and `__carouselIndex`. Controls: `.carousel-dots`/`.carousel-dot` (`.is-active`/aria-current), `.carousel-arrows`/`.carousel-arrow--prev|next` with SVG `.carousel-arrow-icon` (RTL-safe, no ‹ › glyphs). RTL handled by scrollIntoView.

#### lazy-media.js

`defer(img,{src,srcset,sizes,fallback})` moves them into `data-lazy-src`, `data-lazy-srcset`, `data-lazy-sizes`, `data-lazy-fallback`; `watchTrack(track)` hydrates `img[data-lazy-src]` near the horizontal scrollport (covers clones), `.refresh()`, `.destroy()`; error handler falls back to `data-lazy-fallback`. Needed because `loading=lazy` ignores horizontal distance. `SIZES` (design-images.js): grid, pdp, rail, zoom.

#### consent.js / analytics.js / attribution.js

- consent.js: despite the name it grants `analytics_storage` immediately and loads GA4 `G-H1W3PQGNYF` (skipped on localhost); shows a tiny "🍪 עוגיות" pill once (inline styles, `#cookieNotice`), localStorage key `dugri_cookie_notice`, auto-fades after 6s.
- analytics.js: delegated click listener on `[data-ga]` -> `gtag('event', data-ga, params)` where every `data-ga-*` becomes a param (`data-ga-cta` -> `cta`, `-channel`, `-where`); exposes `window.dugriTrack = sendEvent`; imports attribution.js.
- attribution.js: localStorage `dugri_vid` (visitor id), `dugri_attr` (first touch: landing/referrer, utm_source/medium/campaign/content/ad/term, fbclid, gclid, ttclid), sessionStorage `dugri_visit`; POST `/api/track` (platform.js 1119) on load-idle (visit) and on purchase (adds `_fbp`, source_url).
- Meta pixel: injected server-side (server/meta-pixel.js) before `</head>` only on pages containing the GA stub marker, when settings `analytics.meta_pixel_id` is set. Removing the GA stub from a page silently removes the pixel too.

#### Content editor: js/editor.js

- Overlay for everyone: GET `/api/content?page=<dugri:page>`; applies text to `[data-edit=key]` (all nodes with the key), `src` to `[data-edit-img]`, background to `[data-edit-bg]`, photo arrays to `[data-edit-photos]`; `[data-edit-scope="<bucket>.html"]` subtrees load/save from another bucket (explainer uses `start-explainer.html`).
- Edit mode: only with `?edit=1` AND an admin key (`?key=` or localStorage `dugri_admin_key`, self-clears on 403). Saves: POST `/api/admin/content?key=` (text), `/api/admin/content/image` (img upload), `/api/admin/content/photos` (arrays), staging imports `/api/admin/content|stores|templates/import-from-staging`. Page picker: index, options, collect, how, products, product, timer, and index `&explainer=1`.
- API for late-injected nodes: `window.dugriEditor.notifyInjected()`, `onReady(cb)`; event `dugri:photos-changed {key, imgs}`. Keys must pass server `keyOk` (kebab, <=61 chars).

#### start-explainer.js

Classic script; delegated click on `a[data-start-explainer]` (plain left-click only) opens a full-page 4-step sheet `#startExplainer` (`data-testid=start-explainer`, styles injected as `#dugri-start-explainer-styles`). Steps: התאמה אישית (with "אנחנו עדיין בהרצה" note), 4 תמונות, פרטי קשר, אוספים מילים. Continue button `start-explainer-continue` carries the trigger's live href (keeps `?design=<id>&step=2`). WhatsApp link to 972552441334 text "היי, יש לי שאלה לפני ההזמנה 🙂". Close X / Esc / backdrop. Keys `start-explainer-title`, `-sub`, `-continue`, `-whatsapp`, `-step1..4-title`, `-step1..4-text`, `-step1-note`, stored in bucket `start-explainer.html`. GA: order_explainer_opened/continue/whatsapp. `?explainer=1` opens on load. Triggers: index menu "להזמנה", product `#pdpBuy`, products error fallback. Loaded on index/products/product; not on how.

#### promo.js, pricing.js, design-images.js, designs.js, faq.js, demo-banner.js

- promo.js: `initPromo({anchor:'#products'})`, `buildPromo` (textContent only), `isValidPromo`.
- pricing.js: `fetchPricing` (2.5s timeout, validated, fallback 199/239, versions pdf 79 off / pickup 199 on / delivery 199 off / custom 599 off), `applySale`, `restampSale`, `fetchDeliveryExceptions` (/api/delivery-exceptions, checkout only). CSS contract in tokens.css: `.amt` isolates each "N ₪" (bidi), `.was` visibility hidden pre-resolve / display none when off, `.sale-flag` and `.sale-banner` hidden unless `html[data-sale=on]`.
- design-images.js: `loadDesignImages` (/api/design-images, {images, srcsets}), `galleryFor(map, d, surface)` (surfaces incl. 'products'), `srcsetFor`, `SIZES`, `UPLOAD_PATH_RE`.
- designs.js: `DESIGNS`/`PUBLIC_DESIGNS` from designs.generated.js, `syncDesignNames` (/api/design-names, also theme fields), `loadCustomDesigns` (/api/custom-designs), `designShipsBoard`.
- faq.js: `initFaq`, `fetchFaq` (/api/faq), renders `<details><summary>` + paragraphs + optional safe link (`link_text`/`link_url`); empty list hides the section.
- demo-banner.js: intentional no-op (beta/Bit banner retired), not referenced by these pages. Drop.

#### Importmap / content-hashed assets (server/asset-hashing.js, applied in server/index.js ~5568)

Every served HTML: `moduleAssets.inject` adds `<script type="importmap">` before the first module script (maps `/js/x.js` -> `/js/x.<8hex>.js`), and `rewriteTags` rewrites every relative `src=`/`href=` to our js/css to its hashed name (absolute URLs, `?`/`#` values untouched). Then `metaPixel.inject`. Implications for the redesign: reference assets with plain relative/root paths without query strings; new CSS/JS files are hashed automatically; any page that imports modules must have at least one `type=module` script for the map; served HTML never byte-matches the repo.

#### Fonts and tokens

- `/assets/fonts/fonts.css`: generated by scripts/fetch-fonts.mjs (do not hand-edit); self-hosted hashed woff2, hebrew+latin subsets: Assistant, Heebo, Fredoka, Gveret Levin, Playpen Sans Hebrew, Carlito, Rubik, Secular One (the latter several serve card/preview designs, not just the storefront).
- `/css/tokens.css`: palette (black/white + sand `--section #f4efe6`, accent sand; legacy names `--sage*`/`--blush` now aliased to black), `--display: Heebo`, `--font: Assistant`, thin headings `--h-weight:300`, `--radius:0`. Must-keep rules: `.amt`, `.was`, the `html[data-sale]` sale rules, `.sale-flag`, `.sale-banner`, `[data-reveal]` reduced-motion guard, focus-visible ring. Brand direction (memory): black and white, sharp corners, thin Heebo Light headings.

#### Friend coupon bar

Not on main. Lives on branch `feat/friend-coupon` (commit 073167e, NOT merged into origin/main, no PR found; checked out in another worktree). It adds `site/js/friend-bar.js` (bar on collect.html for friends who add a word, POST/GET `/api/friend-coupon`, localStorage `dugri:friendbar:done`, `dugri:owned:<id>`, CSS var `--friend-bar-h`) and `site/js/friend-coupon.js` imported from `js/analytics.js`, so if merged it would add a fixed `#couponLanding` note on EVERY buyer page for `?coupon=CODE` visits (sessionStorage `dugri:coupon`). The redesign must leave room for that fixed top note and keep analytics.js loaded. On main, collect.html only has the checkout coupon field (`#couponInput`, key `collect-coupon-label`).

### Drop candidates (with evidence)

1. how.html as a page, or at least its body copy: describes a self-print PDF ("אתם מדפיסים", "PDF מוכן", "הכל כלול בקובץ אחד - ב-199 ₪") while pricing has pdf disabled and pickup enabled; not linked from home/store/product/footer, only from options.html nav, pickup.html menu and admin pickers. If kept, rewrite to the printed-deck/pickup flow and move it onto the shared header.
2. how.html dead nav anchors `index.html#gallery` ("הצצה") and `index.html#proof` (same in options.html nav): neither id exists on index.
3. how.html confetti/sparkle script (`#confetti` absent) and ~25 dead CSS blocks (.audience, .occasions, .vclips, .launch-offer, .urgency, .guarantee, .trust, .plan-promise, .addons, .faq, .gphoto, .tagline, .brand-logo).
4. CONFIG `pay()` / tranzilaTerminal / successUrl / plans / `window.dugriSetPlanSum` on index and how: dead since server-side card payment.
5. Hardcoded prices in HTML: product.html `79 ₪`/`129 ₪`, how.html `199 ₪`/`239 ₪` x3 and literal "199" in `how-delivery-note`; product.js own seed 199/239 (use PRICING_FALLBACK).
6. Marquee 8x duplicated spans (keep keys; generate copies in JS/CSS instead).
7. Footer duplicated in 4 pages, header duplicated in 3 (plus legacy nav on how/options): candidates for one injected partial, keeping page-prefixed keys.
8. js/demo-banner.js (no-op).
9. Inconsistent menu: products/product menus lack index's "להזמנה" explainer entry; products loads start-explainer.js only for its error fallback.
10. Stale copy to reconcile (owner decision, not code): word counts (FAQ 100-400 / how 70 / collect 70-412 / product "ללא הגבלת מילים"), "מוכנים להדפסה" in meta/about, "הוראות הדפסה וגזירה" on PDP, explainer step1 "עדיין בהרצה" note.

### Top must-keep items

1. `data-edit` / `data-edit-img` / `data-edit-pd` keys exactly as listed, on elements whose shipped text is the default, plus `<meta name="dugri:page">` per page (owner's saved overrides and the editor depend on them).
2. Sale/price contract: `[data-sale-banner]#saleBanner`, `[data-sale-label]`, `.amt`, `.was`, `[data-price-now]`/`[data-price-was]`, `#pdpPriceNow`/`#pdpPriceWas`, `html[data-sale]` CSS in tokens.css, fed by `/api/pricing`.
3. Mount points filled by JS: `#productsTrack`, `#storeGrid`, `#galleryTrack`/`#galleryDots`/`#galleryZoomOpen`, `#pdpZoom*`, `#relatedTrack`, `#reviewsTrack`/`#reviewsControls`, `#faqList`, `#products` (promo anchor), `[data-testid=orders-count]`, `#pdpTitle`, `#pdpAbout`, `#pdpBuy`.
4. `a[data-start-explainer]` on wizard entry points (index menu, `#pdpBuy`), with href carrying `?design=<id>&step=2`.
5. `data-ga` / `data-ga-cta` / `data-ga-channel` / `data-ga-where` on every CTA and contact link, plus the inline GA stub in each buyer page head (also gates the Meta pixel).
6. Script includes: consent.js, analytics.js (module; pulls attribution and, if merged, friend-coupon), header.js, editor.js, start-explainer.js, and the page modules; referenced by plain paths so asset hashing rewrites them.
7. Header hooks `[data-testid=nav-toggle]`, `[data-testid=nav-menu]#navMenu`, `[data-testid=order-now]`; product `.pdp-back`.
8. Carousel/lazy-media contract: track roots without fixed widths set by JS, `data-carousel-clone` clones re-stamped by selector, `data-lazy-*` attributes, `data-design-id` on every card, `data-store-default` on cover images.
9. product.js query `?design=` + `data-edit-photos` on `[data-testid=pdp-gallery]`; partner.html `?t=` + `/api/partner/:token` IDs (`#app #err #hello #rate #code #tSales #tEarned #tPaid #tOwed #sales #salesWrap #payTitle #payouts`).
10. data-testid attributes used by ~40 E2E specs (index.spec, products.spec, product.spec, sale-mode, struck-price, how-price, start-explainer, content-editor, carousel, wa-numbers, b2b-band, partner-coupons, etc.); WhatsApp numbers 972552441334 (support) and 972546577715 (B2B) as tested by wa-numbers.spec.js.

## Group B: options.html and collect.html

Source: worktree `/Users/hadar/projects/dugri-redesign` (branch `feat/redesign`, at main `4d9744e`). Read-only survey for a restyle-only pass: nothing here may change flow, fields, logic, IDs, classes that JS or tokens.css key off, data-\* attributes, or copy that tests assert.

General rules that apply to BOTH pages

- All page logic is ONE inline `<script type="module">` at the bottom of each file (options.html L3726-7527, collect.html L3345-7889). Restyling must not move or split it; it uses top-level `await` (options: FEATURES fetch, customs wait).
- All CSS is inline: options.html main `<style>` L42-1989 plus four in-body `<style>` blocks (L2272-2330 teaser, L2484-2905 name-preview/font picker, L3129-3421 pawn step, L3435-3499 order summary). collect.html main `<style>` L39-2102 plus a tiny `:root{--wa-help-bottom}` block L7895-7905. Shared: `/css/tokens.css`, `/css/wa-help.css`, `/assets/fonts/fonts.css`.
- Head scripts that must stay: GA consent stub (`gtag('consent','default',…)`), `js/consent.js` (defer), `js/analytics.js` (module), `js/editor.js` (defer, inline content editor, reads `<meta name="dugri:page">`). `<meta name="dugri:page" content="options.html|collect.html">` is the editor's bucket key.
- `data-edit="<key>"` nodes: editor.js writes the owner's override into `textContent` on load (GET `/api/content?page=`). Keys are stored server-side; renaming a key orphans her edit. Never put child markup inside a data-edit node (it is wiped). `data-edit-img` likewise for images.
- `js/pricing.js applySale()` stamps `<html data-sale="on|off">`; tokens.css hides `.was` until resolved and when off (`html:not([data-sale]) .was`, `html[data-sale='off'] .was`). The `.was` class and `.amt` (bidi isolate for "N ₪") are load-bearing on both pages.
- The floating WhatsApp help (`a.wa-help`, `data-testid="wa-help"`, href `wa.me/972552441334?...`) is on both; styling in `/css/wa-help.css`, lift via `--wa-help-bottom`.

---

### 1. site/options.html (order wizard, 7529 lines)

#### 1(a) Content that must survive

Page frame (in order):

1. Sticky nav `nav.nav` > `.nav-inner`: logo link `index.html#top`; burger `.nav-toggle` (`data-testid=nav-toggle`, `aria-controls=navLinks`); `#navLinks.nav-links` (`data-testid=nav-links`) with links products.html / how.html / index.html#gallery / index.html#proof / timer.html / `.nav-cta` products.html (data-edit `options-nav-*`).
2. `main.wrap[data-testid=configurator]` > `.cfg-head`:
   - Price pill `.plan-pill[data-testid=plan-pill]`: "החל מ-" `#planPrice[data-testid=plan-price]` (default 199) ₪, struck `s.was#planWas > span.amt#planWasAmt` (default "239 ₪").
   - Progress: "שלב `#stepNow`(data-testid step-now) מתוך `#stepTotal`(step-total)", bar `.bar > i#barFill`.
3. Live preview `section.preview-card#previewCard[data-testid=preview]`: tabs `.tabs` with `button.tab[data-tab=front|back|board]` (testids tab-front/back/board, role=tab, aria-selected), stage `#previewStage.preview-stage` with `.preview-panel[data-panel=front|back|board]` (testids preview-front/back/board; `data-active="true"` marks the shown one), `#previewEmpty` "טוען תצוגה…", zoom button `#zoomOpen` (zoom-open). Collapsed chip `#previewChip > #continueSummary` (continue-summary; JS writes "עיצוב X · צבע Y"). Deck photo row `#deckRow.deck-row` (deck-row, hidden by default) > `#deckTrack`, `#deckDots`.

Steps (stable `data-step` ids; display order is by `activeSteps`, see 1(b)):

| data-step | testid     | Heading / content                                                                        | Fields                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --------- | ---------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | step-1     | "בחרו עיצוב" + sub (data-edit options-step1-\*)                                          | `#designList` (design-list) of JS tiles; `<details class="code-box">` (design-code-box) "יש לך קוד?": `#designCode` text (design-code-input, placeholder "קוד עיצוב"), `#designCodeBtn` "פתחו עיצוב" (design-code-btn), `#designCodeMsg` (design-code-msg, hidden)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2         | step-2     | "צבע" (DORMANT, color_picking flag)                                                      | `.color-carousel` (color-carousel) > `#colorCarouselTrack`, `#colorCarouselDots`; `#colorList` (color-list) swatches; `#rasterNote` (raster-note) "הרקע בעיצוב זה קבוע ולא משתנה עם הצבע"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 3         | step-3     | `#nameStepTitle` "הכותרת על הקלפים", `#nameStepSub` "מה שתכתבו כאן הוא בדיוק מה שיודפס…" | `label#customTitleField` (custom-title-field): `textarea#customTitleInput` (custom-title-input) rows=2 maxlength=63 required, placeholder "למשל: ליאת חוגגת 40"; hint (custom-title-hint, data-edit options-customtitle-hint, explains line-break rule); `#customTitleWarn` (amber advisory, custom-title-warn); `#customTitleBreak` suggested-break button (custom-title-break); `#customTitleErr.wiz-err` (custom-title-err, blocks Next: emoji or "כתבו כותרת כדי להמשיך"). Teaser `#previewTeaser` (preview-teaser). Name preview `#namePreview` (name-preview, DORMANT) with font picker `.wiz-fontpicker > #fontOpts` (font-opts), viewport `#namePreviewViewport` > `#namePreviewImgs` > `figure.name-preview-fig[data-npview=card                                                                                         | back | board]`each with`.np-stage`, `.np-instant[data-np-instant=…]`(>`.npi-art`, `.npi-name`), imgs `#namePreviewCard`/`#namePreviewBack`/`#namePreviewBoard`, `#namePreviewRefining`; dots `#namePreviewDots`; fallback `#namePreviewFallback`(>`#npfName`, `#npfNote`"לא הצלחנו לטעון תצוגה מקדימה כרגע",`#npfRetry`"נסו שוב"); loading`#namePreviewEmpty` (name-preview-loading) |
| 5         | step-pawns | "העלו תמונות לחיילים (רשות)" + sub                                                       | `#pawnCountToggle` "רוצים יותר חיילים? לחצו כאן" (aria-expanded/controls) → `#pawnCountPanel` ("כמה שחקנים?", `#pawnCount` buttons, `#pawnBudgetNote`); `#pawnGrid` with 4 `label.pawn-slot[data-idx=0..3]` each: `input.pawn-input[type=file][accept=image/png,image/jpeg,image/webp][data-idx]` (pawn-input-N), `.pawn-plus`, `svg.pawn-tile`, `button.pawn-remove[data-idx]` (pawn-remove-N), `.pawn-status` (pawn-status-N); slots 4..15 are cloned from slot 0 by JS. `.pawn-budget > #pawnBudgetMain` (ceiling line, JS-owned). `#pawnOver` (photos beyond count). Copy: `.pawn-cut` "החיילים מגיעים מודפסים - פשוט גוזרים אותם בעיגול." (business-critical: she cuts them herself), `.pawn-hint`, `.pawn-tip` two lines (print shop does bg removal; ChatGPT black-background tip). `#pawnErr.wiz-err`, `#pawnSkip` "דלגו" |
| 4         | step-4     | "הפרטים שלכם" / "לשליחת קישור הניהול והקובץ המוכן."                                      | `#orderSummary` (order-summary) > `#osThumb`, `#osList`. `#ownerEmail` type=email maxlength=120 autocomplete=email (owner-email) + `#emailErr` "נא להזין כתובת מייל תקינה."; `#ownerPhone` type=tel maxlength=40 (owner-phone) + `#phoneErr` "נא להזין מספר נייד תקין (לדוגמה 0521234567)."; `.wiz-pair`: `#buyerNameInput` (buyer-name-input, REQUIRED, maxlength 80, label "השם המלא של המזמין/ה", hint "לא של החוגג/ת") + `#buyerNameErr` "כתבו את שם המזמין/ה כדי להמשיך" (permanent while empty); `#eventTypeInput` (event-type-input, optional, label "סוג האירוע (רשות)", hint "במילים שלכם"). `#createErr` (create-err)                                                                                                                                                                                                   |

Sticky bar `.wiz-bar > .wiz-bar-inner`: docked WhatsApp help `a.wa-help.wa-help--docked`, `#backBtn.wiz-back` (back-btn; text "חזרה לחנות" on step 1 else "הקודם"), `#nextBtn.btn` (next-btn; "הבא", last step "צרו את המשחק", while creating "יוצר…").

Overlays: `#zoomOverlay.zoom` (zoom-overlay) > `#zoomViewport` > `#zoomContent`; `#zoomTabs` with `button.zoom-tab[data-ztab]` (zoom-tab-\*); `#zoomDots`; toolbar `#zoomOut` / `#zoomIn` / `#zoomClose`; `#zoomHint` "סובבו את המכשיר לתצוגה מלאה". Deck viewer `#deckView.deck-view[role=dialog]` (deck-view) > `#deckViewClose`, `#deckViewTrack`, `#deckViewDots`.

Validation rules (validateStep): steps 1,2,5 always valid; step 3 = non-empty trimmed title AND no emoji (`titleEmojiMessage`); step 4 = `EMAIL_RE` email AND `isValidIlMobile` AND trimmed buyer name. Title warnings: single line ≥18 chars (`TITLE_SMALL_LINE`) or word ≥12 (`TITLE_SMALL_WORD`). Pawn file: type in png/jpeg/webp ("סוג הקובץ אינו נתמך - בחרו תמונת JPG, PNG או WEBP"), ≤4MB ("הקובץ גדול מדי (עד 4MB)"). Design code msgs: "הזינו קוד", "העיצוב נפתח!", "קוד לא תקין", "יותר מדי ניסיונות, נסו שוב עוד רגע" (429), "שגיאה, נסו שוב". Create errors: server `emoji` message verbatim; generic "משהו השתבש ביצירת הקישור. נסו שוב."

#### 1(b) Flow, state and hooks

Step machine

- `TOTAL_STEPS=5`; `activeSteps = FEATURES.color_picking ? [1,2,3,5,4] : [1,3,5,4]`; last is always 4. `stepPos()` gives display number; `#stepTotal` = activeSteps.length.
- `goStep(n)`: toggles `.wiz-step.is-active` (CSS `.wiz-step{display:none}` / `.is-active` shows), `#previewCard.is-collapsed` for step ≥3, `#previewChip.hidden`, `body.is-step-color` (step 2 with color on), `#deckRow.is-tight`, bar width, `history.pushState({step})` with `?step=`, `persist()`, scroll top. Step 3 focuses title and requests preview; step 5 schedules `/api/pawn-base`; step 4 paints summary and focuses email, and fires checkout analytics once.
- `next()`: validate → on step 4 `createCollection()` else next active. `back()`: step 1 → `location.href='products.html'`. `#pawnSkip` → next. `popstate` → closes zoom if open, else goStep from `?step` (no push).
- Next disabled = !validateStep; on step 3 also gated by `previewGateOpen()` (20s backstop `PREVIEW_FALLBACK_MS`) only when name_preview is on and a theme resolves.
- Init: `restore()` → `applyFeatureFlags()` (inline `display:none` on `.color-carousel`, `.wiz-fontpicker`, `#namePreview` when off) → `selectTab('front')` → `renderDesign()` → `renderPawnCount()` → `setPawnCountOpen(players≠4)` → `goStep(initialStep,{fromPop:true})`. An unresolvable or private `?design=` pins to step 1.

State

- URL (replaceState in `persist()`): `plan` (always `base`, written never read back), `design` (id), `color` (id or `original`), `players` (only when ≠4), `step`. Read on load: `design`, `color`, `players`, `step`.
- `localStorage['dugri_selection']` = JSON `{plan, designId, designName, colorId, colorName, mainHex, customTitle, buyerName, eventType, pawnPlayers}`. customTitle/buyerName/eventType restored ONLY from here (kept out of URL).
- `localStorage['dugri_zoom_hint']` (one-time rotate hint).
- In-memory: pawn files/cutouts as object URLs until upload.
- attribution.js keeps its own localStorage touch/visitor + sessionStorage keys.

Element IDs referenced from JS (all must keep)

- Header/progress: `navLinks`, `planPrice`, `planWasAmt`, `stepNow`, `stepTotal`, `barFill`, `backBtn`, `nextBtn`.
- Preview: `previewCard`, `previewStage`, `previewChip`, `continueSummary`, `zoomOpen`, `deckRow`, `deckTrack`, `deckDots`, `deckView`, `deckViewClose`, `deckViewTrack`, `deckViewDots`.
- Step 1: `designList`, `designCode`, `designCodeBtn`, `designCodeMsg`.
- Step 2: `colorList`, `colorCarouselTrack`, `colorCarouselDots`, `rasterNote`.
- Step 3: `customTitleInput`, `customTitleWarn`, `customTitleBreak`, `customTitleErr`, `previewTeaser`, `namePreview`, `fontOpts`, `namePreviewViewport`, `namePreviewImgs`, `namePreviewCard`, `namePreviewBack`, `namePreviewBoard`, `namePreviewRefining`, `namePreviewDots`, `namePreviewFallback`, `npfName`, `npfNote`, `npfRetry`, `namePreviewEmpty`. (`nameStepTitle`, `nameStepSub`, `customTitleField` are in markup and tests.)
- Step 5: `pawnCountToggle`, `pawnCountPanel`, `pawnCount`, `pawnBudgetNote`, `pawnGrid`, `pawnBudgetMain`, `pawnOver`, `pawnErr`, `pawnSkip`.
- Step 4: `orderSummary`, `osThumb`, `osList`, `ownerEmail`, `emailErr`, `ownerPhone`, `phoneErr`, `buyerNameInput`, `buyerNameErr`, `eventTypeInput`, `createErr`.
- Zoom: `zoomOverlay`, `zoomViewport`, `zoomContent`, `zoomTabs`, `zoomDots`, `zoomIn`, `zoomOut`, `zoomClose`, `zoomHint`.

Classes / selectors queried or toggled by JS

- Queried: `.wiz-step`, `.tab` / `.tab[data-tab]`, `[data-panel=front|back|board]`, `.design`, `.thumb`, `.dname`, `.swatch`, `.font-opt`, `.wiz-fontpicker`, `.color-carousel`, `.name-preview-fig`, `[data-np-instant=…]`, `.npi-art`, `.npi-name`, `.np-dot`, `.zoom-tab`, `.zoom-dot`, `.deck-slide`, `.deck-thumb`, `.pawn-slot`, `.pawn-input`, `.pawn-remove`, `.pawn-status`, `.pawn-tile`, `[data-idx]`, `.nav-toggle`, `#previewStage .preview-panel[data-panel="front"] svg`.
- Toggled: `is-active` (steps, zoom dots, np views), `is-collapsed` (#previewCard), `is-hidden` (#backBtn, removed each refresh), `is-step-color` (body), `is-tight` (#deckRow), `is-board-view`, `is-filled` / `is-cut` / `is-pawn` / `has-card` / `is-over` (pawn slots), `is-shown`, `open` (#navLinks). `aria-pressed` on `.design`, `.swatch`, `.font-opt`, pawn count buttons; `aria-selected` on tabs; `data-active` on panels; `hidden` attribute everywhere else.
- JS-built class names (CSS must keep styling them): `design`, `thumb`, `dname`, `swatch`, `swatch-orig`, `font-opt`, `font-opt-orig`, `fo-sample`, `fo-label`, `cc-slide`, `deck-slide`, `deck-thumb`, `np-dot`, `zoom-tab`, `zoom-dot`, `os-row`, `os-k`, `os-v`, `os-swatch`, `code-msg ok|err`, `pawn-slot`.
- Inline-style hooks: `#zoomContent` `--zoom`; panel inline `--cN` palette vars (recolor); `#designList` maxHeight + `data-more` (phone cap to 2 rows, `PHONE_MQ (max-width:600px),(max-height:820px)`); scoped `<style>` injected inside SVGs (`cfg-svg-N` → `zoom-svg-N`).

data-\* attributes used by JS: `data-step`, `data-tab`, `data-panel`, `data-active`, `data-ztab`, `data-zdot`, `data-npview`, `data-npdot`, `data-np-instant`, `data-idx`, `data-design-id`, `data-picture`, `data-color-id`, `data-color-index`, `data-font`, `data-label`, `data-view`, `data-deck-key`, `data-deck-src`, `data-sig`, `data-players`, `data-more`, `[data-extra-field]` (dead, see 3).

data-testid (markup): nav-toggle, nav-links, configurator, plan-pill, plan-price, step-now, step-total, preview, tab-front/back/board, preview-stage, preview-front/back/board, zoom-open, continue-summary, deck-row, step-1, design-list, design-code-box, design-code-input, design-code-btn, design-code-msg, step-2, color-carousel, color-carousel-track, color-list, raster-note, step-3, custom-title-field, custom-title-input, custom-title-hint, custom-title-warn, custom-title-break, custom-title-err, preview-teaser, name-preview, font-opts, name-preview-viewport, name-preview-instant-card/back/board, name-preview-card/back/board, name-preview-refining, name-preview-dots, name-preview-fallback, name-preview-note, name-preview-retry, name-preview-loading, name-preview-loading-card, step-pawns, pawn-count-toggle, pawn-count-panel, pawn-count, pawn-grid, pawn-input-0..3, pawn-remove-0..3, pawn-status-0..3, pawn-budget, pawn-over, pawn-cut, pawn-hint, pawn-tip, pawn-err, pawn-skip, step-4, order-summary, owner-email, email-err, owner-phone, phone-err, buyer-name-field, buyer-name-input, buyer-name-err, event-type-field, event-type-input, create-err, wa-help, back-btn, next-btn, zoom-overlay, zoom-viewport, zoom-content, zoom-tab-front/back/board, zoom-dots, zoom-out, zoom-in, zoom-close, zoom-hint, deck-view, deck-view-close.
data-testid (JS-built): `design-<i>`, `color-<i>`, `color-orig`, `font-opt-<file>`, `font-opt-original`, `name-preview-dot-<view>`, `zoom-tab-<view>`, `zoom-dot-<view>`, `deck-thumb`, `pawn-count-<4|8|12|16>`, `pawn-input-<4..15>`, `pawn-remove-<n>`, `pawn-status-<n>`.

data-edit keys (33): options-nav-designs, -how, -peek, -reviews, -timer, -order; options-step1-title, -step1-sub, options-code-summary, options-step2-title, -step2-sub, options-customtitle-label, -customtitle-hint, options-preview-teaser-title, -preview-teaser-sub, options-namepreview-label, options-fontpicker-label, options-photos-title, -photos-sub, -photos-count-toggle, -photos-count-label, -photos-cut, -photos-hint, -photos-tip-shop, -photos-tip-fix, options-step4-title, -step4-sub, options-email-label, options-phone-label, options-buyer-name-label, -buyer-name-hint, options-event-type-label, -event-type-hint.

Analytics: GA `track()` events `select_design`, `select_color`, `begin_checkout` (value/currency/items, once on reaching step 4), `collection_created`, `open_zoom`, `zoom_nav`, `open_deck_view`; Meta `fbq('track','InitiateCheckout')` on step 4; own ledger `sendEvent('checkout')` (attribution.js → POST `/api/track`).

API calls

| Method + URL                                                                                                                                                                                                                                           | Purpose                                                                                                   | Server                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------ |
| GET `/api/features`                                                                                                                                                                                                                                    | color_picking / font_choice / name_preview flags; 2.5s timeout, fail-closed all false; blocks first paint | server/routes/platform.js:1799 |
| GET `/api/custom-designs` (designs.js `loadCustomDesigns`)                                                                                                                                                                                             | owner-uploaded designs appended to catalog                                                                | routes/catalog.js:861          |
| GET `/api/design-names` (designs.js `syncDesignNames`)                                                                                                                                                                                                 | owner renames re-stamped on tiles                                                                         | routes/catalog.js:814          |
| GET `/api/design-images` (design-images.js)                                                                                                                                                                                                            | deck photos for tiles/preview/deck row                                                                    | routes/catalog.js:1147         |
| GET `/api/pricing` (pricing.js `fetchPricing`)                                                                                                                                                                                                         | `store.now/was` → plan pill; `sale` → applySale                                                           | routes/commerce.js:1077        |
| POST `/api/design-code/validate` `{code}`                                                                                                                                                                                                              | unlock private design → `{valid, design}`; 429 rate limit                                                 | routes/catalog.js:173          |
| POST `/api/preview` `{theme,name,extra_fields:{},word_font,gender:null,board:false,title}`                                                                                                                                                             | rendered card/back preview (only when name_preview on)                                                    | server/index.js:3449           |
| GET `/api/pawn-base?<q>`                                                                                                                                                                                                                               | her design's pawn card picture for step-5 tiles (5 min client cache)                                      | index.js:2945                  |
| POST `/api/collections` `{honoree_name (title line 1, ≤60), gender:null, email, phone (normalized 0XXXXXXXXX), design (name), color (name), theme, extra_fields:{}, word_font, custom_title, buyer_name, event_type, arrival (currentTouch), players}` | create order → `{id, owner_token}`; 400 `{error:'emoji', message}`                                        | index.js:1171                  |
| POST `/api/collections/:id/pawns?k=<owner_token>` multipart `pawn0..` + `cut:pawnN` + `cutfail` (batches of 4)                                                                                                                                         | upload pawn photos + client cutouts after create; reads `pawn_images.length`                              | index.js:2695                  |
| GET `/api/content?page=options.html` (editor.js)                                                                                                                                                                                                       | data-edit overrides                                                                                       | platform                       |

After create: `location.href = collect.html?c=<id>&k=<owner_token>[&photos_lost=N]`.

Pawn photos (step 5): `PLAYER_COUNTS=[4,8,12,16]`, `DECK_CARDS=104`, `PER_CARD=4`; budget line "עד N תמונות · C קלפי חיילים · עד W מילים" (4 players → 412 words). Background removed on device via dynamic `import('./js/pawn-cutout.js')` (MediaPipe, ~18MB), drawn by `js/pawn-print.js`; `shrinkForUpload` re-encodes before upload; waits up to 20s for cuts.

Not present on options.html: payment, coupons, Apple Pay, share link, friend coupon.

#### 1(c) Dynamic data and its source

- Catalog: `js/designs.js` bundled `DESIGNS` + `MAIN_COLORS` (+ `designs.generated.js`), plus `/api/custom-designs`; names from `/api/design-names`; pictures from `/api/design-images` and shipped `thumb-<view>.webp` / `/design-thumb/` derivatives. `d.public === false` tiles hidden until code.
- Prices: settings `pricing.store_now` (199), `pricing.store_was` (239), `pricing.sale_on`, `sale_label`, `sale_banner` via `/api/pricing`. Baked fallback in `PLANS.base` {199, 239}.
- Feature flags: settings `features.color_picking`, `features.font_choice`, `features.name_preview` (all default false); `font_choice` effective only with `name_preview`.
- Word ceiling shown on step 5 is computed client-side from players; server `db.deckWordsFor` is the authority.
- Static copy otherwise, owner-overridable through data-edit only.

#### 1(d) Purely old styling

- All of `<style>` L42-1989 and the four in-body `<style>` blocks; `:root` vars there (`--nav-h`, `--wizbar-h`, `--page-ratio`, `--accent: var(--sage)` — sage is off-brand per brand memory).
- Presentational classes not touched by JS: `cfg-head`, `wiz-progress`, `wiz-steplabel`, `bar`, `wiz-title`, `wiz-sub`, `wiz-field`, `wiz-lbl`, `wiz-hint`, `wiz-input`, `wiz-pair`, `code-box`, `code-row`, `code-input`, `code-btn`, `pt-ghost`, `pt-spark`, `pt-copy`, `pt-title`, `pt-sub`, `name-preview-lbl`, `npr-bar`, `npf-card`, `npl-*`, `pawn-plus`, `pawn-count-row`, `pawn-count-label`, `pawn-budget-note`, `pawn-tip`, `pawn-hint`, `pawn-cut`, `os-list`, `wiz-bar-inner`, `zoom-toolbar`, `zoom-btn`, `zi`.
- Careful: `wiz-err`, `wiz-step`, `preview-panel`, `preview-card`, `wiz-back`, `deck-row`, `title-break`, `custom-title-warn`, `.was`, `.amt` look presentational but are paired with JS state classes or tests (`.wiz-step.is-active`, `.wiz-bar` is a test locator).

#### 1(e) E2E specs that open options.html

Options only (41): admin-faq, business-day-note, button-tap-responsiveness, collect-finish, color-step-carousel, configurator, custom-designs, custom-title-preview, design-names, index, name-language-note-gone, name-preview-instant, name-preview, options-color-step-tabs, options-feature-flags, options-order-flow-fixes, order-arrival, order-boxes, order-buyer-details, order-comment, pawn-photos, product, refuse-emoji, refuse-niqqud, remote-towns, start-explainer, storefront-custom-designs, theme-extra-fields, title-break-suggestion, wa-consent, wizard-deck-pictures, wizard-noscroll, wizard-picker-thumb, wizard-preview-bleed/-fit/-picture/-polish/-teaser/-visual, wizard-title-gate, wizard-zoom, wordlist-menu.
Both pages (14): asset-hashing, bold-weight-no-leak, collect-produce, collect, content-editor, fonts-self-hosted, free-word-limit, game-tabs, order-copies, struck-price, wa-help-clearance, wa-numbers, whatsapp-help, word-bar. Many funnel specs drive options → createCollection → collect.html.

Selectors these specs rely on (MUST NOT change)

- Test ids, most used first: next-btn (169 uses), custom-title-input (52), step-3, step-4, step-1, name-preview-card, step-pawns, zoom-overlay, deck-thumb, step-2, back-btn, pawn-input-0, buyer-name-input, zoom-open, tab-board, step-now, deck-row, preview-front, event-type-input, owner-phone, name-preview, color-list, tab-front, preview-board, name-preview-viewport, custom-title-err, tab-back, preview-teaser, pawn-skip, name-preview-instant-card, name-preview-dot-board/-card/-back, custom-title-warn, zoom-tab-_, zoom-dot-_, pawn-cut, name-preview-loading(-card), name-preview-fallback, font-opts, font-opt-original, font-opt-<file>, custom-title-field, color-carousel, zoom-viewport, pawn-status-0, deck-view(-close), zoom-content, raster-note, preview-stage, pawn-input-<n> (incl. 5), owner-email, name-preview-back, design-list, design-<i>, color-<i>, custom-title-break, continue-summary, buyer-name-err, buyer-name-field, event-type-field, preview-back, phone-err, email-err, pawn-tip, pawn-over, pawn-grid, nav-toggle, name-preview-retry, name-preview-dots, name-preview-board, zoom-in, zoom-close, zoom-hint, zoom-dots, step-total, plan-price, plan-pill, pawn-remove(-0), pawn-hint, pawn-count-toggle, pawn-count-panel, pawn-count-<n>, pawn-budget, pawn-err, design-code-input, custom-title-hint, wa-help, preview.
- CSS / ID locators: `.design[data-design-id=…]`, `.design .thumb img`, `.design .thumb svg`, `.design[aria-pressed=…]`, `#designList button.design:not([hidden])`, `.wiz-step.is-active (.design)`, `.preview-panel[data-active=…]`, `.preview-panel[data-panel=…]`, `.preview-stage`, `.tab[data-tab=…]`, `.pawn-slot[data-idx=…]`, `.pawn-slot.is-over`, `.pawn-slot:not([hidden])`, `.pawn-tile svg[data-pawn-crop] (image)`, `.pawn-tile use[filter]`, `.pawn-remove`, `.wiz-bar`, `.wiz-fontpicker`, `.font-opt[aria-pressed]`, `.font-opt:not(.font-opt-orig)`, `.swatch`, `.cc-slide svg`, `.zoom-dot`, `.deck-slide`, `#deckTrack .deck-slide`, `#deckDots .carousel-dot`, `#deckViewTrack img|> *`, `#zoomContent img`, `#colorCarouselTrack`, `#colorCarouselDots .carousel-dot`, `#namePreviewDots .np-dot[aria-selected]`, `#namePreviewImgs .npi-name`, `#namePreviewImgs [data-np-instant]`, `#npfName`, `#customTitleInput`, `#continueSummary`, `#planWas`, `s.was`, `.was`, `#backBtn`, `.pt-ghost`, `.dname`, `.thumb`, `.wa-help-label`, `body`/`html` (data-sale), `[data-edit=…]`.
- Text asserted: "חזרה לחנות", "ירידת שורה", "אימוג׳י", "ניקוד", "רשות", "עד 412 מילים", "עד 404 מילים", "כותרת". Negative assertions that must stay absent: `extra-fields`/`extra-*`, `name-preview-warning`, `order-comment-*`.

---

### 2. site/collect.html (collection + payment page, 7952 lines)

Two audiences on one URL: owner (`?c=<id>&k=<owner_token>`, `isOwner`) and contributor (`?c=<id>` only). Everything with class `owner-only` starts `hidden` and is unhidden by JS for owners only. No `?c` → `#title` "חסר קישור", `#subtitle` "פתחו את הקישור שקיבלתם מהמארגנ/ת.".

#### 2(a) Content that must survive (document order)

1. Header: `a.home-link` (home-link) with logo (data-edit-img collect-home-logo); `.brand` "דוגרי"; `h1#title` (JS: "אוספים מילים על <honoree>"); `#subtitle`.
2. Owner tab strip `nav#tabs.tabbar.owner-only.hidden` (tabs, role=tablist) with `button.tabbar-btn[data-tab]` in order: `words` "מילים" (tab-words, starts `.on`), `design` "עיצוב" (tab-design), `pawns` "חיילים" (tab-pawns), `pay` "תשלום" (tab-pay, hidden once paid), `finish` "שליחה לייצור" (tab-finish). Each panel carries `data-panel="<tab>"`; the strip scrolls horizontally on phones.
3. Design tab `section#designPanel[data-panel=design]`: `#prevBox` > `img#prevImg` (game-preview), `#prevBusy` "מעדכן…", `#prevFail` "לא הצלחנו להציג את הקלף כרגע". Field "כותרת המשחק": `textarea#titleInput` rows=2 maxlength=63 (title-input), `#titleHint` "עד 63 תווים · בלי אימוג׳י · ירידת שורה מגדילה כותרת ארוכה", `#titleErr` (title-err), `#titleSaveBtn` "שמירה" (title-save). Typing only redraws; save is explicit.
4. Pawns tab `section#pawnsPanel[data-panel=pawns]`: `#pawnPrevCards` > `.prev-box.pawn-live#pawnPrevBox` > `img#pawnPrevImg` (pawn-card-preview), `#pawnLiveSlots`, `.prev-busy`, `#pawnPrevFail`. Note `.pawn-final` "זו התוצאה הסופית - בדיוק ככה הקלף יודפס וייצא אליכם." Players field `#playersFld`: "כמה שחקנים", `#playersCount` (players-count; JS buttons players-4/8/12/16), `#playersBudget`, `#playersNote`, `#playersErr`; refusal box `#playersRefuse` (`#playersRefuseMain`, `#playersRefuseWhy`, `#playersRefuseWords` "לרשימת המילים", `#playersRefuseKeep` "להישאר כמו שזה"); `#playersClosed` "האיסוף נסגר - מספר השחקנים כבר בהפקה.". Photos: `#photosLabel` "התמונות שלכם" / `#photosLabelMax` / `#photosLabelSent`; `#photosHint` (drag inside circle, slider zoom, keep background option); `#pawnStrip` (pawn-strip; JS tiles pawn-thumb, pawn-add, per-photo editor pawn-view with pawn-zoom/-in/-out, pawn-bg-on/off, pawn-reset, pawn-remove); `#pawnNone` / `#pawnNoneSent` (default Dugri pawns copy); `#pawnBusyNote`; `#pawnErr`. Hidden global `input#pawnAddInput[type=file][accept=image/*][multiple]` (pawn-add-input).
5. Finish tab `section#finishPanel[data-panel=finish]`: `#finishHead` "שליחה לייצור וסיום" / `#finishHeadSent` "מה נשלח לייצור"; `#finishHint` ("…אחרי השליחה לייצור כבר אי אפשר לשנות.") / `#finishHintSent`; checklist rows `.finish-step` (finish-title, finish-pawns): "1. הכותרת שתודפס" `#finishTitle` + `button.pawn-mini[data-goto=design]` "לעריכה"; "2. חיילי המשחק" `#finishPawns` + `[data-goto=pawns]`; "3." pool picker `#poolFld` (pool-field): labels `#poolLabel` "איזה סגנון נשלים לכם?" / `#poolLabelSent` / `#poolLabelBlank`, hints `#poolHint` / `#poolHintSent` / `#poolBlankHint`, `#poolOpts[role=radiogroup]` (JS `label.pool-opt > input[name=poolOption]`, testid pool-opt-<id>|default|**blank**), `#poolErr`. Acknowledgement `label#finishAckRow > input#finishAck[type=checkbox]` (finish-ack) "עברתי על הכותרת, על חיילי המשחק ועל סגנון המילים - הכול נכון ואפשר להדפיס.".
6. Shipping upgrade (paid pickup orders) `details#shipAddCard.ship-collapse[data-panel=finish]`: summary "רוצים משלוח עד הבית?" + fee `#shipAddFee`; `#shipAddHint`, `#shipAddBoxes`; address `#shipAddrForm`: `#shipStreet` (ship-street, required), `#shipCity` (ship-city, required), `#shipPostal` (ship-postal, maxlength 7, required), `#shipApt`, `#shipFloor` (optional "לא חובה"); remote-towns note `details.odd-note[data-testid=remote-note][data-where=ship-add]`; `#shipAddErr`; `#shipAddBtn` "💳 הוסיפו משלוח ושלמו". Done state `section#shipDoneCard` "✓ המשחק יישלח אליכם הביתה" + `#shipDoneAddr`.
7. `#sheetClosedNote` "האיסוף נסגר והמשחק בהפקה - אי אפשר לשנות עכשיו."
8. Owner controls `#ownerControls[data-panel=finish]` "ניהול האיסוף": `#closeBtn` "מספיק! סיימנו לאסוף ✅" (disabled until gate passes), `#closeGateNote` (close-gate-note: "בחרו איזה סגנון נשלים לכם (סעיף 3) כדי לשלוח לייצור." / "צריך לאשר שעברתם על הפרטים למעלה.").
9. `#payTop` (pay-top, outside panels): "כאן משלמים 👇", `#payTopAmt.amt`, label "תשלום מאובטח בכרטיס אשראי · אפשר להמשיך להוסיף מילים גם אחרי התשלום", `#payTopBtn` "💳 לתשלום".
10. `#banner` (status banner).
11. Words tab, add card `#addCard[data-panel=words]`: "מי מוסיף? (לא חובה)" `#byName` maxlength 40; mode tabs `button.tab#tab-single|#tab-list|#tab-file` (✏️ מילה / 📋 רשימה / 📄 קובץ, `.active`) → `.panel#panel-single|#panel-list|#panel-file`. Single: `#ideaBox`, `#wordInput` (aria-describedby wordLenHint), `#addBtn` "הוסף", `#wordLenHint`, `#ideaBtn` "תני לי רעיון 💡". List: `textarea#pasteBox` placeholder "מילה בכל שורה, או מופרדות בפסיקים", `#pasteAdd`. File: `input#fileInput[type=file][accept=.txt,.csv,text/plain,text/csv]` + "קובץ טקסט או CSV - מילה בכל שורה.". Lock veil `#lockVeil` (free-limit-lock): `#lockChip` ("🔒 ההוספה נעולה" / "🎉 החפיסה מלאה"), `#lockNote`, `#lockPayBtn` "לתשלום - ופותחים את האיסוף" (lock-pay-btn, owner only).
12. `#wordsCard`: "המילים שכבר נאספו", `.count-pill` `#count` + `#countMax`; progress `#stage1 > .bar > #barFill1`, `#stage2` (`#stage2Label`, `#barFill2`); `#countHint` (goal 70 / max copy); `#wordsWrap` (empty "עוד אין מילים - היו הראשונים!"; JS `span.word > span.wtext[data-testid=word-text][data-word-id]` + `.by` + owner `button.del` (word-del); click on wtext opens inline edit `input` word-edit-input); held words `#heldBlock` (held-words) `#heldCount`, `#heldWrap` (held-word-text) "מילים שעדיין לא נוספו לרשימה / הן יתווספו לרשימה עם השלמת התשלום.".
13. Share `#sharePanel.share.hidden` (owner): "📨 שתפו עם החברות", `a#shareWhatsapp` (share-whatsapp), `input#friendsLink[readonly]`, `#copyFriends` "העתק"; `#waGroupPanel` with `a#joinWaGroup` (join-wa-group) when the order has a WhatsApp group invite.
14. Help `#helpCard`: "תקועים? ענו על כמה שאלות…", `#catChips` (`.chip`), `#qList` (JS `.q-row`, `.q-text`, `.q-input`, `.q-add`, `.q-check`; testids q-row/q-input/q-add/q-check), `details.howto` with 8 `.cat` examples.
15. `#paidCard` (paid & open): "התשלום התקבל ✓" + body + `#paidCloseBtn` "סיום - התחילו להפיק ✅".
16. Pay panel `details#payPanel.pay-collapse[data-panel=pay]`, summary "שלמו וקבלו את המשחק": intro; `#payOpts[role=radiogroup]` with `label.pay-opt` radios `name=payVersion` values `pdf` (79), `pickup` (199, default visible "משחק מוכן ומודפס · מוכן תוך כ-4 ימי עסקים · איסוף מבית דפוס גלאור, ת״א"), `custom` (599); pickup details `details.pickup-note` (pickup-details: "התחייה 14, תל אביב · כניסה B…", hours, what to bring); delivery add-on `label#shipOpt.pay-addon` (ship-toggle) `input#shipToggle` "שלחו לי עד הבית" `#shipPrice`; remote-towns note `[data-where=ship-toggle]`. `#priceLoadErr` (`[data-role=msg]`, `[data-role=retry]` "רענון מחירים"). `#addressForm` (`#addrStreet`, `#addrCity`, `#addrPostal`, `#addrApt`, `#addrFloor`). Coupon `.coupon-box`: `#couponInput`, `#couponApplyBtn` "החל קופון", `#couponMsg` (`.coupon-msg ok|err`), `#couponRemoveBtn` "הסירו קופון". Copies `#qtyRow`: "כמה עותקים? / אותן מילים, כמה חפיסות", `#qtyMinus` (qty-minus), `#qtyVal` (qty-val), `#qtyPlus` (qty-plus). `#oneBoxOpt` (one-box) `#oneBoxToggle` (one-box-toggle) "לשלוח את כל העותקים בקופסה אחת" `#oneBoxNote`. Total `.pay-total`: "לתשלום:" `.pay-now.amt > #payTotal`, `#payWas.was`, `#payMath` (pay-math). `#payErr`. Trust lines "🔒 תשלום מאובטח בכרטיס אשראי", `.pay-cutoff` (pay-cutoff: "הספירה מתחילה כשסוגרים את רשימת המילים. רשימה שנסגרת אחרי 16:00 - נספרת מיום העסקים הבא."). `#cardPayBtn` "💳 תשלום בכרטיס אשראי", `#cardSoonNote` "התשלום בכרטיס אשראי ייפתח בקרוב", `#paySoldOutNote` "המכירות סגורות כרגע - נחזור בקרוב 🙌" (shown via `.sales-paused`).
17. `a#orderCta` (order-cta) → options.html; JS text by role ("רוצים עוד משחק? הזמינו כאן 🎉" owner / "רוצים משחק כזה לאירוע שלכם? →").
18. Modals (outside `.wrap`): `#payModal.pay-modal` (role dialog) > `#payModalClose`, `iframe#payFrame[allow=payment][allowpaymentrequest]`; `#closeAsk.game-sheet` (close-ask) title/lead/list/note + `#closeAskNo` "עוד לא, אני רוצה לבדוק" / `#closeAskYes.danger` "סוגרים ושולחים לדפוס"; `#produceWait` (produce-wait) `#produceWaitSpin`, `#produceWaitTitle`, `#produceWaitSub`, `#produceWaitOk` "הבנתי"; `#msgModal` (msg-modal) `#msgModalText`, `#msgModalCancel` "ביטול", `#msgModalOk` "הבנתי"/"מחיקה"; JS `#toast.toast` (`.show`).
19. Foot: `a.wa-help` (data-edit collect-wa-help-label); sticky `#payBar.pay-bar.owner-only` (pay-bar) `#payBarAmt` (pay-bar-amount), `#payBarBtn` "שלמו עכשיו" (pay-bar-btn). JS-created `#staleSessionBtn` (stale-session-btn) "סגרתי את חלון התשלום - המשיכו".

Validation and messages: word length ≤ `MAX_WORD_LEN=25` (`#wordLenHint`, `.too-long`); emoji and niqqud refused per word and per batch (emoji.js / niqqud.js messages carry the clean word); duplicate → info dialog; title ≤63, no emoji; delivery address requires street + city + postal ("נא למלא רחוב, עיר ומיקוד למשלוח."); coupon reasons map `COUPON_REASONS` + "קוד לא קיים", 429 "יותר מדי ניסיונות, נסו עוד רגע", 403 "לא ניתן להחיל קופון"; pay/init errors: coupon 400 → "הקופון נוצל במלואו" / "הקופון אינו תקף יותר" and coupon cleared; 409 Hebrew message + stale-session escape, else "כבר בוצע תשלום עבור הזמנה זו"; 429; generic "פתיחת התשלום נכשלה. נסו שוב מאוחר יותר."; no enabled version → "המכירות סגורות כרגע. נסו שוב מאוחר יותר.".

#### 2(b) Flow, state and hooks

Visibility model: class `.hidden` (collect.html L574 `.hidden{display:none}` plus per-component `.x.hidden` overrides at L1352/1370/1710/1724/1740) AND the `hidden` attribute (tabs: `showTab` sets `el.hidden` on every `[data-panel]`). Both mechanisms are live and must keep working together; an element needs both cleared to show (e.g. `#designPanel` has `class=hidden` and `hidden`).

Tabs: `showTab(name)` toggles `.tabbar-btn.on` + aria-selected, sets `hidden` on `[data-panel]`, `scrollIntoView` the active tab; `design` → loadGameTabs, `pawns` → loadPawnCard, `finish` → renderFinish. `[data-goto]` buttons jump tabs. Paid → pay tab hidden and redirected to finish. Contributors never see the tab strip; all their content is `data-panel=words` (shown by default).

Owner render (`renderOwnerState`, every refresh): unhides `#tabs`, `#designPanel`, `#pawnsPanel`, `#finishPanel`; `#payPanel` hidden when paid; `#payBar` and `#payTop` shown iff open && !paid && card_enabled (`--pay-bar-h` measured via ResizeObserver); `#paidCard` iff open && paid; `#ownerControls` iff open && !paid; `#cardPayBtn` iff card_enabled && !paid; `#cardSoonNote` iff !card_enabled && !paid; free-limit lock auto-opens `#payPanel`.

Polling: `refresh()` GET every 5 s (paused while a word is being edited), plus after every action. Counter: `WORD_GOAL=70`, `MAX_WORDS = state.deck_words` (default 412). `applyDeckFull` / `applyFreeLimit` add `.locked` on `#addCard`, unhide `#lockVeil`, disable inputs except `.lock-cta`.

State

- URL: `c` (collection id), `k` (owner token), `pay=1` (owner: auto-open pay panel once), `photos_lost=N` (from wizard; consumed then removed with replaceState).
- `localStorage['dugri_contributor_name']` (byName).
- `sessionStorage['dugri:payReturn']` = path+search before opening pay / shipping / success (pay-done and pay-success use it to return). `sessionStorage['dugri:payJustDone']` (`PAID_FLAG`) → on return, `pollPaid()` up to 8×1.5 s.
- In-memory: `appliedCoupon {code, discount_pct}`, `copies`, `oneBox`, `lockVersion`/`lockTotal` (locked order), `pricing`.

Payment flow (card)

1. `#cardPayBtn` click → `selectedVersion()` (pickup + `#shipToggle` checked → `delivery`; `baseVersionOf('delivery')='pickup'`; falls back to first enabled in `['pdf','pickup','delivery','custom']`).
2. POST `/pay/init` `{owner_token, version, address|null, quantity, one_box?, coupon?, landing?, source_url}` → `{free|paid}` → success page directly, else `{url}`.
3. `openPayFrame(url)`: `armApplePay(url)` (js/apple-pay.js: loads vendored jQuery + provider script only for a Tranzila charge on an Apple Pay capable browser), `#payFrame.src = url`, `#payModal` unhide, start `watchForPayment()` (refresh every 2.5 s up to 240 tries; on `paid` → close, `card_pay_done`, success).
4. `window.message` from `#payFrame.contentWindow` with `{type:'dugri-pay', ok}` (posted by site/pay-done.html L99) → close modal; ok → `goPaySuccess()` = set `dugri:payReturn` + `dugri:payJustDone`, `location.href = pay-success.html?back=<path>`.
5. Close (×, backdrop, Esc via `wireModalDismiss`, `pagehide`) while unpaid → POST `/pay/cancel` (keepalive) releases the provider session.
   Provider is server-side (`cardProvider()` → PeleCard, or Tranzila per environment); the page only knows `card_enabled` and the URL.

Shipping upgrade (paid pickup): `#shipAddBtn` → POST `/shipping/init` `{owner_token, address}` → `{url}` → same `openPayFrame` (or redirect).

Close and produce: `#closeBtn` / `#paidCloseBtn` gate = pool picked + `#finishAck` checked (otherwise jump to finish tab with message) → `#closeAsk` confirm → POST `/close` → POST `/produce` → poll GET `/produce?k=` until `ready` → `location.href = proof_url` (deck proof page); else `#produceWait` calm copy.

Element IDs referenced from JS (all must keep)

- Header/frame: `title`, `subtitle`, `tabs`, `banner`, `orderCta`, `toast` (created), `msgModal`, `msgModalText`, `msgModalOk`, `msgModalCancel`.
- Design tab: `designPanel`, `prevBox`, `prevImg`, `prevBusy`, `prevFail`, `titleInput`, `titleHint`, `titleErr`, `titleSaveBtn`.
- Pawns tab: `pawnsPanel`, `pawnPrevCards`, `pawnPrevBox`, `pawnPrevImg`, `pawnLiveSlots`, `pawnPrevFail`, `playersFld`, `playersCount`, `playersBudget`, `playersNote`, `playersErr`, `playersRefuse`, `playersRefuseMain`, `playersRefuseWhy`, `playersRefuseWords`, `playersRefuseKeep`, `playersClosed`, `photosLabel`, `photosLabelMax`, `photosLabelSent`, `photosHint`, `pawnStrip`, `pawnNone`, `pawnNoneSent`, `pawnBusyNote`, `pawnErr`, `pawnAddInput`.
- Finish tab: `finishPanel`, `finishHead`, `finishHeadSent`, `finishHint`, `finishHintSent`, `finishTitle`, `finishPawns`, `poolFld`, `poolLabel`, `poolLabelSent`, `poolLabelBlank`, `poolHint`, `poolHintSent`, `poolBlankHint`, `poolOpts`, `poolErr`, `finishAckRow`, `finishAck`, `shipAddCard`, `shipAddFee`, `shipAddBoxes`, `shipStreet`, `shipCity`, `shipPostal`, `shipApt`, `shipFloor`, `shipAddErr`, `shipAddBtn`, `shipDoneCard`, `shipDoneAddr`, `sheetClosedNote`, `ownerControls`, `closeBtn`, `closeGateNote`, `closeAsk`, `closeAskNo`, `closeAskYes`, `produceWait`, `produceWaitSpin`, `produceWaitTitle`, `produceWaitSub`, `produceWaitOk`.
- Words tab: `addCard`, `byName`, `ideaBox`, `wordInput`, `addBtn`, `wordLenHint`, `ideaBtn`, `pasteBox`, `pasteAdd`, `fileInput`, `tab-single`, `tab-list`, `tab-file`, `panel-single`, `panel-list`, `panel-file`, `lockVeil`, `lockChip`, `lockNote`, `lockPayBtn`, `count`, `countMax`, `countHint`, `stage1`, `stage2`, `stage2Label`, `barFill1`, `barFill2`, `wordsWrap`, `heldBlock`, `heldCount`, `heldWrap`, `sharePanel`, `shareWhatsapp`, `friendsLink`, `copyFriends`, `waGroupPanel`, `joinWaGroup`, `helpCard`, `catChips`, `qList`, `paidCard`, `paidCloseBtn`.
- Pay: `payTop`, `payTopAmt`, `payTopBtn`, `payPanel`, `payOpts`, `shipOpt`, `shipToggle`, `shipPrice`, `priceLoadErr`, `addressForm`, `addrStreet`, `addrCity`, `addrPostal`, `addrApt`, `addrFloor`, `couponInput`, `couponApplyBtn`, `couponMsg`, `couponRemoveBtn`, `qtyRow`, `qtyMinus`, `qtyVal`, `qtyPlus`, `oneBoxOpt`, `oneBoxToggle`, `oneBoxNote`, `payTotal`, `payWas`, `payMath`, `payErr`, `cardPayBtn`, `cardSoonNote`, `paySoldOutNote` (CSS via `.sales-paused`), `payModal`, `payModalClose`, `payFrame`, `payBar`, `payBarAmt`, `payBarBtn`, `staleSessionBtn` (created).

Classes / selectors queried or toggled by JS

- Queried: `#tabs .tabbar-btn`, `[data-panel]`, `[data-goto]`, `.tab` (add-mode tabs), `.chip`, `.pay-opt`, `.opt-price` (price written into it), `.was`, `input[name="payVersion"]` (+`:checked`), `input[name=poolOption]`, `[data-testid="remote-note"]` + `[data-role=eta|find|count|towns]`, `#priceLoadErr [data-role=msg|retry]`, `.prev-box.pawn-live`, `.pawn-live-slots`, `.prev-fail`, `.pawn-grab`, `.pawn-pad`, `#finishPanel …`.
- Toggled: `hidden` (dozens), `on` (tabbar, bg buttons), `active` (add-mode tabs, `.pay-opt`, pool opts), `locked` (#addCard), `show` (toast), `busy` / `has-card` (preview boxes), `editable` (word text), `committed`, `too-long` (word input), `sales-paused` (#payPanel), `owner-only` (static marker).
- JS-built classes: `word`, `word held`, `wtext`, `by`, `del`, `word-edit`, `chip`, `q-row`, `q-head`, `q-text`, `q-input`, `q-add`, `q-check`, `q-lines`, `q-line`, `q-line-done`, `pool-opt`, `pawn-add`, `pawn-cell`, `pawn-view`, `pawn-x`, `pawn-bg`, `pawn-ctl`, `pawn-ctl-hint`, `pawn-grab`, `pawn-pad`, `pawn-step`, `pawn-row-actions`, `pawn-mini`, `pawn-zoom(-row|-lab)`, `amt`, `coupon-msg`, `ghost`, `toast`.
- data-\* used: `data-tab`, `data-panel`, `data-goto`, `data-role`, `data-where`, `data-wired`, `data-word-id`, `data-players`.

data-testid (markup): home-link, tabs, tab-words, tab-design, tab-pawns, tab-pay, tab-finish, game-preview, title-input, title-err, title-save, pawn-card-preview, pawn-final-note, players-count, players-budget, players-note, players-err, players-refuse, players-refuse-words, photos-label-max, pawn-strip, pawn-none-sent, pawn-busy, finish-hint-sent, finish-title, finish-title-val, finish-go-design, finish-pawns, finish-pawns-val, finish-go-pawns, pool-field, pool-err, finish-ack, ship-add-summary, ship-add-boxes, ship-street, ship-city, ship-postal, remote-note (×2), remote-find (×2), ship-add-err, ship-add-btn, ship-done-addr, close-gate-note, pay-top, pay-top-amount, pay-top-btn, free-limit-lock, lock-pay-btn, held-words, share-whatsapp, join-wa-group, pickup-details, ship-toggle, qty-minus, qty-val, qty-plus, one-box, one-box-toggle, one-box-note, pay-math, pay-cutoff, order-cta, close-ask, close-ask-no, close-ask-yes, produce-wait, produce-wait-title, produce-wait-sub, produce-wait-ok, pawn-add-input, msg-modal, msg-modal-cancel, msg-modal-ok, wa-help, pay-bar, pay-bar-amount, pay-bar-btn.
data-testid (JS-built): word-text, word-del, word-edit-input, held-word-text, q-row, q-input, q-add, q-check, pool-opt-<id>, players-<n>, pawn-thumb, pawn-add, pawn-view, pawn-zoom, pawn-zoom-in, pawn-zoom-out, pawn-bg-on, pawn-bg-off, pawn-reset, pawn-remove, stale-session-btn.

data-edit keys (127): collect-sheet-rendering, -sheet-preview-fail, -sheet-title-label, -sheet-title-hint, -pawn-card-rendering, -pawn-card-fail, -pawn-final-note, -sheet-players-label, -sheet-players-closed, -sheet-photos-label, -sheet-photos-label-sent, -sheet-photos-hint, -sheet-photos-none, -sheet-photos-none-sent, -finish-heading, -finish-heading-sent, -finish-hint, -finish-hint-sent, -finish-title-h, -finish-pawns-h, -sheet-pool-label, -sheet-pool-label-sent, -sheet-pool-label-blank, -sheet-pool-hint, -sheet-pool-hint-sent, -sheet-pool-blank-hint, -finish-ack, -shipadd-heading, -shipadd-hint, -shipadd-addr-head, -remote-summary-ship, -shipadd-cta, -shipdone-heading, -shipdone-hint, -sheet-closed, -owner-heading, -owner-hint, -close-btn, -pay-top-head, -pay-top-label, -pay-top-cta, -byname-label, -tab-single, -tab-list, -tab-file, -add-btn, -idea-btn, -paste-add, -file-hint, -words-heading, -held-head, -held-note, -share-heading, -share-hint, -share-wa-label, -copy-friends-btn, -wa-group-hint, -wa-group-label, -help-heading, -help-intro, -howto-summary, -howto-body, -cat-{people,places,jokes,sayings,habits,work,events,childhood}-{title,eg}, -paid-title, -paid-body, -paid-cta, -pay-summary, -ver-pdf-title, -ver-pdf-note, -ver-pickup-title, -ver-pickup-note, -pickup-summary, -pickup-addr, -pickup-hours, -pickup-bring, -ver-custom-title, -ver-custom-note, -ver-custom-note2, -ship-title, -ship-note, -ship-note2, -remote-summary, -addr-head, -coupon-label, -coupon-apply, -coupon-remove, -qty-label (contains nested -qty-sub), -one-box-label, -pay-trust, -pay-cutoff, -card-pay-btn, -pay-soon, -pay-paused, -close-ask-title, -close-ask-lead, -close-ask-words, -close-ask-deck-title, -close-ask-photos, -close-ask-note, -wa-help-label, -pay-bar-cta; img: collect-home-logo. (All prefixed `collect-`.)

Analytics `track()`: `word_added`, `collect_tab`, `share_link_copied`, `share_link_whatsapp`, `join_wa_group`, `coupon_applied`, `pay_bar_click`, `pay_top_click`, `free_limit_pay_click`, `card_pay_started`, `card_pay_done` (3 call sites), `shipping_upgrade_started`, `collection_closed`.

API calls (helper `api(path)` = `fetch('/api/collections/' + id + path)`, throws `{status, body}` on non-2xx)

| Method + URL                                                                      | Purpose                                                                                                                                                                                                                                       | Server                  |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| GET `/api/collections/:id[?k=]`                                                   | state poll (5 s): status, words, held_words, count, deck_words, players, paid, order, card_enabled, free_limit_locked, + owner fields (pawn_images, pawn_cutouts, pawn_view, custom_title, wordlist_option, shipping_upgrade, wa_invite_link) | index.js:3614           |
| POST `/words` `{words[], added_by}`                                               | add words (`added`)                                                                                                                                                                                                                           | index.js:3690           |
| PATCH `/words/:wordId`                                                            | edit word (owner)                                                                                                                                                                                                                             | index.js:3839           |
| DELETE `/words/:wordId`                                                           | delete word (owner, confirm dialog)                                                                                                                                                                                                           | index.js:3826           |
| PUT `/title?k=`                                                                   | save printed title                                                                                                                                                                                                                            | index.js:3131           |
| POST `/api/preview`                                                               | design-tab sheet preview                                                                                                                                                                                                                      | index.js:3449           |
| GET `/pawn-card?live=1&k=`                                                        | pawn card picture                                                                                                                                                                                                                             | index.js:2858           |
| PUT `/players?k=`                                                                 | change player count (may refuse when words exceed new ceiling → `#playersRefuse`)                                                                                                                                                             | index.js:2774           |
| PUT `/pawns?k=` `{pawn_images}`                                                   | remove/reorder photos                                                                                                                                                                                                                         | index.js:2718           |
| POST `/pawns?k=` multipart                                                        | add photos (+ client cutout)                                                                                                                                                                                                                  | index.js:2695           |
| POST `/pawn-cut?k=`                                                               | store a cut for an existing photo                                                                                                                                                                                                             | index.js:2800           |
| PUT `/pawn-view?k=`                                                               | save drag/zoom/background per photo                                                                                                                                                                                                           | index.js:2744           |
| GET `/api/wordlist-options`                                                       | pool radio options                                                                                                                                                                                                                            | index.js:3013           |
| PUT `/wordlist?k=` `{option_id}`                                                  | choose top-up pool                                                                                                                                                                                                                            | index.js:3069           |
| GET `/summary?k=`                                                                 | finish-tab summary                                                                                                                                                                                                                            | index.js:3626           |
| POST `/close` `{owner_token}`                                                     | close collecting                                                                                                                                                                                                                              | index.js:3766           |
| POST `/produce` / GET `/produce?k=`                                               | render deck, poll → `proof_url`                                                                                                                                                                                                               | index.js:2242 / 2307    |
| POST `/coupon/validate` `{owner_token, code}`                                     | `{valid, discount_pct, reason}`                                                                                                                                                                                                               | routes/commerce.js:1007 |
| POST `/pay/init`                                                                  | start card payment / free order                                                                                                                                                                                                               | index.js:3944           |
| POST `/pay/cancel` `{owner_token}`                                                | release provider session                                                                                                                                                                                                                      | index.js:3897           |
| POST `/shipping/init` `{owner_token, address}`                                    | add delivery to a paid pickup order                                                                                                                                                                                                           | index.js:4138           |
| GET `/api/pricing`, `/api/delivery-exceptions` (pricing.js)                       | versions/prices/fee/sale; remote towns + eta                                                                                                                                                                                                  | commerce.js:1077 / 1095 |
| GET `/api/content?page=collect.html` (editor.js), POST `/api/track` (attribution) |                                                                                                                                                                                                                                               | platform                |

Share: owner link = `location.origin + '/collect.html?c=<id>&k=<owner_token>'` (`friendsUrl()`; deliberately the managing link); WhatsApp `https://wa.me/?text=` + "עזרו לי להכין הפתעה ל<honoree>! הוסיפו מילים על <honoree> כאן: <url>"; copy via `navigator.clipboard`.

Proof link: produce → `proof_url` redirect (deck proof page). Free word limit: server holds words beyond `pricing.free_word_limit` as `held_words` while unpaid (`lock_after_free_limit`); page shows veil + held block.

Friend coupon bar: NOT on main. Upcoming on `origin/feat/friend-coupon` (commit 073167e, no PR yet): adds `js/friend-bar.js` (`initFriendBar`, `friendBar.wordAdded()`), `js/friend-coupon.js` (`carriedCoupon` auto-fills `#couponInput` and clicks apply), `--friend-bar-h` in the `.wrap` bottom padding and `--wa-help-bottom`, new coupon reason `used`, `/api/friend-coupon`, e2e `friend-coupon.spec.js`. A restyle must leave room for it (bottom bar, CSS var) and keep `#couponInput` / `#couponApplyBtn` behaviour.

#### 2(c) Dynamic data and its source

- Pricing (`/api/pricing` = `db.effectivePricing()` from settings `pricing.*`): `store_now`/`store_was`, `sale_on`/`sale_label`/`sale_banner`; per version `pdf_enabled`/`pdf_price` (false/79), `pickup_enabled`/`pickup_price` (true/199), `delivery_enabled` (false), `custom_enabled`/`custom_price` (false/599), `delivery_fee` (0). Written into `.opt-price`, `#shipPrice`, `#payTotal`, `#payWas`, `#payMath`, `#payTopAmt`, `#payBarAmt`, `#shipAddFee`. Baked HTML numbers (79/199/599/40) are only pre-resolve fallbacks (`PRICING_FALLBACK`). No enabled version → `.sales-paused`. Failure → `#priceLoadErr`, no pay button.
- `pricing.remote_towns`, `pricing.remote_eta_days` (11) → `/api/delivery-exceptions` → remote notes (search box when ≥25 towns).
- `pricing.free_word_limit` (20) + `lock_after_free_limit` → `free_limit_locked`, `held_words`.
- `wordlists.buyer_options`, `wordlists.blank_label` → `/api/wordlist-options` → `#poolOpts`.
- `features.deck_proof` (true) → whether `/produce` yields a `proof_url`.
- Collection: `deck_words` (MAX_WORDS), `players`, `pawn_cards`, `card_enabled` (`cardProvider()` configured: PeleCard or Tranzila), `wa_invite_link` (WhatsApp bot), `shipping_upgrade`, `order.locked/version/total/quantity/one_box/boxes/address`.
- Prompts: `js/word-prompts.js` (`categoriesForTheme`, `promptsForTheme`, `renderQuestion`) by `state.theme`.
- NOT consumed by these pages: settings `version_labels`, `field_labels`, `cta_labels`, `delivery_info`, `pickup_info` (email/notify only, server/notify.js + admin-texts). Pickup address/hours on collect.html are static data-edit copy, not settings.

#### 2(d) Purely old styling

- `<style>` L39-2102 (except the `.hidden` rules and `.x.hidden` overrides, and selectors keyed to JS state such as `.tabbar-btn.on`, `.locked`, `.sales-paused #paySoldOutNote`, `.pay-opt.active`, `.toast.show`, `.too-long`, `.editable`, `.busy`, `.has-card`) and the `:root{--wa-help-bottom}` block (keep the var contract).
- Inline `style=` attributes on `#wordsWrap` (margin-top), `#sharePanel .row`, `#waGroupPanel`, help intro, pay intro, how-to body: presentational, safe to move into CSS.
- Presentational classes: `wrap`, `brand`, `sub`, `card`, `sec-h`, `muted`, `fld`, `sheet-fld`, `sheet-save`, `sheet-err`, `sheet-note`, `prev-box`, `pawn-cards`, `pawn-final`, `pawn-count-row`, `players-refuse-actions`, `finish-step`, `finish-h`, `finish-val`, `finish-ack`, `ship-collapse`, `ship-summary`, `ship-summary-fee`, `addr-form`, `addr-head`, `addr-grid`, `addr-field addr-*`, `opt-tag`, `odd-note`, `odd-eta`, `odd-find`, `odd-count`, `odd-towns`, `ship-add-cta`, `pay-top-*`, `nameRow`, `row`, `actions`, `soft`, `panel`, `idea`, `len-hint`, `lock-chip`, `words-head`, `count-pill`, `bar`, `bar-stage2`, `stage2-label`, `words`, `held-*`, `share`, `share-wa(-ico)`, `chips`, `qlist`, `howto`, `cats`, `cat`, `paid-*`, `pay-collapse`, `pay-summary`, `pay-opts`, `opt-body`, `opt-title`, `opt-note`, `pay-opt-custom`, `pickup-note`, `pay-addon`, `coupon-box`, `coupon-remove`, `qty-row`, `qty-label`, `qty-sub`, `stepper`, `qty-val`, `box-opt`, `box-body`, `box-note`, `pay-total`, `pay-now`, `pay-trust`, `pay-cutoff`, `card-pay-btn`, `pay-soon-note`, `order-cta`, `pay-modal(-card|-x)`, `game-sheet(-card)`, `close-ask-*`, `produce-wait-*`, `msg-modal-*`, `pay-bar-*`, `danger`.
- `.tabs`/`.tab` here are the word-entry mode tabs (not the owner tab strip `.tabbar`), keep both apart.

#### 2(e) E2E specs that open collect.html

Collect only (7): admin-ads, deck-full, pawn-card-alignment, pawn-card-title-refresh, pawn-upload-prep, pay-handoff, pickup-page. Both (14): listed in 1(e). Most options funnel specs land here via the wizard redirect (collect-finish, business-day-note, order-boxes, order-buyer-details, remote-towns, refuse-emoji/niqqud, order-copies, struck-price, …). Admin specs create collections through the API and open collect.html too.

Selectors these specs rely on (MUST NOT change)

- Test ids, most used first: tab-pawns (47), pawn-thumb (23), tab-pay (22), tab-finish (22), word-text (16), title-input (14), word-edit-input (13), tab-design (11), qty-plus (11), finish-ack (11), qty-val, pool-opt-jokes / -**blank** / -default, one-box-toggle, free-limit-lock, ship-toggle, players-count, players-4/8/12, pay-math, pay-bar, title-save, tab-words, players-budget, pawn-add-input, msg-modal, remote-find, produce-wait-title, produce-wait-ok, pawn-add, close-ask, word-del, ship-street, ship-add-summary, share-whatsapp, q-input, produce-wait, players-err, close-ask-yes, pool-field, pay-top, pay-cutoff, pawn-zoom, one-box-note, one-box, finish-title-val, title-err, ship-done-addr, ship-add-btn, q-add, pickup-details, pay-top-amount, msg-modal-ok, lock-pay-btn, held-words, finish-go-design, close-gate-note, ship-postal, ship-city, qty-minus, q-row, q-check, produce-wait-sub, players-refuse(-words), photos-label-max, pay-bar-btn, pay-bar-amount, pawn-zoom-out/-in, pawn-view, pawn-busy, pawn-bg-on/-off, pawn-reset, pawn-remove, order-cta, msg-modal-cancel, home-link, held-word-text, game-preview, finish-pawns-val, finish-hint-sent, finish-go-pawns, close-ask-no, ship-add-err, remote-note, players-note, pay-top-btn, pawn-none-sent, pawn-final-note, pawn-card-preview, finish-title, tabs, wa-help.
- CSS / ID locators: `#count` (56), `#payTotal` (49), `[data-role=…]`, `[data-edit=…]`, `#wordsWrap`, `#payPanel`, `#payPanel > summary`, `#payPanel .opt-price`, `#addCard`, `#addCard input`, `#toast`, `#shipToggle`, `#cardPayBtn`, `input[name=payVersion]`, `input[value=…]`, `label.pay-opt`, `.pay-opt:has(input[value=…])`, `#countMax`, `#pawnPrevCards .prev-box`, `#pawnPrevBox`, `#pawnPrevImg`, `#pawnLiveSlots .pawn-live-slot image`, `.pawn-live-slot (svg[data-pawn-crop])`, `svg[data-pawn-crop]`, `.pawn-grab`, `.pawn-pad`, `.pawn-zoom-row`, `.pawn-zoom-lab`, `#wordInput`, `#payModal`, `#payModalClose`, `#payFrame`, `.count-pill`, `#payOpts`, `.word`, `#title`, `#stage1`, `#stage2`, `#stage2Label`, `#barFill1`, `#barFill2`, `#payWas`, `#couponMsg`, `#couponInput`, `#couponApplyBtn`, `#couponRemoveBtn`, `#closeBtn`, `#banner`, `#addressForm (.addr-head)`, `#addrStreet`, `#addrCity`, `#addrPostal`, `[data-panel=…]`, `#payErr`, `#pawnErr`, `#countHint`, `#priceLoadErr (+ [data-role])`, `#playersClosed`, `#playersRefuseMain`, `#paidCard`, `#paidCloseBtn`, `#addBtn`, `#shipPrice`, `#shipAddCard`, `#shipDoneCard`, `#msgModal`, `#msgModalOk`, `#msgModalText`, `#friendsLink`, `#sharePanel (input)`, `#wordsCard, #sharePanel, #helpCard`, `#poolLabel`, `#poolLabelSent`, `#poolLabelBlank`, `#poolHint`, `#poolHintSent`, `#poolBlankHint`, `#poolOpts .pool-opt`, `#pawnsPanel`, `#finishPanel`, `#finishHead`, `#finishHeadSent`, `#finishHint`, `#designPanel`, `#prevBox`, `#titleSaveBtn`, `#titleHint`, `#titleErr`, `#photosLabel`, `#photosLabelSent`, `#photosHint`, `#pawnNone`, `#pasteBox`, `#ideaBox`, `#catChips .chip`, `.q-text`, `.howto .cat`, `details.howto`, `.howto summary`, `#qtyRow`, `#sheetClosedNote`, `#cardSoonNote`, `#paySoldOutNote`, `#wordLenHint`, `#byName`, `.pay-total .pay-now`, `.pay-total`, `.close-ask-title`, `.wa-help-label`, `#bitPayLink` (asserted ABSENT).
- Text asserted: "מקסימום", "מינימום", "התשלום התקבל", "התחייה 14", "כניסה B", "תל אביב", "11 ימי עסקים", "יישוב 0", "לא על המשלוח", "יום העסקים הבא", "חינם", "סגנון", "סגור", "יותר מדי ניסיונות", "לא הצלחנו", "וואטסאפ", "אוספים מילים על …", "קיבלנו! המשחק בהפקה" (proof/produce), "נספרות במספרים שלמעלה".

---

### 3. Top must-keep items

1. Every element ID and `data-testid` listed above, including JS-built ones (`design-<i>`, `pawn-count-<n>`, `pool-opt-<id>`, `players-<n>`, `word-text`, `pawn-thumb`, …). `next-btn`, `custom-title-input`, `#count` and `#payTotal` alone carry 300+ test uses.
2. The options step machine contract: `section.wiz-step[data-step=1|2|3|5|4]` with `.is-active`, `#nextBtn` / `#backBtn`, `?step=` pushState + popstate, `localStorage['dugri_selection']`, URL `design/color/players/step`.
3. The create payload and redirect: POST `/api/collections` (title line 1 as honoree_name, required buyer_name, normalized phone, players, arrival) then pawn upload, then `collect.html?c&k[&photos_lost]`.
4. The payment path on collect: `#cardPayBtn` → POST `/pay/init` → `#payModal` + `iframe#payFrame[allow=payment]` → `armApplePay(url)` → postMessage `{type:'dugri-pay'}` from pay-done.html and the polling fallback → `pay-success.html?back=` with `sessionStorage['dugri:payReturn']` / `dugri:payJustDone`; `/pay/cancel` on close/pagehide.
5. Dual visibility on collect: `.hidden` class rules (L574 plus overrides) AND the `hidden` attribute via `[data-panel]` tabs; `owner-only` blocks unhidden only for owners; contributor view = words panel only.
6. Pricing hooks: `.opt-price`, `.amt`, `.was` (tokens.css + `html[data-sale]`), `input[name=payVersion]` values `pdf|pickup|custom` with `#shipToggle` mapping to `delivery`, `.sales-paused`, `#priceLoadErr`, qty and one-box controls, coupon box behaviour and error copy.
7. Free-limit / deck-full lock: `#addCard.locked`, `#lockVeil`, `#lockPayBtn`, `#heldBlock`, counter copy (`#count`, `#countMax`, `#countHint`, stages, goal 70 / max deck_words).
8. Close-and-produce gate: pool radio (`name=poolOption`) + `#finishAck` → `#closeAsk` → `/close` → `/produce` polling → `proof_url` redirect; `#produceWait`.
9. All `data-edit` keys (33 options + 127 collect) unchanged and on text-only nodes; nested `collect-qty-label` > `collect-qty-sub` stays as is.
10. Business copy that tests assert or that carries meaning: title line-break/emoji/niqqud rules, "החיילים מגיעים מודפסים - פשוט גוזרים אותם בעיגול", orderer-name-not-honoree hint, pickup address/hours, 16:00 cutoff line, secure-card trust line, "חזרה לחנות", word budget "עד N מילים".

### 4. Drop candidates and dead code (evidence)

Dormant (keep; owner flag can turn on):

- `features.color_picking=false`: step 2 (`#colorList`, `.color-carousel`, `#rasterNote`), `body.is-step-color`, `select_color`, `?color=` restore. Tests: color-step-carousel, options-color-step-tabs, options-feature-flags turn it on.
- `features.name_preview=false` (and `font_choice=false`, effective only with it): `#namePreview` subtree, `#fontOpts`, instant draw (`js/name-preview-instant.js`), POST `/api/preview` from the wizard, preview gate on Next, and the teaser (`#previewTeaser` is never shown while name_preview is off: `teaserOff=true`). Heavily tested with flags on (name-preview*, wizard-preview-*).
- Versions `pdf_enabled=false`, `delivery_enabled=false`, `custom_enabled=false` by default: their radios/add-on stay in markup, hidden by pricing; `#cardSoonNote` only when no card provider; `#shipAddCard` only for paid pickup orders.
- `#waGroupPanel` only when the WhatsApp bot gave an invite link (bot number banned 2026-07; dormant in practice).
- Apple Pay (`armApplePay`) only fires on Tranzila charges; production is PeleCard.

Dead or vestigial (candidates, verify before removing; removal is a logic change, out of scope for a restyle):

- options: `selectedGender()` always null; `currentExtraFields()` `[]`, `extraFieldsValid()` true, `renderExtraFields()` just refreshControls, `collectedExtraFields()` `{}` (code comments say "kept… while the theme-side cleanup lands"). `labelForExtraField()` queries `[data-extra-field]`, which no longer exists in markup. `extraFieldsForDesign` and `languageForDesign` are imported but never called (only the import lines match). `paintStep5Summary` "שם"/extras rows are effectively name-only.
- options: `?plan=` is written by `persist()` but never read; `PLANS` has only `base`.
- options: `#previewEmpty` "טוען תצוגה…" in the stage, and the `wa-help--docked` duplicate help link, are pure presentation.
- collect: header `.brand` "דוגרי" div is presentation only; `paySoldOutNote` is visible in markup and relies solely on CSS (`.sales-paused`) to hide, so a CSS rewrite must keep that rule or it shows to everyone.
- Comments still say "PeleCard iframe" while the provider is per environment (PeleCard or Tranzila): comment drift only.
- Tests assert ABSENCE of `#bitPayLink` (Bit removed), `extra-fields`/`extra-*`, `name-preview-warning`, `order-comment-*`: do not reintroduce those ids.
- Styling debt: options `:root --accent: var(--sage)` (sage is off-brand per the black-and-white direction).

## Group B (rest) and group C: proof, pickup, pay-success, pay-done, timer, wordlists, terms, unsubscribe

Source: worktree /Users/hadar/projects/dugri-redesign @ 4d9744e. Read-only survey. Everything below is fixed in a restyle-only pass unless it is listed under (d) "old styling".

### Cross-cutting traps (apply to every page)

- **`hidden` attribute vs CSS `display`.** proof (#state, #deck, #help), pay-success (#orderNo, #orderNoCopied, #shotImg, #shotSkel), wordlists (#toc, word spans), and tokens.css all toggle visibility with the `hidden` attribute. A new rule such as `.state{display:block}` or `.orderno{display:flex}` overrides `[hidden]` and un-hides things. Either keep the current pattern (display:none until `.shown`) or add `[hidden]{display:none!important}`.
- **GA stub string = Meta pixel trigger.** server/meta-pixel.js injects the pixel only into pages that contain the literal `window.dataLayer = window.dataLayer || []` (BUYER_PAGE_MARKER). Pages that have it: pay-success, pickup, timer, wordlists, terms. Pages that don't: proof, pay-done, unsubscribe. Keep the head stub byte-identical, plus `<script src="js/consent.js" defer></script>` and `<script type="module" src="js/analytics.js"></script>`. tests/unit/analytics-coverage.test.js pins these exact tags on pay-success.
- **Asset hashing.** server/asset-hashing.js rewrites `src`/`href` attributes on js/css (relative or `/`-rooted) and injects an importmap before the first `<script type="module">`. New css/js files must sit under site/ and be referenced plainly. Don't add a query string, or the rewrite skips the file.
- **Fonts.** Load them through /assets/fonts/fonts.css only. tests/e2e/fonts-self-hosted.spec.js fails on any Google Fonts request from /timer.html or /pay-done.html.
- **Content editor.** `data-edit`, `data-edit-img` keys are owner-edited live content stored server-side by key. Renaming a key loses her edits. Deleting a node with a key silently drops her override. Keep every key, on an element of the same kind (text node vs img).
- **WhatsApp number** 972552441334 is hardcoded in proof.js, pay-success, pickup, and the terms footer. The tests assert it.

### 1. proof.html + js/proof.js (buyer deck proof)

**(a) Content.** The eyebrow "לפני שליחה לייצור". H1 "הגהת החפיסה". A lede explaining that the pages are the actual print file, not a drawing. Section "קלפי המשחק" with the hint "לחצי על קלף…". Help section "משהו לא נראה נכון?" with the WhatsApp button "שליחת הודעה בוואטסאפ". The dialog's buttons: הקודם / הבא / סגירה. State messages, all set by proof.js:

- "טוען את החפיסה…" (initial)
- "הקישור חסר פרטים…" (no c or t; no request is sent)
- "החפיסה עוד לא מוכנה…" (404, or pages=0)
- "הגהת החפיסה סגורה כרגע…" (403 with body error:'off')
- "הקישור לא תקף…" (any other 403)
- "לא הצלחנו לטעון את החפיסה…" (network error or other non-ok)

**(b) Behaviour and hooks**

- Loaded as `<script type="module" src="/js/proof.js">`. No GA, no editor.js, `noindex`.
- IDs used by JS: `state`, `deck`, `help`, `sheet`, `wa`, `big` (a `<dialog>`, opened with showModal), `bigImg`, `prev`, `next`, `close`.
- Generated DOM: `figure.card[data-n][tabindex=0][aria-label="קלף n"] > img[loading=lazy]` inside #sheet. Clicks are delegated through `.closest('.card')`; Enter or Space opens. #bigImg alt is "קלף n". The dialog's ArrowRight is previous and ArrowLeft is next (mirrored for RTL).
- The dialog needs an explicit width. A comment explains that a dialog sized only by aspect-ratio collapses, and the E2E checks that the stage is wider than a thumbnail.
- Card aspect ratio 223.92/312 is the PDF page.
- URL params: `?c=<collection id>`, `?t=<pdf_token>`, and optional `?key=<ADMIN_KEY>` when she arrives via the admin redirect.
- API calls:
  - `GET /api/collections/:id/proof?t=&key=` returns `{pages, width, name}` (server/index.js:2114, gated by proofGate plus pdfTokenOk).
  - `GET /api/collections/:id/proof/:n?t=&key=` returns an image/webp (index.js:2144).
- WhatsApp href: `wa.me/972552441334?text=היי, יש לי הערה על ההגהה של <name> (הזמנה <CID>)`.
- How buyers reach it:
  - collect.html redirects to `proof_url` from the produce/status answers (index.js:2212; collect.html:6458/6480).
  - The customer link in admin's produce response (index.js:1832).
  - Admin "proof" button: admin.html:1142 calls `/api/admin/collections/:id/proof?key=`, which 302s to `/proof.html?c&t&key` (index.js:1946).

**(c) Dynamic data.** `settings features.deck_proof` (flag, default ON; settings.js:551). When off, buyers get 403 'off' and collect.html never navigates here. Pages are rasterised server-side from the produced PDF (server/proof.js).

**(d) Old styling.** proof.html carries its own private palette (--paper/--card/--slab…) instead of tokens.css, and it is the only page in this set with a `prefers-color-scheme: dark` block. `.wa` is WhatsApp green (#25d366), which is off-brand next to the black and white elsewhere.

**Tests.** tests/e2e/proof-page.spec.js relies on:

- `#sheet .card` (count equals pages, `.nth()` clickable)
- `#state` (hidden after load, text contains עוד לא מוכנה / לא תקף / חסר)
- `#deck` hidden on 404
- `#big`, `#big .stage` (bounding box)
- `#bigImg` alt
- `#next`, `#prev`, `#close`
- `#wa` href

Unit tests: deck-proof-toggle, proof-routes, proof-cache (server side).

### 2. pickup.html (self-pickup page)

**(a) Content, every fact load-bearing**

- The hero H1 "איסוף עצמי" and the lede.
- **The wait callout comes FIRST, above the address** (the test compares y positions): "חכו להודעה מאיתנו… אל תגיעו לפני שקיבלתם את ההודעה".
- Address: בית הדפוס גלאור / התחייה 14, תל אביב / כניסה B, קומה ראשונה - פנייה ראשונה שמאלה ולעלות קומה במדרגות.
- Waze and Google Maps links (encoded "התחייה 14 תל אביב", target=\_blank, rel=noopener).
- Hours, as a real `<table>` of 7 `tbody tr`: Sun–Wed 9:00 - 16:30, Thu 9:00 - 15:30, Fri and Sat סגור (td.closed).
- What to bring: the title, the orderer's phone, the orderer's name.
- How to find the order, under the sign ״דוגרי איסוף עצמי״, including "וּודאו".
- Route: `ol.steps` with 3 `li`, plus `figure.route img` (assets/pickup-directions.jpg, 1000x1778, descriptive alt, lazy) and a caption.
- Footer: help line, WhatsApp 0552441334, mailto dugri.israel@gmail.com, and a back link to index.html.

**(b) Behaviour and hooks**

- Scripts: GA stub, consent.js, analytics.js, header.js (nav toggle), editor.js. CSS: tokens.css plus header.css. The fixed header uses `body padding-top:62px`.
- Header markup shared with other pages:
  - `.hdr`, `.hdr-toggle[data-testid=nav-toggle][aria-controls=navMenu]`
  - `nav#navMenu.hdr-menu[data-testid=nav-menu]`; header.js toggles `.open`
  - `a.hdr-order.nav-cta[data-testid=order-now]`
- data-testid: `pickup-wait`, `pickup-address`, `pickup-waze`, `pickup-gmaps`, `pickup-hours`, `pickup-bring`, `pickup-find`, `pickup-route`.
- 37 data-edit keys: `pickup-hero-*`, `pickup-wait-body`, `pickup-address-{heading,name,street,detail}`, `pickup-hours-heading`, `pickup-day-{sun..sat}`, `pickup-hours-{sun..sat}`, `pickup-bring-{heading,body,title,phone,name}`, `pickup-find-{heading,body}`, `pickup-route-heading`, `pickup-step-{1,2,3}`, `pickup-route-caption`, `pickup-footer-{help,back}`. Also `data-edit-img="pickup-route-photo"`.
- Reached by:
  - **Emails at the extension-less `/pickup`.** notify.js:308 builds `<PUBLIC_BASE_URL>/pickup` from `pickup_info.link`. The server's HTML resolver maps `/pickup` to pickup.html (index.js:5518), and the E2E covers `goto('/pickup')`. The filename must stay `pickup.html`.
  - The footer link `footer-pickup` on index, product, products and how. It must sit in the SAME `<p>` as `footer-terms`; the E2E checks this on those pages.

**(c) Dynamic data.** None fetched. The page is static plus owner overrides. Emails use `settings email.pickup_info` (ready/eta/address/address_label/link). That data is separate and NOT read by the page. tests/unit/pickup-facts.test.js pins pickup.html and the collect.html checkout note to the same facts: התחייה 14, תל אביב, כניסה B, קומה ראשונה, 15:30, 16:30, סגור, נעדכן.

**(d) Old styling.** Cards with shadow-sm and radius tokens (radius is now 0); `.callout` on --sage-tint; weights 600–700.

**Tests**

- tests/e2e/pickup-page.spec.js: H1 role heading "איסוף עצמי"; the testids above; `tbody tr` count 7 with day-name text; `ol.steps li` (3); `figure.route img` (visible, naturalWidth>0, alt>10 chars); `footer-pickup` and `footer-terms` on other pages; collect's `pickup-details`.
- tests/unit/site-editability.test.js requires keys pickup-hero-heading, address-street, address-detail, hours-thu, hours-fri, bring-title, find-body, step-2, wait-body. All keys must pass keyOk, and every editable node needs non-empty default text.

### 3. pay-success.html (payment confirmation, money event)

**(a) Content.** Check-mark disc. H1 "התשלום התקבל". Lead "תודה רבה על ההזמנה!…". Order-number button (label "מספר הזמנה", value, "הועתק ✓"). Summary "מה הזמנתם", with a skeleton line "מכינים תצוגה מקדימה…" and rows חבילה (with description), שולם/מחיר, לכבוד, עיצוב, צבע. Two facts: mail is on its way (check spam), and words can still be added until 'מספיק! סיימנו'. Primary button "חזרה להוספת מילים". WhatsApp "שאלה? דברו איתנו בוואטסאפ".

**(b) Behaviour and hooks**

- Inline classic script (not a module; it cannot import).
- IDs: `orderNo`, `orderNoVal`, `orderNoCopied`, `summary`, `shot`, `shotSkel`, `shotImg`, `summaryRows`, `backBtn`, `waBtn`.
- Classes toggled: `.shown` on #orderNo and #summary (CSS keeps them display:none until then); `img.loaded`; `.amt` on price values (tokens.css LTR price run); generated rows `p > span.k + span.v(.amt) > span.desc`.
- #shot gets `style.display='none'` when the render fails and there is no product image.
- data-edit keys: paysuccess-{title, lead, orderno-label, summary-title, shot-loading, fact-mail, fact-words, back, wa}.
- URL params:
  - `?back=<same-origin path>`, validated by `/^\/[^/\\]/`.
  - `?c=&k=` (collection id plus owner token). If absent they are parsed from the back path.
  - utm\_\* are read by attribution.js.
- Storage:
  - sessionStorage `dugri:payReturn` (fallback back path, written by collect.html:4907/7675/7796)
  - localStorage `dugri:purchase:<order_no|c>` (dedup guard)
- API calls:
  - `GET /api/collections/:id/summary?k=` (index.js:3626) returns order_no, order{version_label, description, total, charged, paid, delivery_fee, coupon, unit_price, quantity}, honoree_name, design, color, product_image, preview.
  - Then `POST /api/preview` with body `s.preview` (index.js:3449) returns `{card}`.
- Analytics, all inside `reportPurchase` and only when `order.paid`:
  - `window.dugriTrack('purchase', {collection, k})`, the first-party ledger seam set by analytics.js:16 and handled by POST /api/track.
  - `fbq('track','Purchase',{value,currency:'ILS'},{eventID:String(id)})`, with the CAPI dedup key.
  - GA4 `gtag('event','purchase',{transaction_id, value, currency:'ILS', shipping, coupon, items:[{item_id: design, item_name, item_variant, price, quantity}]})`.
- Clipboard copy on the order number.
- How buyers reach it:
  - collect.html `goPaySuccess()` sets `pay-success.html?back=<collect path>` (collect.html:7680).
  - pay-done.html at top level does `location.replace('pay-success.html')` with no query, so it falls back to sessionStorage.
  - server/attribution.js:331 lists `/pay-success.html` among OWN_LINK_PATHS.

**(c) Dynamic data.** `email.version_labels` and `email.product_info` (via the summary), the product image catalogue, and the /api/preview render.

**(d) Old styling.** `.back` and `.wa` pills (radius-pill is 0 now), shadow-md, weights 800–900, emoji glyphs ✉️ ✍️ in `.facts i`. The black disc and check already follow the new brand.

**Tests**

- tests/e2e/purchase-event.spec.js: `#orderNoVal` text, dataLayer purchase payload, fbq queue.
- admin-analytics.spec.js and admin-ads.spec.js open `/pay-success.html?c=…&k=…`.
- unit: analytics-coverage (GA stub tags, the strings `gtag('event', 'purchase'`, `currency: 'ILS'`, `transaction_id:`, `function reportPurchase`, `'dugri:purchase:'`, `localStorage.getItem`, `if (!s.order || !s.order.paid) return;`), meta-pixel (inject works on this page), buyer-copy-hyphens (copy rules), attribution-client, gendered-title.

### 4. pay-done.html (payment-provider return page)

**(a) Content.** `#msg` reads "מעבדים את התשלום…", then "התשלום התקבל ✓" or "התשלום לא הושלם". `#sub` reads "רגע אחד", then "מעבירים אתכם בחזרה…" or "אפשר לנסות שוב". `#back` link "חזרה להוספת מילים", relabelled "חזרה לאיסוף המילים".

**(b) Behaviour and hooks**

- It is the GoodURL and ErrorURL for both providers: `PUBLIC_BASE_URL/pay-done.html` and `/pay-done.html?error=1` (index.js:140). Tranzila POSTs here; index.js:4983 303-redirects POST to GET. **The filename and the `?error` param are fixed.**
- Usually rendered INSIDE the #payFrame iframe on collect.html. It posts `window.parent.postMessage({type:'dugri-pay', ok:<bool>}, '*')`. The `'*'` target is deliberate and pinned by tests/unit/pay-handoff.test.js (regex on that exact call; no secrets within 200 chars). The receiver, collect.html:7855, checks `e.source`.
- At top level:
  - ok: `location.replace('pay-success.html')`
  - error: reads sessionStorage `dugri:payReturn` and, if it matches `/^\/[^/\\]/`, shows #back with `style.display='inline-block'`. So CSS `.back{display:none}` must stay the default.
- Classes `msg ok` / `msg err` are set by className. The IDs `msg`, `sub`, `back` must stay.
- Loads editor.js (defer). No GA stub, so no pixel.

**(c) Dynamic data.** None.

**(d) Old styling.** theme-color #8ca287 (old sage), the apple-web-app/manifest metas, `--sage-deep` ok colour, #a85a4f blush error colour, bold 700/800 weights.

**Tests.** fonts-self-hosted.spec.js visits /pay-done.html. unit pay-handoff.test.js reads the source. collect-finish.spec.js deliberately does NOT load the real page.

### 5. timer.html + js/timer.js (60-second game timer)

**(a) Content.** Logo (assets/logo.png). H1 "טיימר · 60 שניות". Count "60". Status texts: "לחצו התחל", "רץ...", "מושהה", "כל הכבוד · סבב חדש?". Done state: "הזמן נגמר!". Buttons: התחל / השהה / המשך / שוב and איפוס. Back link "חזרה לדוגרי ←".

**(b) Behaviour and hooks**

- Inline module `import { tick } from './js/timer.js'`; `tick(elapsedMs, durationMs)` returns `{remaining, progress, done}` (unit test tests/unit/timer.test.js). Uses rAF with performance.now and pause-accumulating elapsed time.
- IDs: `count`, `status`, `toggle`, `reset`.
- data-testid: `timer-count`, `timer-toggle`, `timer-reset`.
- Classes toggled: `.bump` on #count (restarted every second via reflow, skipped under reduced motion); `.done` on #count and #status; `.hidden` on #reset (a utility class, `.hidden{display:none}`, which must survive). Reset is hidden until start.
- WebAudio beep (3 x 880 Hz) on finish.
- Keyboard: Space toggles, R resets.
- data-edit `timer-back-link`.
- Loads the GA stub, consent, analytics and editor.js. Listed in editor.js EDITABLE_PAGES ("טיימר") and site-editability PAGES.
- How users reach it:
  - The nav menu link "טיימר" on index (data-edit index-nav-timer), product, products, how and options.
  - scripts/smoke.mjs checks /timer.html for the marker 'טיימר'.
- **QR on printed boards: NOT FOUND.** The generator has no QR code, URL or "timer" string (grep of generator/\*.py, server, resources), and the FAQ only mentions "הטיימר". If boards carry a QR, it lives in Canva artwork on the Railway volume (unverifiable from the repo). Treat `/timer.html` as a permanent URL anyway: it is in nav menus and may be bookmarked or printed.
- **Offline:** there is no service worker or cache. "Works offline-ish" is only true once the page is loaded; it needs no network after load (except optional GA).

**(c) Dynamic data.** None.

**(d) Old styling.** Pink and gold radial gradients (rgba 229,25,125 / 188,154,76), a gradient-clipped number, breathe/glow/sheen animations, pill buttons with pink shadows, weight 900 display type, the `h1 .dot`, theme-color #8ca287, an empty `:root {}`.

**Tests**

- tests/e2e/timer.spec.js: `timer-count` reads "60" and is visible; `svg.hourglass` and `#stage` must NOT exist; reset is hidden, then visible after start, then hidden after reset.
- tests/e2e/button-tap-responsiveness.spec.js on /timer.html probes a fresh `.btn`:
  - touch-action must include `manipulation`
  - the `color` transition must be ≤0.16s
  - every `.btn…:hover` rule must sit inside `@media (hover: hover)` (at least 1 gated, 0 ungated)

  A restyle that drops the `.btn` class, its color transition or the hover gating fails this.

- fonts-self-hosted.spec.js also visits the page.

### 6. wordlists.html (every word in every buyer list)

**(a) Content.**

- Top bar with the logo (`data-edit-img wordlists-logo`) and "חזרה לאתר ›".
- H1 "רשימות המילים" and an intro explaining the 412-word decks and the top-up.
- Search box (visually-hidden label "חיפוש מילה").
- TOC heading "הרשימות".
- Messages: loading "טוען…"; empty "הרשימות עדיין לא פורסמו…"; error "לא הצלחנו לטעון את הרשימות…".
- Note that lists change and the top-up is random, linking to section 7 of the terms (`terms.html`).

**(b) Behaviour and hooks**

- Inline module script.
- IDs: `q` (input type=search), `found` (role=status aria-live), `toc` (hidden until loaded), `tocList`, `msg` (removed on success), `lists` (`<main>`).
- Generated DOM:
  - `section#list-<i>`, containing `h2` (label), `p.count` ("N מילים", `data-all` set after load), and `div.words > span` (one per word, via textContent).
  - TOC entries: `li > a[href=#list-i] + span.n`.
- Search (120 ms debounce) sets `hidden` on non-matching spans, toggles `.hit`, toggles `section.empty` (CSS `display:none` is required: the E2E expects the section hidden), rewrites counts to "n מתוך N", and sets #found to "N מילים תואמות" or "לא נמצאה מילה כזו…".
- API: `GET /api/wordlist-preview` returns `{lists:[{id,label,count,words}]}` (index.js:3036). Only enabled buyer options are included, no pool filenames, no-store.
- data-edit keys: wordlists-heading, wordlists-sub, wordlists-toc-heading, wordlists-note.
- Reached by the footer link `footer-wordlists` on index, product, products and how.

**(c) Dynamic data.** `settings wordlists.buyer_options` → wordlist-options.publicOptions → pool files (server/wordlists.js).

**(d) Old styling.** Minor; mostly tokens already.

**Tests.** tests/e2e/wordlists-page.spec.js:

- `main section` (count and text)
- `main .words span` with hasText; `main .words span.hit`
- `#toc` links by name, with href `#list-0`/`#list-1`
- `#q`, `#found` (exact texts)
- `#msg` texts
- `footer-wordlists` / `footer-terms` on other pages
- `h1`

`main` must contain ONLY list sections (the test counts `main section`). Also unit wordlist-preview.test.js.

### 7. terms.html (legal terms)

**(a) Content.**

- H1 "תקנון, תנאי שימוש ומדיניות הזמנות", sub "דוגרי ישראל", and **"עודכן לאחרונה: 24 באוגוסט 2026"** (required by §24; tested).
- TOC `nav.toc[aria-label="תוכן עניינים"]` with 26 links. The 26 `<section id="sec-1..26">` clauses each have `h2 > span.num + title`:
  1 מבוא והגדרות · 2 תחולת התקנון · 3 המוצרים וההתאמה האישית · 4 תמונות ותוכן שהועלו · 5 חיתוך ועיבוד תמונות · 6 איסוף מילים וקישורים · 7 השלמת מילים אוטומטית · 8 תקופת מימוש הזמנה - 60 ימים · 9 מחירים, קופונים, מבצעים וטעויות · 10 שליחה להפקה ואישור סופי · 11 ביטול עסקה · 12 זמני ייצור ואספקה · 13 איסוף עצמי · 14 משלוחים · 15 איכות, פגמים ובדיקת המוצר · 16 אלכוהול ובטיחות · 17 קניין רוחני · 18 שימוש בתמונות המוצר לפרסום · 19 פרטיות, ספקים ואבטחת מידע · 20 זמינות האתר, תקלות וגיבויים · 21 סירוב, השעיה וביטול מצד העסק · 22 הפסקת פעילות העסק · 23 הגבלת אחריות · 24 שינוי התקנון · 25 דין, סמכות שיפוט ופניות · 26 אישור הלקוח.
- §25 `p[data-edit=terms-contact]`: gocar, ח.פ. 516264108, mailto dugri.israel@gmail.com, tel 055-244-1334.
- The sign-off "דוגרי ישראל | תקנון ותנאי שימוש".
- Footer icons for WhatsApp, call and Instagram, contact lines, and the tag line.
- **The legal text must be moved verbatim; do not re-flow wording.**

**(b) Behaviour and hooks.**

- No page JS except the GA stub, consent, analytics and editor.js (module).
- Footer anchors carry `data-ga="contact_click"`, `data-ga-channel=whatsapp|call|instagram` and `data-ga-where=footer`, consumed by analytics.js's delegated listener. Also `#igLink` and `#igLabel` (the shared footer pattern).
- data-edit keys: terms-heading, terms-sub, terms-contact, terms-footer-{brand, wa-label, mail-label, tag}.
- Anchors `#sec-N` are deep-linked (the wordlists note cites section 7).
- Reached by the footer `footer-terms` (text "תקנון ותנאי שימוש", href `terms.html`) on index, product, products and how.

**(c) Dynamic data.** None.

**(d) Old styling.** The page CSS is minor; it already uses tokens.

**Tests.** tests/e2e/terms.spec.js:

- `main section` count exactly 26
- `#sec-1/13/26` each have a non-empty `h2` and a first `p`
- headings named ביטול עסקה / זמני ייצור ואספקה / איסוף עצמי / משלוחים
- navigation "תוכן עניינים", where clicking ביטול עסקה must reach URL `#sec-11` and bring it into view (a sticky header must not cover it)
- **body must contain no "[" character** and no "להשלמה לפני פרסום"
- text matching /עודכן לאחרונה/
- link "חזרה לאתר" with href `index.html`
- `[data-edit="terms-contact"]` contents
- `footer a[href*="wa.me"]`

### 8. unsubscribe.html (email opt-out)

**(a) Content and states**, all rendered by script into `#title` and `#body`:

- Loading: "רגע…" / "טוען…".
- Invalid (missing e or t): "קישור לא תקין" plus "הקישור חסר או שגוי…".
- Invalid (403 or error): "קישור לא תקין" plus "הקישור פג או שגוי. כתבו לנו ונסיר אתכם ידנית."
- ON: "להפסיק לקבל מיילים מדוגרי?" plus the address, the `.what` warning (stops ALL mail, including order confirmation, receipt, word-collection link and the ready notice; you can return here) and the button `#stop` "כן, להפסיק לשלוח".
- OFF: "הפסקנו לשלוח לך מיילים" plus the address, `.what`, `#undo.ghost` "בעצם, אשמח לקבל מיילים" and the WhatsApp hint.
- Re-subscribed: "חזרת לרשימה" plus `#stop` "בכל זאת, להפסיק".
- Error line `p.err` "משהו השתבש. נסו שוב."

**(b) Behaviour and hooks**

- Inline module. URL params `?e=<email>&t=<hmac token>`.
- API:
  - `GET /api/unsubscribe/status?e&t` returns `{email, unsubscribed}`
  - `POST /api/unsubscribe` with `{email, token}`
  - `POST /api/resubscribe` with `{email, token}`

  (server/routes/platform.js:72/82/93). The page reports the state it FINDS, because a mail client's RFC 8058 one-click may have already unsubscribed.

- Buttons are disabled while a request is in flight. HTML is built with innerHTML plus `esc()`. The classes `.addr`, `.what`, `.ghost`, `.muted`, `.err` are emitted from JS strings, so a restyle must style those class names (or edit the strings carefully).
- Reached by the email footer link built in server/unsubscribe.js:126 (`/unsubscribe.html?e=&t=`), with the List-Unsubscribe header pointing at `/api/unsubscribe?` (notify.js:1053). **The filename and params are fixed: links sit in mailboxes.**
- No GA, no editor, `noindex`.

**(c) Dynamic data.** The unsubscribe store (server/unsubscribe.js). No settings.

**(d) Old styling.** A hardcoded warm palette (#f7f4ef, #23201c, #e4ddd0, #4b463d), weights 700–800, and no tokens use beyond the import.

**Tests.** tests/e2e/unsubscribe.spec.js:

- `#title` texts (להפסיק / הפסקנו לשלוח לך מיילים / חזרת לרשימה / קישור לא תקין)
- `.what` containing קבלה and מוכן
- `#stop`, `#undo`
- `button` count 0 on a tampered link

Plus unit unsubscribe.test.js.

### Top must-keep items

1. **The pay-done contract.** The filename and `?error`, which are the provider Good/Error URLs plus the POST→GET bounce. `postMessage({type:'dugri-pay', ok}, '*')` byte-shape, which is test-pinned. The top-level `location.replace('pay-success.html')`. `#msg/#sub/#back`, with `.back` hidden by default.
2. **The pay-success purchase block, verbatim.** `reportPurchase`: the paid guard, the `dugri:purchase:<id>` localStorage dedup, dugriTrack, fbq Purchase with eventID, and the GA4 purchase payload. The GA stub, consent and analytics tags, which also gate Meta pixel injection. `?back`/`?c&k` and sessionStorage `dugri:payReturn`. The `#orderNoVal`, `#summaryRows`, `#shotImg` IDs and the `.shown` gating.
3. **Proof IDs and states.** `#state #deck #help #sheet #wa #big(dialog) #bigImg #prev #next #close`, `figure.card[data-n]`, an explicit dialog width, the distinction between the two 403s, and that no request is sent without `c` and `t`.
4. **The pickup facts and their order.** The wait callout ABOVE the address; the address with entrance and floor; a 7-row hours table (Thu 15:30); the 3 bring items; the 3 route steps plus the photo. All `pickup-*` testids and 37 data-edit keys. Must stay in sync with collect.html (pickup-facts.test). `/pickup` is the email URL, so the filename is fixed.
5. **The terms legal body verbatim.** 26 `main section#sec-N`, the TOC nav `aria-label="תוכן עניינים"`, the "עודכן לאחרונה" date, the §25 business identity, no `[` anywhere in the body, and #sec-11 must stay unobscured when jumped to.
6. **Unsubscribe.** The `?e&t` URL from the emails, the state-reporting flow (status first), `#title/#body/#stop/#undo` and the `.what` text that lists everything that stops, plus the re-subscribe path.
7. **Timer.** The `timer-count/toggle/reset` testids and IDs, the `.hidden` reset utility, `.done` and `.bump`, `.btn` with touch-action manipulation, a ≤0.16s colour transition and hover inside `@media (hover:hover)`, no `svg.hourglass` and no `#stage`, the `/timer.html` URL (nav plus possibly printed), and the `./js/timer.js` `tick` import.
8. **The wordlists DOM contract.** `main#lists` holds only `section#list-i` > `h2`, `p.count[data-all]`, `div.words > span`; `section.empty{display:none}`; `.hit`; `#q #found #toc #msg`; the exact count and found strings; and the footer link `footer-wordlists` in the same footer row as `footer-terms` and `footer-pickup` on the four storefront pages.

### Drop candidates (styling only, with evidence)

- timer.html: the empty `:root {}`; the pink and gold radial-gradient backgrounds, the glow `::before` and `breathe` keyframes, the `.btn::after` sheen, and the pink box-shadows (off-brand per the black-and-white direction; no test reads them). Keep `.btn` itself and the hover-media gating. Also `h1 .dot` colour, and theme-color `#8ca287` (old sage, which tokens.css remapped to black).
- pay-done.html: theme-color `#8ca287`, `#a85a4f` blush, and the manifest and apple-web-app metas. The page lives in an iframe or flashes for a moment, so they have no effect. No test references them.
- proof.html: the private `--paper/--slab` palette and its dark-mode block. It is the only page here with dark mode, and it duplicates tokens.css. The green `.wa` (#25d366) as well; keep `#wa` and its href logic.
- unsubscribe.html: the hardcoded warm hex palette (#f7f4ef, #23201c…), to be replaced by tokens. The class names stay.
- pay-success.html: the emoji icons ✉️ ✍️ in `.facts i` (decorative, aria-hidden, untested), and the pill radius and shadow on `.back`/`.wa`.
- pickup.html: the shadow-sm card chrome and the `.callout` sage-tint wash. Keep testids, keys and the order of elements.
- `tick().progress` in js/timer.js is an unused leftover from the hourglass. It is logic, not styling, and timer.test.js may assert it, so leave it alone in a restyle.
- NOT droppable even though it looks inert: editor.js on pay-done (the content editor's door) and analytics.js on terms, wordlists and timer (attribution plus pixel marker).

## Summary for gate D1

### The 10 most important must-keep items (all pages)

1. Every `data-edit` / `data-edit-img` / `data-edit-pd` / `data-edit-photos` key, on an element of the same kind, plus `<meta name="dugri:page">`: the owner's live copy and photos hang on them (index 49 + 9 image keys, options 33, collect 127, pickup 37, and the rest listed above).
2. The payment contract: `#cardPayBtn` → POST `/pay/init` → `#payModal` / `iframe#payFrame[allow=payment]` → `armApplePay` → `pay-done.html` posting `{type:'dugri-pay', ok}` to the parent (and redirecting to pay-success at top level) → polling fallback → `pay-success.html?back=` with `sessionStorage` `dugri:payReturn` / `dugri:payJustDone`.
3. The pay-success purchase block verbatim (paid guard, `dugri:purchase:<id>` dedup, `dugriTrack`, Meta Purchase with eventID, GA4 purchase), and the GA stub on every buyer page (it also switches on the Meta pixel).
4. The options step machine: `section.wiz-step[data-step]` with `.is-active`, `#nextBtn` / `#backBtn`, `?step=` with pushState/popstate, `localStorage['dugri_selection']`, the create call POST `/api/collections` and the redirect to `collect.html?c&k`.
5. Collect's state hooks: the five `[data-panel]` tabs, owner-only blocks vs the contributor view, the free-limit lock (`#addCard.locked`, `#lockVeil`, `#lockPayBtn`), the counter (`#count`, `#countMax`, `#countHint`), and the close-and-produce gate (`poolOption`, `#finishAck`, `/close`, `/produce`, proof redirect).
6. The price contract fed by `/api/pricing`: `.amt`, `.was`, `[data-price-*]`, `[data-sale-label]`, `#saleBanner`, `html[data-sale]`, `input[name=payVersion]`, `#shipToggle`, `.sales-paused`, `#payTotal`. No price in markup.
7. JS mount points on the storefront: `#productsTrack`, `#storeGrid`, `#galleryTrack`, `#relatedTrack`, `#reviewsTrack`, `#faqList`, `[data-testid=orders-count]`, `#pdpTitle`, `#pdpBuy`, plus the carousel / lazy-media contract (`data-carousel-clone`, `data-lazy-src/srcset/sizes`, `data-design-id`, `data-store-default`).
8. `data-testid`s and the exact Hebrew strings the E2E suite asserts (`next-btn`, `custom-title-input`, `#count` and `#payTotal` alone carry 300+ uses; 62 specs touch options or collect), and the things tests assert are absent (`#bitPayLink`, `extra-*`, `name-preview-warning`, `order-comment-*`).
9. Fixed URLs and their query contracts: `/pickup`, `unsubscribe.html?e&t`, `pay-done.html[?error]`, `collect.html?c&k`, `proof.html?c&t[&key]`, `partner.html?t`, `product.html?design=`, `options.html?design&step`, `/timer.html`.
10. Analytics and attribution hooks: `data-ga`, `data-ga-cta`, `data-ga-channel`, `data-ga-where` on CTAs and contact links, `/api/track`, the cookie notice (`localStorage.dugri_cookie_notice`), and `a[data-start-explainer]` on wizard entry points.

### What could be dropped (evidence in the sections above)

- **`how.html` as it stands.** It describes the old print-it-yourself PDF product ("PDF מוכן, מתאים לכל בית דפוס", "מינימום 70", "הכל כלול בקובץ אחד - ב-199 ₪"), while live pricing has the PDF version off and pickup and delivery on. It is not linked from home, the shop, the product page or the footer; only from the options nav, the pickup menu and admin pickers. Its "הצצה" / "המלצות" links point at `index.html#gallery` and `#proof`, which do not exist. Production carries a "48 שעות" override that contradicts "4 ימי עסקים" elsewhere. Rewrite it for the printed game or fold its steps into the home page. Decision for the owner.
- **Dead code on index and how:** the unused `pay()` / Tranzila CONFIG block, the confetti script on how (its target element does not exist), about 25 dead CSS blocks on how, and `js/demo-banner.js` (a no-op).
- **Hardcoded prices** in markup: `product.html` 79/129, `how.html` 199/239, and the literal 199 inside the editable `how-delivery-note`.
- **Duplicated chrome:** the header is copied into three pages and the footer into four (plus a legacy nav on how and options). One shared partial is a redesign candidate, keeping the page-prefixed edit keys.
- **The home marquee's eight copies** of the same spans: keep the keys, generate the repeats.
- **Leftover styling with no test or hook:** timer's pink and gold gradients, glow and sheen; the sage `theme-color` (`#8ca287`) on timer and pay-done; proof's private palette and dark-mode block; unsubscribe's hardcoded warm palette; tokens named `--sage` / `--blush` that are both black.
- **Dead logic on options/collect, listed for awareness only** (removing it is a code change, not part of a restyle): the gender and extra-field stubs, the `[data-extra-field]` lookup, unused imports `extraFieldsForDesign` / `languageForDesign`, `?plan=` written but never read, and collect's `APPLY` / `SYNCSHIP` console logs.
- **Not droppable although it looks inert:** `partner.html` (the affiliate earnings report, reached only from the admin coupons page via a `?t=` token link; it is an Operate page, not a storefront page), `editor.js` on pay-done, `analytics.js` on terms / wordlists / timer, and the dormant flags `color_picking`, `font_choice`, `name_preview` plus the pdf / delivery / custom versions (built, switched off by default, may be switched on from the admin).

### Upcoming, not on main

- **Friend-coupon bar** (`origin/feat/friend-coupon`, commit 073167e, no PR yet): for visits with `?coupon=CODE`, `analytics.js` would put a fixed bar on buyer pages, set `--friend-bar-h` and auto-fill the coupon on `collect.html`. The redesign must leave room for a fixed bar and keep the coupon field hooks.
