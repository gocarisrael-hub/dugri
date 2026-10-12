# Product

<!-- impeccable:product-schema 1 -->

Written by `/impeccable init` on 2026-10-12 for the site redesign (REDESIGN_PLAN.md, gate D1). No owner interview took place: every fact below was inferred from the repository (CLAUDE.md, live site copy, `server/settings.js`, `docs/`, the `dugri-brand` skill) and the redesign brief. Anything the repo could not settle is marked **OPEN QUESTION** for the owner to answer at gate D1.

## Platform

web (mobile web first; Hebrew, right-to-left)

## Users

**Primary: the organiser.** Mostly a woman planning a celebration around one person: a bachelorette (רווקות), a round birthday, an anniversary, a retirement or a farewell. She usually arrives on her phone from a WhatsApp link or an Instagram post, often in a few spare minutes, sometimes close to the event date. Her job: find a gift that is personal and gets the whole room laughing, order it, gather the words, and have it ready in time.

**Secondary audiences (all real, all served by existing pages):**

- **Contributors.** Friends and family the organiser shares a collection link with. They add words on `collect.html` without ever having been to the shop. Low commitment; they need the link to explain itself.
- **Players at the party.** They meet the product as a printed board and cards, plus the 60-second timer page (`timer.html`) reached from a QR code printed on the board.
- **Businesses.** Companies and event planners ordering several copies (team gift, conference ice-breaker, a branded game). Today this is a WhatsApp conversation, not a checkout.
- **Partners.** Creators/affiliates with a partner coupon who check their sales on a private report link (`partner.html`).

OPEN QUESTION: the split between occasions (how much of the business is bachelorettes versus birthdays, anniversaries and the rest) is not in the repo. The redesign should know which occasion to lead with.

## Product Purpose

Dugri (דוגרי) turns the words, inside jokes, people and places of one person's life into a custom team word-guessing party game: a personalised card deck and a game board, designed and printed for that one celebration.

How the game plays: the group splits into teams. A player draws a card and describes the word without saying it while the timer runs; the team guesses as many as it can before time is up, and moves along the board. The catch is that every word is about the person being celebrated.

How ordering works:

1. Pick a design (board theme) in the shop. Any design fits any occasion; the buyer writes her own title for the deck.
2. Configure and pay on the order wizard (`options.html`).
3. Collect words on `collect.html`, alone or with friends via a share link. Short lists are topped up from seed word pools the buyer can choose (`wordlists.html` lists them).
4. Press "send to production". Dugri produces the deck; the buyer may see a proof of every page (`proof.html`) when that feature is on.
5. Collect the printed game at the print shop, or get it by courier, depending on which versions the admin has enabled.

Success: the buyer finishes the order on her phone without asking for help, her friends actually add words, the game arrives before the party, and the room laughs for an hour and a half. Then she posts it and tags Dugri.

## Positioning

The game is made of words only the people at the table know. A generic party game, a printed mug or a photo book cannot do that: the content is the gift. The name says it too: "דוגרי" is Israeli slang for straight talk, no filters, and the game only works because the words are honest and personal.

Positioning line in use: "דוגרי, המתנה הכי אישית ומקורית שאפשר לתת".

## Operating Context

- **Phone, Hebrew, RTL.** Buyers and contributors are almost always on mobile. Links travel through WhatsApp; the WhatsApp button is a real support channel, not a decoration.
- **Time pressure.** Orders are tied to an event date. Production time and the cut-off ("the clock starts when the word list is sent, not when you pay") matter to her more than features.
- **Collaborative collection.** One organiser, many contributors, one shared link. Contributors may never see the shop.
- **Physical fulfilment.** Self-pickup from the Galor print shop in Tel Aviv (address, hours and what to bring are on `pickup.html`), and courier delivery via HFD. Which of these are offered at any moment is an admin switch.
- **At the party.** The timer page runs on someone's phone in a loud room, reached from the printed QR code. Its URL is printed on boards that already exist.
- **Owner self-serve.** The owner edits prices, sale mode, enabled versions, FAQ, emails, WhatsApp/SMS texts, the home "new game" block and most site copy herself, from the admin and the inline content editor (`?edit=1`). The redesign must keep every one of those levers working.

