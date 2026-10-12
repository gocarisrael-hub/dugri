# Phase 2: three homepage directions (gate D2)

**Design read (taste-skill):** Reading this as: a full-overhaul redesign of a Hebrew, RTL, phone-first gift storefront for women organising a party about one person, with a bold, playful collection-site language (SKYLRK), leaning toward native CSS and vanilla JS with kinetic type, the card and the board as the graphic system, light only.

**Dials:** `DESIGN_VARIANCE: 9` · `MOTION_INTENSITY: 8` · `VISUAL_DENSITY: 2`

Overrides of the skill's defaults, from the brief: light only (no dark mode, the owner's rule), static self-contained HTML instead of React/Tailwind (no production code in this phase), Google Fonts linked for the mockups only (production self-hosts fonts; `tests/e2e/fonts-self-hosted.spec.js`).

Files: `a.html`, `b.html`, `c.html` (open locally; images load from `../../site/assets/`). Screenshots in `shots/`: `{a,b,c}-{390,1440}.png` (full page, every reveal settled), `{a,b,c}-{390,1440}-fold.png` (first viewport), `compare-390.png` (folds side by side, left to right: A, B, C) and `compare-1440.png` (folds stacked, top to bottom: A, B, C).

Shared across all three: the owner's homepage lead (both occasions equally, as "a party about one person": a bachelorette and a parent's or grandparent's birthday). Every page has the hero with one order CTA, a very short how-it-works, the two occasions, the designs, a social-proof slot (live counter plus the real WhatsApp testimonial screenshots), a three-question FAQ teaser and a footer with the green WhatsApp button. Live values are shown as yellow dashed tokens: `{price}`, `{lead_days}`, `{orders_count}`. Word counts follow D1: up to 412, at least 70 recommended. Every example word on a card or chip is fictional. All motion is transform and opacity only, and `prefers-reduced-motion` turns it off.

## A: "Soft" (soft-skill)

Soft Structuralism on a silver-grey ground, heavy Rubik, one accent taken from the logo's pink, everything in nested "double-bezel" frames, pill buttons with the arrow in its own circle, a floating glass pill for the nav, the real cards fanned in a Z-axis cascade.
Why it sells: it looks expensive and gift-like without being cold, and the pink ties straight to the logo, so a buyer arriving from Instagram recognises the brand at once while the page feels like a premium product site.

Motion:

- Hero: the three real cards rise in with a stagger, then drift slowly up and down; on desktop they follow the pointer at different depths (parallax).
- Every block fades up 56px on entering the viewport (IntersectionObserver, a long spring curve `cubic-bezier(.32,.72,0,1)`).
- The CTA's arrow circle nudges forward on hover; the button presses to 0.98 on tap.
- Mobile menu: the two-line burger morphs into an X and the full-screen glass menu's links slide up one after another.
- Designs rail: cards lift and tilt a degree on hover; FAQ `+` turns into `×`.

## B: "Quiet" (minimalist-skill)

Warm monochrome editorial: Frank Ruhl Libre serif headlines against Heebo, 1px hairlines, a flat asymmetric bento, two muted pastels (pale pink for bachelorettes, pale blue for birthdays), sharp 4px buttons. The headline is the idea: "המתנה היא המילים."
Why it sells: it is the direct evolution of today's black-and-white, sharp-cornered, Heebo brand, calm and trustworthy for the parents-and-grandparents buyer, while the hero card makes the words themselves the product.

Motion:

- Hero card: the word on the top card changes every 2.4s (out up, in from below), with the card bobbing gently; it shows the game's turn rather than describing it.
- Blocks enter with a 12px fade-up and an 80ms stagger per item (`cubic-bezier(.16,1,.3,1)`).
- One very slow pale-pink light (26s) drifts behind the page on a fixed, non-interactive layer.
- Hover: design and occasion photos zoom 4 to 5% inside their frames; the CTA arrow slides forward.

## C: "The board" (original, taste-skill only)

The page is the game: poster-scale Karantina type ("מסיבה / על אדם / אחד."), cobalt as the single accent, hard black outlines and offset shadows like a printed sticker sheet, the board's numbered circles as the how-it-works path, a live card in the hero with a 60-second clock, and a pawn that walks the path.
Why it sells: it is the closest to the SKYLRK collection-site energy and to "nothing seen before"; in one glance it explains the mechanic (describe the word, beat the clock) and makes the product look like a party, which is what both a bride's friends and a grandchild are buying.

Motion:

- Hero: the headline lines rise in with a slight overshoot, then the card is "dealt" in from the corner with a spin; its word changes every 2.2s and the blue clock bar runs down over 60s.
- One tilted cobalt marquee carries the rules: "מתחלקים לקבוצות · מתארים בלי להגיד · 60 שניות".
- How it works: a pawn walks the dashed board path as the section scrolls past (CSS scroll-driven `animation-timeline: view()`; static where unsupported).
- Occasion posters and collection cards pop on hover (overshoot curve), straighten their tilt and lift off their offset shadow; buttons press flat into their shadow on tap.

