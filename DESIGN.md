---
name: דוגרי
description: A personal party game, sold the way it is played, with real cards on a warm table.
colors:
  ground: '#fff1de'
  ink: '#000000'
  paper: '#ffffff'
  text-muted: '#5c544b'
  accent-yellow: '#ffd37b'
  accent-sky: '#a4e9ff'
  accent-pink: '#ff7aa9'
  brand-pink: '#ea4795'
  field: '#e9f8fd'
  tag: '#fdf2d4'
  card-hot: '#ffe9f0'
  tag-hot: '#c8246a'
  error: '#b3002d'
  whatsapp: '#25d366'
  title-offset-designs: '#5fd0f5'
  title-offset-story: '#f7b32b'
typography:
  display:
    fontFamily: 'Gveret Levin, M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: 'clamp(38px, 11vw, 76px)'
    fontWeight: 400
    lineHeight: 0.98
    letterSpacing: '-0.02em'
  headline:
    fontFamily: 'Gveret Levin, M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: 'clamp(32px, 9vw, 58px)'
    fontWeight: 400
    lineHeight: 1
    letterSpacing: '-0.01em'
  title:
    fontFamily: 'M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: '18px'
    fontWeight: 800
    lineHeight: 1.3
  body:
    fontFamily: 'M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: '17px'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: '15px'
    fontWeight: 700
    lineHeight: 1.2
  button:
    fontFamily: 'M PLUS Rounded 1c, system-ui, sans-serif'
    fontSize: '16px'
    fontWeight: 800
    lineHeight: 1
    letterSpacing: '0.02em'
rounded:
  tag: '3px'
  board: '8px'
  box: '14px'
  review: '16px'
  sheet: '22px'
  panel: '26px'
  feature: '40px'
  feature-lg: '80px'
  card: '6% / 4.26%'
  pill: '999px'
spacing:
  2xs: '4px'
  xs: '8px'
  sm: '12px'
  md: '16px'
  lg: '22px'
  xl: '26px'
  2xl: '32px'
  3xl: '44px'
  4xl: '64px'
components:
  button-primary:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.paper}'
    typography: '{typography.button}'
    rounded: '{rounded.pill}'
    padding: '16px 26px'
  button-primary-large:
    backgroundColor: '{colors.ink}'
    textColor: '{colors.paper}'
    rounded: '{rounded.pill}'
    padding: '19px 30px'
  input:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.pill}'
    padding: '0 22px'
    height: '50px'
  review-card:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.review}'
    padding: '18px'
    width: '272px'
  review-card-hot:
    backgroundColor: '{colors.card-hot}'
  review-tag:
    backgroundColor: '{colors.tag}'
    textColor: '{colors.ink}'
    rounded: '{rounded.tag}'
    padding: '3px 10px 4px'
  hero-panel-sky:
    backgroundColor: '{colors.accent-sky}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '20px 24px 22px'
  hero-panel-pink:
    backgroundColor: '{colors.accent-pink}'
    textColor: '{colors.ink}'
    rounded: '{rounded.panel}'
    padding: '20px 24px 22px'
  whatsapp-fab:
    backgroundColor: '{colors.whatsapp}'
    textColor: '{colors.paper}'
    rounded: '{rounded.pill}'
    size: '56px'
---

# Design System: דוגרי

Written for gate D4 of `REDESIGN_PLAN.md` from what `redesign/directions/r16.html` actually ships (commit 190aa63, the round the owner approved on 2026-10-16), not from intentions. Where the prototype and this file disagree, the prototype is right and this file has a bug. The tokens live in `site/css/redesign-tokens.css`; the `--` names below are from that file.

## Overview

**Creative North Star: "The Game Night Table"**

The site is a warm table with the real game on it. The cards are the printed cards, the boards are the printed boards, and you can pick a card up, throw it and turn it over. Everything around them is a paper cut-out: flat colour, a black outline and a hard black shadow that falls bottom-right, as if a sheet of card were lifted a few millimetres off the table. Nothing glows, nothing is blurred, and nothing is a gradient except the designs panel, which takes on the colour of the design in front of you.

