# Critique: the current Dugri site (before the redesign)

Method: dual-agent (A: isolated design review of screenshots + source · B: isolated `impeccable detect` CLI scan + in-browser detector injection on localhost + Playwright metrics). Synthesis by the Phase 1 agent, 2026-10-12, at commit 4d9744e (origin/main).

Scope: groups A, B and C of REDESIGN_PLAN.md (15 customer pages). Judged at 390px first, then 1440px. Evidence: `redesign/screens/<group>-<page>-<width>.png`. Production content was used for A pages; collect, proof, partner, pay-done and unsubscribe were shot on the local server with seeded or mocked data (see `redesign/inventory.md`, "Screenshot notes").

This is a critique of the incumbent site to feed a total redesign. Per REDESIGN_PLAN.md the old look is evidence and anti-reference, not something to polish. Issues that touch group B behaviour are recorded for the owner; under the plan, group B gets a restyle only unless gate D7 decides otherwise.

## Design health score

| #         | Heuristic                       | Score     | Key issue                                                                                                                                                   |
| --------- | ------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Visibility of system status     | 2         | The wizard's "שלב 4 מתוך 4" ends without payment; nothing says "now pay inside the collection". The production clock is never shown as a state.             |
| 2         | Match system / real world       | 2         | The site sells a printed game, but `how.html` and the options step-4 copy still describe a PDF file. Feminine-singular address on proof and options.        |
| 3         | User control and freedom        | 3         | Design is changeable at any time, words are removable, back buttons exist. But a share link gives every contributor the organiser's controls.               |
| 4         | Consistency and standards       | 1         | Two visual systems, two header patterns. Word target 70 / 100-400 / 412 / "unlimited". Lead time 48 hours vs 4 business days. Price 199 vs 239 on one page. |
| 5         | Error prevention                | 2         | Title-length guards are careful. Unsubscribe stops transactional mail with one tap; contributors can reach payment and send-to-production.                  |
| 6         | Recognition rather than recall  | 3         | Thumbnails, live card/back/board preview tabs, category prompts.                                                                                            |
| 7         | Flexibility and efficiency      | 3         | Word / list / file entry, idea button, WhatsApp share. Power is there, just unordered.                                                                      |
| 8         | Aesthetic and minimalist design | 2         | Storefront calm but generic and long; collect is emoji-dense; `how.html` repeats its own title.                                                             |
| 9         | Error recovery                  | 1         | The payment-failure page can render with no action at all.                                                                                                  |
| 10        | Help and documentation          | 3         | WhatsApp on every page, FAQ, word-lists page, pickup page. Undermined by contradictory facts.                                                               |
| **Total** |                                 | **22/40** | **Acceptable (low end): significant work needed**                                                                                                           |

All ten heuristics were scored; the site spans Persuade and Operate surfaces, so 7 and 10 apply.

## Design specificity verdict

**LLM assessment: mostly category-interchangeable, with a few authored islands.** Cover the logo and the board photos and the storefront (index, products, product, pickup) reads as a generic boutique template: off-white and sand bands, centred thin tracked headings, a black rectangle CTA, a stat box, a product carousel, a testimonial slider with five gold stars, a founders' story, an FAQ accordion, a "ready to surprise?" band, a dark footer. Swap the name for a candle brand and almost nothing changes. The product's real hook, words only the people at the table know, is never a graphic idea anywhere: the site sells the board's look, never the word as the gift.

Authored islands worth carrying into the redesign as ideas (not as styling):

- `timer.html`: big logo, a giant "60", one button. The only page that feels like the game rather than a shop.
- The home marquee ("מנחשים מילים · מפעילים את הטיימר · כל המילים עליכם") names the mechanic, but is set as quiet decoration.
- The collect page's word chips with the contributor's name ("ספרים · מיכל") are the one place the product's essence is visible, on the page with the least visual care.

The identity is split twice: the logo is loud Y2K chrome-pink with a lightning bolt, the site around it is hushed beige-and-black luxury; and inside the site, `how.html`, the options header and the timer use bold pills with a pink glow while the rest uses thin tracked Heebo Light. Token names show a repaint rather than a system (`--sage` and `--blush` are both `#141414` in `site/css/tokens.css`; `pay-done.html` still ships a sage `theme-color`; the footer phone icon is still sage green).