## Capabilities and Constraints

- **Live truth is not in the HTML.** Prices, sale mode and its label/banner, enabled versions (PDF / pickup / delivery / custom), delivery fee and the free word limit come from `server/settings.js` → `REGISTRY.pricing`, overridden live from `site/admin-pricing.html` and served by `/api/pricing`. Never hardcode a number into a design; never quote one in copy.
- **Live copy is not in the HTML either.** Text and images marked `data-edit` are overridden by the content editor's store. What a visitor sees on production can differ from the repo source (for example the home story signature). Mockups should start from production content, and every `data-edit` key must survive a redesign.
- **Designs (board themes)** are a catalogue managed in the admin; names reach the site via `/api/design-names` and images via `/content-uploads` and `/design-img`. The list changes.
- **Order flow is frozen in behaviour.** `options.html`, `collect.html`, `proof.html`, `pickup.html`, `pay-success.html`, `pay-done.html`, `timer.html` and `wordlists.html` may be restyled only. Flow, fields, logic, IDs and selectors stay; the E2E suite pins them. See `redesign/inventory.md`.
- **Payment** is a card payment iframe (PeleCard in production; Tranzila exists as a second provider on staging). Apple Pay needs a script on our page and per-domain registration; it is not active on the production domain.
- **Free word gate.** A collection may gather a limited number of words before payment, set in the admin.
- **Seed pools.** Short word lists are topped up from seed pools; the buyer chooses which pool. Pools and their names are admin-managed.
- **Dormant features (built, flag-off by default):** colour picking, font choice, live name preview. The redesign must leave room for them, not delete them.
- **Analytics and attribution.** GA, a Meta pixel (when configured) and the site's own ad-attribution tracking run behind a cookie notice. Hooks (`data-ga`, `/api/track`) must survive.
- **Performance.** Storefront images were measured very heavy on production; most visitors are on phones over mobile data.
- **Terminology.** The product is "the game" (המשחק), made of a deck (חפיסה / קלפים) and a board (לוח). The person celebrated is "בעל/ת השמחה". A design is "עיצוב". Words are gathered in "איסוף המילים".

OPEN QUESTION: how many words a buyer should send. The home FAQ says a minimum of 100 and up to 400; `how.html` says a minimum of 70; the brand skill says 100 to 400; the collect page shows its own minimum and ceiling. Which figure is the promise, and should the site state one at all, or only read it from the server?

OPEN QUESTION: the production lead time. The site says "4 business days from sending the words" in several places as fixed copy. Is that a standing promise, or should it become an admin-editable value like prices?

OPEN QUESTION: `how.html` still describes the old model (a PDF the buyer prints herself). Is a print-at-home PDF version coming back (the `pdf` version exists in pricing, currently off), or should that page be rewritten or dropped?

OPEN QUESTION: is the custom-design version (a design made just for the buyer, `custom` in pricing, currently off) part of the redesign's storefront, or out of scope?

## Brand Commitments

These are commitments recorded in the `dugri-brand` skill and project memory. Gate D3 decides whether the visual ones stay, evolve or are replaced; until then they are facts about the incumbent brand, not rules for the redesign.