The voice comes from the printed leaflet that ships in the box: the three brand colours (yellow, sky, pink) on a cream ground, black text set on the colours, and any word set _in_ a colour made large and outlined in ink. Headings are hand-lettered (Gveret Levin) with a soft offset in a colour that changes from section to section; everything else is a round, friendly sans (M PLUS Rounded 1c). The density is low on a phone: one idea per screen height, a 16 px gutter, and a single column that becomes two only in the hero and the story from 900 px.

The owner rejected the first round of directions because they looked machine-made. That decision stands: real cards and real photographs only, physical interaction instead of decoration, and wild but immediately understandable.

**Key Characteristics:**

- Real printed cards and boards as the main imagery, handled like objects.
- Cream ground, black ink, three leaflet colours; a design's own colour appears only when that design is in focus.
- Black outlines and hard offset shadows; no blur shadows anywhere.
- Hand-lettered headings with a per-section coloured offset; round sans for everything else.
- Pill-shaped controls; a hand-drawn forward arrow on every forward button.
- Small line illustrations, placed by the owner, moving gently and stopping for reduced motion.

## Colors

A warm cream table, black ink and the leaflet's three colours, with each design's own colour borrowed only while you look at it.

### Primary

- **Black Ink** (`ink`): all text, every outline, every hard shadow and the filled primary button. Ink is the only text colour on every surface; it reads at 8.6:1 or better on every fill used here.
- **Leaflet Pink** (`accent-pink`): the second hero panel, both wave lines, the menu icon's middle line, the offset under "כל המילים עליכם!" and the hero headline's title offset.

### Secondary

- **Sun Yellow** (`accent-yellow`): words set in yellow inside the pink panel and the catch line, always outlined in ink.
- **Sky** (`accent-sky`): the first hero panel (the "what is it" text), sky words in the pink panel (outlined) and the business title's offset.

### Tertiary

- **Logo Pink** (`brand-pink`): the pink of the logo. The required-field asterisk, the sparkle illustrations and the reviews title's offset. It is never used for body text (3.2:1 on the ground).

### Neutral

- **Cream Ground** (`ground`): the page itself, under every section. Sections are not separated by fills or rules; the page just flows.
- **Paper** (`paper`): cards, fields, sheets, the menu's button and the review cards.
- **Sky Field** (`field`): the soft field between the two waves, behind the reviews only. It is sky lifted most of the way to white.
- **Warm Grey** (`text-muted`): review captions and helper notes on paper (7.4:1).
- **Error Red** (`error`): field errors and the invalid field's border (6.4:1 on the ground, 7.1:1 on paper).
- **Tag Cream** (`tag`), **Hot Pink Wash** (`card-hot`) and **Hot Tag** (`tag-hot`, white text 5.4:1): the review card's tag, the one highlighted review card and its tag.
- **WhatsApp Green** (`whatsapp`): the floating WhatsApp button only.

### Per-design colours

Each public design carries one colour sampled from its real card (`--design-<name>`). It is never used flat; it is turned into two derived colours:

- **Flood** (`--design-<name>-flood`): the full-screen colour of the tapped view, the base lifted 62% toward white (toward the ground when the base is near-grey). Ink on every flood is 10:1 or better.
- **Panel** (`--design-<name>-panel`, `-panel-mid`): the designs panel's gradient while that design is centred: the base lifted until black text reads at about 9:1, then 62% further at 48%, then the ground at the bottom, so the panel has no bottom edge. Neighbouring designs cross-fade as the strip moves.