**Deterministic scan.** `impeccable detect` over the 15 pages: exit 2, 34 findings. By rule: low-contrast 9, broken-image 7, wide-tracking 6, cramped-padding 3, gradient-text 3, and one each of em-dash-overuse, skipped-heading, dark-glow, buried-raster, bounce-easing, cream-palette. By file: options 8, collect 7, how 5, index 4, timer 4, proof 2, pay-success 2, terms 1, unsubscribe 1; products, product, partner, pickup, pay-done and wordlists are clean.

Where the scan and the review agree:

- **Wide tracking on Hebrew** (index, terms, options, collect). The review independently found that 0.1-0.14em tracking breaks Hebrew word shapes ("ה ע י צ ו ב י ם").
- **Gradient text, dark glow, bounce easing** on `how.html` and `timer.html`: the second, pink-glow visual system.
- **Skipped heading** on `how.html` (h2 "מה מקבלים" followed by h4s).
- **Cream palette** on `unsubscribe.html`: a page that has its own hardcoded warm colours, off-system.

What the scan caught that the review did not:

- White on WhatsApp green (#25d366) is 2.0:1 (wa-help button, collect's share button).
- The options preview tabs (קלף / לוח / גב) are white on #af9b80, 2.7:1.
- The struck-through price `#planWasAmt` renders at 10.75px.
- `collect.html` leaves `APPLY` / `SYNCSHIP` debug logs in the console on every sync.

False positives: all 7 broken-image findings (preview `<img>`s that JS fills at runtime; not reproduced in the browser run), the buried-raster on pay-success (`#shotImg` is hidden on purpose), the static "white on #f4efe6" pairs (not reproduced live), and a live 1.0:1 white-on-white on options (state-dependent, unidentified).

**Visual overlays.** Detector injection succeeded on 5 local pages in a headless run (index 1 finding, products 0, options 3, collect 1, pickup 0). That run was headless, so no overlay is open in anyone's browser.

**Metrics at 390px (local).** Tap targets under 44x44: index 13, products 37, options 7, collect 37, pickup 9. The real failures are carousel dots (8x8), the cookie-banner close (12x14), collect's word-delete "×" (15x18) and collect's input-mode tabs (27px tall); most of the rest are inline footer links. Text under 14px: index 88, products 24, options 21, collect 22. Every image has an alt; no page scrolls sideways. Production image weight: index 2.72 MB of images (hero JPEGs 256-331 KB each), products 1.06 MB; `logo.png` is 222 KB and displays at 34x34.

## Overall impression

The storefront is tidy and calm but anonymous, and it whispers at an audience that is planning a loud party. The order flow underneath is careful, thoughtful engineering wrapped in a dashboard that asks too much at once. The single biggest opportunity: make the word the hero. One card, one inside joke, one 60-second clock is more Dugri than any number of board photos, and it is exactly the "graphic, moving, nothing seen before" brief.

## What's working

1. **WhatsApp is a real channel, everywhere.** It sits on every page, including proof ("משהו לא נראה נכון?"), pay-success and partner. That matches how the buyer lives.
2. **The options wizard is a genuine one-thing-at-a-time flow** with a live card / back / board preview, a progress bar and a persistent bottom bar (Next, Back, help).
3. **Real, specific trust material exists:** customers' own WhatsApp testimonials, a founders' story with childhood photos, a live celebrations counter, a precise pickup page (entrance, floor, Waze and Maps buttons). Few competitors have this; today it is presented generically.

## Priority issues

**[P0] The same facts differ from page to page (words, format, lead time, price).**

- Words: `how.html` and collect say a minimum of 70; the home FAQ (also `server/faq.js`) says 100 to 400; collect and wordlists say up to 412; `product.html` says "ללא הגבלת מילים".
- Format: `how.html` says "PDF מוכן, מתאים לכל בית דפוס" and explains which paper to buy; the FAQ and `pickup.html` describe collecting a printed game from the Galor print shop. The `pdf` version is switched off in live pricing.
- Lead time: production `how.html` (a content-editor override, verified via `/api/content?page=how.html`) says "תוך 48 שעות"; everywhere else says 4 business days.
- Price: `how.html` CTAs read the live price, but "הכל כלול בקובץ אחד - ב-199 ₪" is literal text inside the editable `how-delivery-note`, which pricing.js never updates. `product.html` ships hardcoded 79/129 fallbacks.
- Why it matters: the organiser reads two or three pages before paying. Contradictions about money and time kill trust and create WhatsApp support load.
- Fix: one source per fact. Prices from `/api/pricing`. Word limits and lead time either from the server or not stated at all. Rewrite or retire `how.html`. No numbers inside `data-edit` prose.
- Suggested command: `/impeccable clarify`, then `/impeccable harden` for the data binding.

**[P0] The payment-failure page can be a dead end.**

- `pay-done.html?error` (B-pay-done-390.png) shows "התשלום לא הושלם / אפשר לנסות שוב" on a blank page: no logo, no button, no WhatsApp. The way back appears only if `sessionStorage['dugri:payReturn']` exists (storage blocked, a different tab, or a webview loses it).
- Why it matters: a failed payment is the highest-stress moment in the funnel.
- Fix: always show a branded page with a primary way back and WhatsApp. Changing this touches group B behaviour, so it needs the owner's go-ahead at D7 (it is additive: no existing ID or contract changes).
- Suggested command: `/impeccable harden`.

**[P1] Ordering and paying are split; "step 4 of 4" is not the end.**

- `options.html` ends at "שלב 4 מתוך 4 · הפרטים שלכם" without payment. Payment is the "תשלום" tab, one of five on `collect.html`.
- Why it matters: working-memory and status failure. She thinks she has ordered; paying is hidden behind a tab.
- Fix within restyle-only: show the whole journey in the progress language, and give the payment tab the visual priority when the collection is unpaid. A real flow change is a D7 question.
- Suggested command: `/impeccable onboard` + `/impeccable layout`.

**[P1] `collect.html` serves contributors and the organiser with one interface.**

- A friend arriving from the share link sees five tabs (including payment and send-to-production), three entry modes before the first word, an unlabelled "מי מוסיף? (לא חובה)" box, and 11 emoji category chips. The share copy tells her she can also "manage the collection". The floating WhatsApp button covers word chips at 390px.
- Why it matters: contributors (often older relatives) are the product's content supply. Fear of "will I be charged?" costs words.
- Fix within restyle-only: visual hierarchy that makes "add a word" the single dominant action, a placeholder example for the name field, quieter organiser tabs, chips as one prompt at a time, the float moved clear of the content.
- Suggested command: `/impeccable distill` + `/impeccable adapt`.

**[P1] Two visual identities and no brand idea.**

- Thin tracked beige luxury on most pages; bold pills with pink glow on `how.html`, the options header and the timer; a chrome-pink Y2K logo that fits neither. Hebrew headings tracked at 0.1-0.14em. Centred multi-line Hebrew paragraphs. Nothing visual expresses "the words are the gift".
- Why it matters: category-interchangeable, and the brief asks for "nothing seen before".
- Fix: Phase 2 direction work. Build the identity from the product (the card, the word, the 60-second clock, the board path), one type system with no Hebrew letter-spacing, one accent that can stand next to the logo (or a decision at D3 to redraw it).
- Suggested command: `/impeccable bolder`, then `/impeccable typeset` and `/impeccable colorize`.

**[P2] Home hero: an auto-rotating carousel with the CTA above the headline.**

- Three slides rotate; only slide 1 has the `<h1>`; the CTA floats above a thin headline over a busy pink photo. The header repeats a second black "הזמינו עכשיו" at the same weight; `product.html` shows three ordering buttons in its first screen. The marquee runs forever with no pause control.
- Fix: one static hero with one promise, the mechanic shown graphically, the CTA under the promise, one ordering CTA per screen, and pausable or reduced motion.
- Suggested command: `/impeccable layout` + `/impeccable quieter`.

**[P2] The emotional peaks are under-designed.**

- `proof.html` (the first time she sees her own cards) is a plain grid captioned "לחצי על קלף". `pay-success.html` never restates the rule she needs next (the clock starts when the words are sent). `pickup.html` leads with a warning box: the purchase journey ends on a scolding.
- Fix: stage the proof as a reveal, put the clock rule on pay-success, lead pickup with "your game is waiting" before the rules (keeping the E2E-pinned order of the wait note above the address; see inventory).
- Suggested command: `/impeccable delight` + `/impeccable animate`.

**[P3] Gendered microcopy and the unsubscribe scope.**

- Feminine or singular address breaks the plural rule: "לחצי" and "כתבי" on proof, "יש לך קוד?" on options, "היא חסכה" on partner.
- `unsubscribe.html` stops all mail, including the order confirmation and the "game is ready" notice, with one button.
- Fix: plural address throughout. Splitting marketing from order mail is a server change, outside a restyle.
- Suggested command: `/impeccable clarify`.

## Persona red flags

**Casey (distracted mobile user)**

- The hero changes while she reads; the CTA moves.
- Three order buttons in `product.html`'s first viewport.
- Collect's floating WhatsApp sits on top of word chips; one mis-tap leaves the page.
- Ten equal design tiles in the wizard and no "popular for bachelorettes" shortcut.
- 2.7 MB of images on the home page over mobile data.

**Jordan (first-timer)**

- Opens "איך זה עובד?" from the options nav and learns she will get a PDF to print, then reads "pickup at a print shop" in the FAQ.
- Cannot tell whether she needs 70, 100, 400, 412 or unlimited words.
- Finishes "step 4 of 4" and believes she has ordered and paid.

**Riley (stress tester)**

- Opens the pay-done failure URL directly: dead end.
- Shares the collect link; a friend opens payment or send-to-production.
- Unsubscribes mid-order and never gets the pickup notice.
- Sees 199 and 239 on the same page.

**The organiser arriving from WhatsApp (project persona)**

- The first screen does not say "a game made of your words about her"; the mechanic is in a centred grey paragraph below the fold.
- The lead time, the fact tied to her event date, is in an FAQ accordion and contradicted on `how.html`.
- The home page has two endings ("מוכנים להפתיע?" then a B2B section), pushing the last CTA further away.

**An older relative adding words from a shared link (project persona)**

- "מי מוסיף? (לא חובה)": whose name goes here?
- Three entry modes with emoji icons before the first word.
- "תשלום" and "שליחה לייצור" tabs look clickable and alarming.
- Small grey attribution and an "×" on every chip invite deleting other people's words.
- "תקועים?" opens 11 chips at once.

## Minor observations

- `options.html` says "החל מ- 239 ₪" ("starting from") over a single price.
- The products grid shows four carousel dots under each of ten cards: forty dots of noise, each 8x8.
- The home testimonial sits in three nested frames (screenshot, white frame, sand band). At 1440 the testimonial carousel shows a cropped neighbour slide.
- `how.html` offers "חזרה לעמוד הבית" as its secondary hero CTA; its "הצצה" and "המלצות" links point at `#gallery` and `#proof`, which do not exist on index.
- `timer.html`: the start button is modest for a loud room; the big number could be the tap target.
- `wordlists.html` is about 42,000px tall on a phone and linked from every footer.
- `partner.html`'s sales table is clipped at 390 with no scroll cue.
- `collect.html`'s header shows the logo and the word "דוגרי" stacked.
- `unsubscribe.html` and `pay-done.html` have no logo or header; reached from email, they look slightly suspicious.
- The footer has three round icons in three unrelated colours; two phone numbers with no explanation of which is which.
- `logo.png` is 222 KB for a 34px header mark.

## Questions to consider

1. If the words are the product, why does no page show a word? Could the hero be one giant card with a fictional inside joke, flipping, with the 60-second clock beside it?
2. Should a contributor ever see that a shop exists? What would `collect.html` look like designed for a grandmother first and the organiser second?
3. Is the chrome-pink logo the brand, or something the site has been politely ignoring? "Graphic, nothing seen before" has to either build up to it or redraw it (gate D3).
4. Ten designs presented as equals, named after cities: would leading with occasions (bachelorette, 50th, anniversary) convert better?
5. What is the one number Dugri promises, words, days or price? If a fact cannot be the same on every page, should the site state it at all?

## Questions for the owner (gate D1)

These are the critique's closing questions. No interactive question tool was available to this agent, so they are deferred to gate D1 rather than skipped.

1. **Priority for the redesign.** Which matters most first? (a) one brand idea and one visual system (the P1 identity issue), (b) trust and consistency of facts (the P0 contradictions), (c) the order-flow clarity on options/collect (needs a D7 decision).
2. **Tone.** The storefront is hushed and luxurious; the product is a loud party. Should the new site feel (a) loud and playful like the party, (b) bold but clean (graphic, few elements, strong motion), or (c) keep the current calm and add motion only?
3. **Behaviour fixes outside "restyle only".** The pay-done dead end, the contributor view on collect and the unsubscribe scope all need behaviour changes. (a) Fix them as separate small PRs now, (b) bundle them into group B at D7, or (c) leave them as they are.

Not persisted to `.impeccable/critique/` on purpose: this file is the archive for the redesign, and the plan keeps Phase 1 output under `redesign/`.