- **Name and voice.** Hebrew first, addressing the reader in the plural ("אתם", "הזמינו"), which also avoids gendering. Four pillars: straight up, cheeky insider, personal and emotional underneath, party energy. Blunt but never mean about the person celebrated; cheeky but never vulgar; warm but never sappy; confident but never salesy, no fake urgency.
- **Proven phrases:** "בלי פילטרים", "המתנה הכי אישית ומקורית", "בונים את המשחק", "תהנו, צלמו ותייגו אותנו", "שעה וחצי של צחוק".
- **Never** use the name of the commercial word-guessing game this mechanic resembles (a third-party trademark) anywhere customer-facing. Describe the mechanic instead.
- **Logo.** A Y2K chrome-pink wordmark with a lightning bolt. AI-generated, no vector original, raster ceiling about 1145px; traced mono SVGs exist for scale (`resources/brand/`). Signature emoji ⚡.
- **Incumbent visual rules (subject to D3):** near-monochrome site, pink only inside the logo, warm sand accent, sharp corners, thin Heebo Light headings with airy tracking, Assistant body. The deck artwork is the colourful, round-cornered part.
- **Redesign brief (owner, REDESIGN_PLAN.md):** a total change, light only (no dark designs), graphic and eye-catching, "nothing seen before", little text and few photos, things that shift and move, must not look AI-generated. Reference: the SKYLRK collection site.
- **Domain.** dugri-israel.co.il. Links are built from `PUBLIC_BASE_URL`. The old dugri.co.il is dead.

OPEN QUESTION: the owner's name and the founders' story. The live home page signs the story "הדר ועלמה"; the repo source signs it "הצוות של דוגרי"; the runbook names the owner Nevo. Which names may the redesign show?

## Evidence on Hand

- **Real product photos:** hero and gallery images in `site/assets/` (`hero-*.jpg`, `gallery-*.jpg`, `card-*.png`), per-design store images under `site/assets/designs/`, and owner uploads served from `/content-uploads` (production only).
- **Testimonials:** four WhatsApp-message screenshots in `site/assets/testimonials/`, plus whatever the owner has uploaded live. Real, from customers; do not rewrite them or invent more.
- **Counter:** the home page shows a live "celebrations so far" figure (production showed 971 on 2026-10-12; the repo fallback is lower). Treat it as live data, never a fixed claim.
- **Founders' story and photos** on the home page (live content).
- **Pickup directions photos** (`site/assets/pickup-directions.jpg` and live uploads).
- **Short clips** for reels exist locally (`resources/clips/`, not in git).

Absent, and must not be fabricated: star ratings from a review platform, press mentions, customer logos for B2B, order volumes, any claim about delivery coverage beyond what the admin settings state. The five stars shown above the testimonials are decorative, not an aggregate rating.

Privacy: every deck is made of a customer's private jokes and life details. Real customer words, names or deck contents never appear in marketing or mockups without the owner confirming consent. Use obviously fictional examples.

## Product Principles

1. **The words are the product.** Every surface should make it easier to imagine, gather and share the words. A design that shows off the site more than the deck is wrong.
2. **Phone first, WhatsApp-native.** The organiser decides on a phone, and her friends arrive from a WhatsApp link. Every step must work one-handed, in a few minutes, on mobile data.
3. **The owner runs the business from the admin.** Prices, texts, versions and images are hers to change without a deploy. A redesign that hardcodes them takes that away.
4. **Never break an order in flight.** The money and order pages change their look, not their behaviour. Buyers mid-collection must not notice anything but the paint.
5. **Straight talk, in the copy too.** Short, honest, slightly cheeky. No fake urgency, no claims the business cannot back.

## Accessibility & Inclusion

- Hebrew RTL throughout, with mixed-direction content (English deck titles, phone numbers, URLs, prices).
- Plural address to stay gender-neutral toward the reader; the person celebrated may be any gender ("עליו. או עליה.").
- Contributors include older relatives (parents, grandparents) adding words on a phone: readable sizes and obvious controls matter on `collect.html`.
- Respect `prefers-reduced-motion` for any motion the brief asks for.

OPEN QUESTION: no formal accessibility standard (for example WCAG 2.1 AA / Israeli Standard 5568) is recorded in the repo. Israeli law generally expects one for commercial sites; confirm the target level.