| Design    | Key          | Base      | Flood     |
| --------- | ------------ | --------- | --------- |
| פריז      | bachelorette | `#fc789c` | `#feccd9` |
| קליפורניה | birthday     | `#9ce4fc` | `#d9f5fe` |
| אואזיס    | grapefruit   | `#f07848` | `#f9ccb9` |
| סנטוריני  | marriage     | `#0048a8` | `#9eb9de` |
| דני       | daniel       | `#f5d98f` | `#fbf1d4` |
| טוקיו     | japanese     | `#b03a3a` | `#e1b4b4` |
| סיישל     | posttrip     | `#90d8e4` | `#d5f0f5` |
| האלאנד    | football     | `#2a52be` | `#aebde6` |
| טריפה     | tarifa       | `#3d6b2c` | `#b5c7af` |
| ברוקלין   | kids         | `#1878fc` | `#a7ccfe` |

טוקיו's base is the koi red of its art rather than its near-black frame, so its panel and flood are a pastel red, not grey. A new design gets its colour the same way: sample the dominant colour of its real card, then derive the flood and the panel with the formulas above, never by hand.

### Named Rules

**The Ink-Only Text Rule.** Text is always ink. Brand colours are fills behind text, or large words outlined in ink (`-webkit-text-stroke` 2 px on the catch line, 1.4 px in the pink panel, 1.6 px under 900 px, with `paint-order: stroke fill`). A colour word without its outline fails contrast and is not allowed.

**The Borrowed Colour Rule.** A design's colour appears only while that design is in focus: in the strip's panel and in its tapped view. It never becomes a page accent.

## Typography

**Display Font:** Gveret Levin (falling back to the body font)
**Body Font:** M PLUS Rounded 1c (with system-ui)

**Character:** A hand-lettered Hebrew display face, set in ink with a coloured offset, over a round, soft sans for everything else. The heading looks written; the body stays calm and legible.

**Fonts, exactly as they must load:**

- **Gveret Levin** has one real weight, 400. The heading face covers Hebrew only (`unicode-range: U+0590-05FF, U+200C-2010, U+20AA, U+FB1D-FB4F`), so Latin letters and digits inside a heading come from the body font. The current `fonts.css` also declares a Latin Gveret file; the redesign's heading face must not use it.
- **M PLUS Rounded 1c**, weights 400, 500, 700, 800 and 900, Hebrew and Latin subsets, each `@font-face` with `size-adjust: 109.8%`. That brings its Hebrew letter height to Rubik's at the same font size, measured as the median top of בהכמםסשנ at 100 px in Chromium and WebKit.
- `font-synthesis: none` on everything: a weight the font does not have is never faked.
- Self-hosted under `/assets/fonts/`, never from the Google CDN (`tests/unit/fonts-self-hosted.test.js` enforces it).

### Hierarchy

- **Display** (Gveret 400, `--text-display` clamp(38px, 11vw, 76px), line-height .98, -.02em): the hero headline only, max 12ch, `text-wrap: balance`.
- **Headline** (Gveret 400, `--text-section` clamp(32px, 9vw, 58px), line-height 1, -.01em): section titles. Also the catch line "כל המילים עליכם!" (`--text-catch`, 1.05) and the tapped design's name (`--text-view-title`, 32 px on screens under 760 px tall).
- **Price** (M PLUS 900, `--text-price` clamp(28px, 7.4vw, 38px), line-height 1): the price in the tapped view.
- **Title** (M PLUS 800, 18 px, 1.3; 20 px from 900 px): a review card's quote, in Hebrew quotation marks ״…״. The pink panel uses 800 at 20 px / 1.5, and the menu links 800 at 24 px.
- **Body** (M PLUS 400, 17 px, 1.5): running text, max 40ch in the story and 34ch for a lede. The sky panel is 500 at 17 px / 1.55, with its lead sentence in 800.
- **Label** (M PLUS 700, 15 px, 1.2): field labels and design names. Tags are 600 at 14 px; stickers 700 at 13 px.
- **Button** (M PLUS 800, 16 px, line-height 1, +.02em): every pill; 18 px for the designs button, 14 px in the header.
- **Small** (14 px) for captions and the delivery note; **micro** (13 px) for hints and field errors.

### Named Rules

**The Coloured Offset Rule.** Every Gveret title is ink with a `text-shadow` of `.04em .04em 0` in its section's colour, rotating down the page: hero pink `#ff7aa9`, designs a deepened sky `#5fd0f5`, story a deepened yellow `#f7b32b`, reviews the logo pink `#ea4795`, business sky `#a4e9ff`. A page with one title (the FAQ) takes the first colour, pink. Each colour was checked on the background its title actually sits on; a new section picks the next colour and checks it on its own background.

**The Two Faces Rule.** Gveret is for headings, the catch line, the tapped design's name and the handwritten signature "הדר ועלמה" (30 px), nothing else. Labels, prices, buttons and menus use the body font.

## Layout

Mobile first, one column, on one continuous cream ground.

- **Gutter:** 16 px at every width. From 900 px the content sits in a 1040 px column: `padding-inline: max(16px, 50vw - 520px)` on sections, the header and the footer.
- **Sections:** 44 px top and 52 px bottom padding, no fills, no rules; each clips its own overflow (`overflow: clip`), so nothing scrolls the page sideways.
- **Order:** header, hero, designs, story, wave, reviews (on the sky field), wave, business, footer. The FAQ is its own page (`r16-faq.html`), linked from the menu.
- **Hero:** on a phone the deck stage comes first, full-bleed (100vw), then the text. From 900 px they sit side by side (1fr / 1.1fr, a 64 px gap, centred).
- **Designs:** the one inset panel on the page (16 px from the edges, 20 px from 900 px), with an edge-to-edge horizontal strip inside it that snaps to the centre. From 900 px the strip's ends fade out over 48 px.
- **Story:** title, photos, text and signature in one column; from 900 px the photos and the text sit side by side under the title.
- **Reviews:** a full-bleed row of cards outside the column, with the title in the column.
- **Breakpoints:** 600 px (the form's two-column row), 900 px (desktop). The tapped view also adapts to height: under 760 px the board shrinks, and under 700 px the swipe hint goes and the list tightens.
- **Bottom clearance:** the footer's last links clear the floating buttons (padding-bottom 34 px + 72 px + the safe area).
- **Safe areas:** the header, the sheets, the tapped view and the floating button respect `env(safe-area-inset-*)`.

The spacing in r16 is not on a strict scale. The recurring steps are 4, 8, 12, 16, 22, 26, 32, 44 and 64 px (`--space-*`); new work uses those.

## Elevation & Depth

Depth is physical and flat: a black outline and a hard, unblurred black shadow offset down and to the right, as if the object were a cut-out lifted off the table. There are no blur shadows and no glows. A pressed object moves toward its shadow and the shadow shrinks; a hovered object lifts away from it.

### Shadow Vocabulary

- **Lifted** (`box-shadow: 4px 4px 0 #000`, `--shadow`): printed cards, the deck, the board, the story prints.
- **Low** (`box-shadow: 3px 3px 0 #000`, `--shadow-sm`): FAQ items, the form's thank-you, the WhatsApp button, a pressed deck.
- **Review card** (`6px 7px 0 #000`; hover `8px 9px`, lifting by -2 px; press `3px 4px`, sinking by 3 px).
- **Thrown card:** a 4 px shadow that follows the card's turn; on the card's back it is mirrored (`-4px 4px`), so after the flip it still falls the same way.

### Named Rules

**The One Light Rule.** Every shadow falls bottom-right in solid ink. A shadow that falls another way or is soft is a bug.

## Shapes

Two families of shape: printed objects keep their print shape, and everything you press is a pill.

- **Printed cards** (`--radius-card` 6% / 4.26%): one shape for every card, the shape of the real die-cut corner, with a 1.5 px ink outline drawn as an `outline` with `outline-offset: -.5px`, so it never shifts the image.
- **Card frames are normalised:** the visible frame of every card is 10.78% of its width (taken from סנטוריני and טריפה, left as printed). A card within 9.8 to 12.3% is left as it is; a thinner frame is padded in its own frame colour behind a rounded mask (52 px radius at 400 px), keeping the 400 × 564 ratio. The per-card measurements are in `redesign/directions/cards12/outline-rules.txt`.
- **Pills** (`--radius-pill`): buttons, fields and stickers.
- **Hero panels** (26 px), **review cards** (16 px), **boxes** (14 px: FAQ items, the thank-you, sheet images), **the board** (8 px, 2.5 px outline, turned -2.5°), **tags** (3 px).
- **The designs panel** (40 px, 80 px from 900 px), top corners only: its bottom dissolves into the ground.
- **Sheets** round only their top corners (22 px).
- **Borders:** 1 px on the review card, 1.5 px on cards, fields and stickers, 2.5 px on boards, prints, FAQ items and round ✕ buttons, 3 px on the review sheet.

## Components

### Buttons

Solid, round and confident; a press squashes them.

- **Shape:** a full pill (999 px).
- **Primary:** an ink fill with white 800 type at 16 px and 16 × 26 px padding. The designs button is larger (18 px, 19 × 30 px); the header's "הזמינו עכשיו" is smaller (14 px, 12 × 18 px).
- **The arrow:** every forward button ends with a drawn arrow, not a font glyph, so it looks the same in every font: a 24-unit SVG path `M19 12H5M11 6l-6 6 6 6`, 1.1em square, round caps and joins, `stroke-width: 3.35` to match the 800 type, 8 px from the label. It points left, the reading direction.
- **Press:** `scale(.96)` over 150 ms with `--ease-pop`.
- **Focus:** the global ring, 3 px ink at a 4 px offset.
- **Text link under a button:** 15 px, 500, underlined (for example "יש שאלה? דברו איתנו בוואטסאפ").

### Cards / Containers

- **Printed card:** see Shapes. Cards and boards are always the real artwork the live site serves; the strip shows each design's first front.
- **Hero panels:** sky and pink fills, 26 px corners, 20 × 24 × 22 px padding, max 560 px, no outline and no shadow.
- **Review card (Pluto's card):** white, a 1 px ink line, 16 px corners, a hard `6px 7px` ink shadow, 18 px padding, 272 px wide (360 px from 900 px), at least 176 px tall. A small cream tag at the reading start names the occasion; the quote follows in 800 inside ״…״, and the name and date sit at the bottom in warm grey. One card is "hot": a pink wash with a deep-pink tag in white. Logo cards hold a client logo in its original colours under the tag "לקוח עסקי". A review card opens its screenshot in a bottom sheet.
- **FAQ item:** a white box with a 2.5 px line, 14 px corners and the low shadow; the question in 800 at 17 px, a "+" that turns into "×" when it opens.

### Inputs / Fields

Pluto's form language in ours.

- **Field:** a white pill, 50 px tall, with a 1.5 px ink line, 22 px inside padding and 16 px text (so iOS never zooms in).
- **Label:** above the field, 700 at 15 px, with a logo-pink asterisk on required fields. The asterisk is `aria-hidden`; the field itself carries `required`.
- **Layout:** stacked on a phone. From 600 px, name and company share a row and the phone takes the full width under them; the form is at most 640 px wide.
- **Focus:** a 3 px ink ring at a 2 px offset.
- **Error:** the border turns error red at 2 px, and the message sits under its field, indented to the field's text (13 px). Each field uses `aria-invalid` and `aria-describedby`, and on send the focus goes to the first wrong field.
- **Success:** the form is replaced by a white box with a 1.5 px line, 14 px corners and the low shadow, holding "תודה! נחזור אליכם בקרוב". It has `role="status"` and takes focus.
- **Phone field:** `type="tel"`, `dir="ltr"`, right-aligned. It accepts an Israeli number, 0 then 8–9 digits or the same after +972, ignoring spaces, dashes and brackets.

### Navigation

- **Header:** the menu icon and the logo (86 px) at the reading start, and the "הזמינו עכשיו" pill at the end. No bar, no fill.
- **Menu icon:** three right-aligned lines of 20, 13 and 8 units with round caps, ink, ink-pink-ink, 2.4 stroke, in a 44 px target with no box. Under the pointer or focus, the shorter lines grow to 20 and 14. On open, the sheet's ✕ sits on the icon's exact spot: the outer lines grow and cross, and the pink one shrinks away (340 ms, `--ease-morph`).
- **Menu sheet:** a modal `<dialog>` that slides in from the reading start, `min(86vw, 380px)` wide, on the ground with a 1.5 px ink edge. Links are 800 at 24 px, underlined on hover; a full-width pill closes the list. Tab stays inside, and Esc, ✕ or a tap outside closes it, returning focus to the icon. The page doesn't scroll while it is open.

### Floating WhatsApp button

A 56 px green circle with a 1.5 px ink ring and the low shadow, at the bottom of the end side (bottom left in RTL), clear of the safe area. It hides whenever something sits over the page: the tapped view, the review sheet or the menu.

### The deck (signature)

In the hero, a small deck of real card backs deals real cards onto a pile beside it. Each card is a physical object: it follows the finger exactly, turns about the point you hold, keeps the speed you let go with, and slides to a stop with friction (0.92 per frame sliding, 0.88 spinning). A tap flips it (500 ms, `--ease-flip`). The top back of the deck is always the design it deals next, never the one just dealt; ברוקלין is not dealt. A polite live region announces what was dealt.

### The designs strip and the tapped view (signature)

- **The strip:** endless, with five copies and the middle one real. It leans with your swipe speed on a spring that slightly overshoots, scales and drops the cards away from the centre, and cross-fades the panel to the centred design's colours.
- **The tapped view:** fills the screen from the tap point with that design's flood colour in a growing circle (520 ms, `--ease-reveal`). The board drops in (560 ms, `--ease-land`), the front flies from the strip onto it (640 ms) and the back follows (480 ms). Below them, start-aligned in one column, come the name, the price, "מה בפנים" as four ticked lines, the button "יאללה בואו נתחיל" and "מוכן תוך 4 ימי עסקים".
- **Sharpness:** once the opening animations finish they are cancelled, so the board and cards are never left on a layer rasterised at the starting scale.
- **Fit:** the view fits all ten designs at 390×844, 375×667, 390×700, 360×740, 430×932, 1440×900, 1100×800, 1280×720 and 1024×700.

### The wave divider and the field

- **The line:** two pink lines, 2 px with a non-scaling stroke, each a single smooth S across the full width, `clamp(44px, 8vw, 96px)` tall. The first sits between the story and the reviews; the second, between the reviews and business, has its own curve (it falls first and rises late), so it is not a copy.
- **The field:** each wave is also the edge of the sky field. The field is drawn inside the wave's own box along the same curve, so the colour change sits exactly on the line with no seam. Decorative and `aria-hidden`.
- **Paths:** both use a 1200 × 100 viewBox with `preserveAspectRatio="none"`.

### Illustrations

- **The eight kinds:** hourglass (glass), popper, disco ball, sparkles, and four small marks: a black star, a sky star (`#a4e9ff`), a pink star (`#ea4795`) and a plus.
- **Drawing:** outlines are ink at a 2.2 stroke on a 120 box, with round caps and joins. Fills are soft pastels drawn into the SVGs: yellow `#f7dc72`, lilac `#c9b8ec`, mint `#9ed7bf`, blue `#a8cdee` and coral `#f0866a`, with the logo pink as the accent and a pale `#ece3d5` ground shadow.
- **Placements:** the owner places every item with the `#place` editor. A placement is `[kind, section, x, y, width px, rotation deg]`, kept separately for phone (`m`, under 900 px) and desktop (`d`).
  - x is a percentage of the content column (the screen less its gutters on a phone, the 1040 px column on desktop), from -1 to 101, so an item may sit just past the column's edge; its section clips it and the page never scrolls sideways.
  - y is a percentage of its section.
  - The sections are top, order, recs and story.
- **Behaviour:** illustrations are `aria-hidden`, never take a pointer, and sit under the content.
- **Motion:** each kind has its own gentle loop: the hourglass turns and drains, the popper's confetti rises, the ball sways and its glints twinkle, the sparkles and stars twinkle, each on a 3 to 10 s cycle with offset delays. Under reduced motion every loop is paused.

## Do's and Don'ts

### Do:

- **Do** use the real printed artwork the live site serves for every card and board, with the 6% / 4.26% corner, the 1.5 px outline and the 10.78% frame.
- **Do** set all text in ink, and outline any word set in a brand colour in ink.
- **Do** give every Gveret title its section's offset colour at .04em, and check it on the background it actually sits on.
- **Do** end every forward button with the drawn arrow, pointing left.
- **Do** keep every shadow a hard ink offset falling bottom-right.
- **Do** keep 44 px tap targets, 16 px input text and the 16 px gutter.
- **Do** derive a new design's flood and panel from its sampled colour with the formulas in Colors.

### Don't:

- **Don't** make anything that looks machine-made: no generated imagery, no stock, no glass, no glow, no gradient text, and no blur shadows.
- **Don't** use a design's colour outside its strip panel and its tapped view.
- **Don't** set body text, labels or prices in Gveret, or headings in the body font.
- **Don't** separate sections with fills or rules; the waves are the only dividers, and only around the reviews.
- **Don't** use a font glyph (›, ‹, ←) for a forward arrow inside a button.
- **Don't** let anything scroll the page sideways; clip overflow at the section.
- **Don't** name the game mechanic after a trademarked game ("אליאס") anywhere a customer can see.

## Motion

- **Physical first:** motion comes from handling objects (dealing, throwing, flipping, flooding a colour from the tap point), not from scroll-triggered entrances. Nothing animates in just because it was scrolled to.
- **Curves:** springy curves that overshoot slightly for arrivals and presses (`--ease-pop`, `--ease-flip`, `--ease-land`, `--ease-sheet`, `--ease-morph`); a quick accelerating curve for anything leaving (`--ease-exit`).
- **Durations:** 150 ms for a press, 280–360 ms for sheets and the menu, 500–640 ms for the flip and the tapped view.
- **The marquee:** the review row drifts toward the reading direction at 30 px a second, endlessly (three copies). It stops while a mouse is over it, from the first touch until 1.8 s after the last finger lifts, while a keyboard user is on a card, while it is off screen or the tab is hidden, and while the review sheet is open. It can be swiped, or dragged with a mouse, and a drag never counts as a tap.
- **Story prints:** they drift by a pixel or two over 15 and 19 s.

## Accessibility

- **Contrast:** WCAG AA. Ink text is 8.6:1 or better on every fill in use.
  - Coloured words rely on their ink outline; the detector's accepted low-contrast findings are exactly these.
  - Error red is 6.4:1 on the ground; the warm grey is 7.4:1 on paper.
- **Focus:** `:focus-visible` everywhere, 3 px ink at a 4 px offset (2 px on fields, 10 px around the deck).
  - The menu and the review sheet are modal `<dialog>`s: they keep focus inside, close on Esc and return focus to what opened them.
  - The tapped view moves focus to its ✕, closes on Esc and returns focus, but it is a `div` with `role="dialog"` and does not yet keep Tab inside (open item 8).
  - The strip's copies are `aria-hidden` and out of the tab order; only the real copy is focusable.
- **Reduced motion:**
  - No smooth scroll, and the menu morph and slide are cut.
  - The tapped view, the review sheet and dealt cards fade instead of moving (200–240 ms).
  - A card flip becomes a crossfade, and the strip becomes a static three-column grid on the panel's own colour, with no lean and no colour morph.
  - The marquee and the story prints stand still, and every illustration is paused.
- **Semantics:**
  - Every section is labelled by its title, and decorative SVGs are `aria-hidden` and `focusable="false"`.
  - Form errors are tied to their fields, and the thank-you is a `status`.
  - Placeholders and tokens are isolated (`unicode-bidi: isolate`).

## RTL

- The page is `dir="rtl"`. Use logical properties (`inset-inline-*`, `margin-inline-start`, `padding-inline`, `border-end-*-radius`), never left/right, except where a physical side is the point (the shadow falls bottom-right in both directions).
- Forward is left. The drawn arrow points left, and forward CTAs never use a font arrow, which the browser may mirror or not depending on the page.
- Horizontal scrollers (the strip, the review row) are `direction: ltr` boxes with RTL content inside, so their scroll positions behave the same in every engine; the row drifts right to left.
- A left-to-right run inside Hebrew (a phone number, a price token, Latin in a heading) is isolated: wrap it in U+2066 … U+2069 (LRI … PDI) or `unicode-bidi: isolate` with `dir="ltr"`. Non-breaking hyphens (U+2011) are bidi-neutral and reorder without the isolate: r15 shipped "4567-123-054" that way.
- Check every RTL change in a screenshot of the real page in both Chromium and WebKit, not in a toy page.

## Content

- **Copy:** the owner's copy is used verbatim, in her words and her punctuation; the hero text is the live site's "מה זה דוגרי?" (`index-about-body`) whole.
- **No "אליאס":** never in any customer-facing material.
- **Live values:** `{price}` and `{delivery_fee}` come from the admin's pricing (`server/settings.js` → `REGISTRY.pricing`, overridden live), never typed into a page. The same goes for the design names (`/api/design-names`), the public designs (`/api/custom-designs`) and their art.
- **Owner-editable text:** text the owner may want to change carries a content-editor `data-edit` key, as the review captions already do (`index-review-N-caption`).
- **Links:** built from `PUBLIC_BASE_URL`, never a typed domain.
- **Privacy:** the founders' photos are real people and the repo is public: any committed screenshot blurs them from the first frame.

## Open items

1. **Illustrations that still touch text.** The owner's final placements are pending. On r16's layout these overlap:
   - **Phone:**
     - the popper on the designs subtitle;
     - the cross on the designs button;
     - the hourglass over the story photos;
     - the pink star on "איך דוגרי נולד";
     - a black star on "ועלמה";
     - the sky star on the second story paragraph;
     - a black star on the sky panel's edge (390 px only);
     - the sky star in the designs grid (reduced motion only).
   - **Desktop:**
     - the sparkles at the end of the headline;
     - the sky star on "ומה הקאץ'?";
     - the cross on the designs button;
     - the pink star on "איך דוגרי נולד".

   Positions and the editor are in `README-r16.md`.

2. **The form's endpoint.** The prototype has no backend; a valid send only shows the thank-you. The live form needs a server route that takes name, company and phone and emails the owner, optionally with a row in the admin (Agent A or D builds it). Until it exists the form must not go live, or leads are lost.
3. **Live-data wiring:**
   - the price (`{price}`, and `{delivery_fee}` wherever delivery is mentioned) from the pricing settings;
   - the designs, names and art from `/api/design-names`, `/api/custom-designs` and the template images, instead of the prototype's fixed list of ten;
   - the FAQ from its live source;
   - `data-edit` keys on every owner-editable text block (the hero text, the story, the business text, the FAQ), not only the review captions.
4. **האלאנד's flat frame.** Its fronts were padded to the 10.78% frame in flat blue, because its footballs sit behind the card panel and are cut by the red line on the sheet. A clean frame needs a re-render from its Canva file.
5. **Fonts self-hosted.** M PLUS Rounded 1c (400, 500, 700, 800, 900; Hebrew and Latin) is loaded from the Google CDN in the prototype. It must move to `/assets/fonts/` with `size-adjust: 109.8%`, plus a Hebrew-only Gveret face.
6. **Testing switch.** `#fields` (sky / yellow / off) must go; the sky field is the choice.
7. **Tokens file.** `site/css/redesign-tokens.css` is not linked yet. It replaces `tokens.css` when the pages move to the redesign, because `tokens.css` still styles the 20 live pages and their tests pin its values.
8. **The tapped view's focus.** Make it a modal `<dialog>` (or make the page behind it `inert`), so Tab stays inside, like the menu.
