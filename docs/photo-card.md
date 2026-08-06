# The photo card

The deck's 104th front is the **photo card** — one portrait card carrying the buyer's four
pawn photos (the images collected by the wizard's optional photo step and stored on the
collection as `pawn_images`, max 4). This document is the contract between the card artwork
(Agent B) and the generator that fills it (Agent C).

## For Agent C — the cutout contract in one place

Read this section before changing anything on the generator side. **Where a rendered image
disagrees with the numbers below, this document is the contract to reconcile against** — the
artwork is authored to it, and the four slots are byte-identical on every photo card so the
generator never branches on which template it loaded.

1. **A photo NEVER prints as a rectangle.** The card no longer draws a white disc behind the
   photo; the white sticker outline is generated **from the image's own alpha**. So the generator
   guarantees every image reaching a slot HAS a round alpha: `square_photo()` multiplies the disc
   into the alpha unconditionally, cutout or not. A photo whose background could not be removed
   still comes out cropped, fitted to the circle, clipped round and ringed in white like every
   other pawn.

   **This reverses the earlier rule and the reversal is deliberate — do not restore it.** The
   degraded path used to fall through unclipped on purpose, so a failed cut printed as an obvious
   white-edged rectangle ("no graceful degradation by design"). The owner has seen that rendered
   and rejected it: every slot is round, always.

   The trade the reversal makes, stated plainly: an uncut photo is now a round photo **with its
   background still inside the circle**. Far less jarring than a rectangle — but it also no longer
   announces itself as a failure. **The record is what catches it now**, not the card: the
   collection keeps `pawn_cutouts[<original path>] = null` for every photo where the cut was
   attempted and failed, the admin surfaces it, and the owner cuts that one by hand. If you touch
   the cutout pipeline, keep that null.

   A cutout is still what you WANT on every photo: without one the disc is the whole of the alpha,
   so the halo is a plain ring rather than the subject's silhouette, and the framing falls back to
   a guess (point 5).

   **Where the cutout comes from.** It is produced in the BUYER'S BROWSER at upload time, not
   on the server and not at generate time — `site/js/pawn-cutout.js` runs MediaPipe's
   ImageSegmenter over the self-hosted `selfie_multiclass_256x256` model (both Apache-2.0,
   vendored under `site/vendor/mediapipe`, no CDN and no third-party API). The collection then
   keeps BOTH files: `pawn_images` is always the untouched ORIGINAL, and `pawn_cutouts` maps
   each original's path to its cutout path — or to `null` when a cut was attempted and failed,
   which the admin orders table flags in red. `pawnPhotoFiles()` hands the generator the cutout
   when there is one and the original otherwise, so the generator itself never knows the
   difference and never makes a network call. A browser too old to segment simply produces no
   cutout: the original still prints round and ringed like every other pawn, background and all
   (point 1), and the owner cuts it by hand off the `null` in the record.

2. **Alpha must survive the generator's own photo prep.** `square_photo()` works in `RGBA`
   throughout and saves `RGBA` — `convert("RGB")` anywhere in that function flattens the alpha
   away and every customer photo reaches the slot opaque, whatever was done upstream. It is also
   the alpha the crop itself is computed from now (see "How the generator frames a photo"), so
   losing it costs the framing as well as the silhouette. The shipped fallbacks are not squared,
   so they already arrive transparent.
3. **Four slots, filled by setting ONE attribute.** Each is an `<image>` with an id, explicit
   `x`/`y`/`width`/`height` and **no `href`**. Set `href` (plus `xlink:href`) to a `data:` URI and
   touch nothing else. Ids: `photo-slot-1`, `photo-slot-2`, `photo-slot-3`, `photo-slot-4`. The
   halo is drawn by a `<use>` of that same element, so filling the one slot feeds both.
4. **Render it square, RGBA PNG, 512 × 512 px.** Floor 220 px (300 DPI over the slot's 18.57 mm);
   ceiling 768 px. The ceiling is not cosmetic: `generator/deck_html.py` hoists any `<image>`
   whose base64 payload passes `BG_MIN_CHARS` (1,000,000 chars) into shared defs and replaces the
   element with a `<use>` — that would take `#photo-slot-N` out of the document and orphan the
   halo. **Keep the encoded payload under 1,000,000 base64 characters.** A 512 × 512 RGBA cutout
   lands around a third of that.
5. **The image arrives already round — the generator clips it, the artwork does not.** This
   reverses the earlier "nothing is clipped, the subject may spill past the cut-line" rule. That
   rule assumed the cutout's alpha was the subject's silhouette; it was not. The generator used
   to crop a fixed square out of the photo, which sliced through arms and legs, and since the
   halo is dilated from the image's OWN alpha it traced that ruler-straight cut instead of the
   person. `generator/build.py` → `square_photo()` now frames on the subject's alpha and clips
   the result to a disc, so the slot receives a round RGBA PNG and the artwork needs no
   `clip-path` of its own. **Do not add one** — a clip in the artwork would apply to the halo
   `<use>` as well and shave the white outline off.

   The clip is unconditional; only the FRAMING degrades. With no alpha there is no subject box to
   measure, so the head-anchored guess (`PHOTO_SUBJECT_Y`, 0.30 of the height) picks the square
   and the disc is cut out of that — which is the one place that constant still earns its keep,
   because it decides which part of the person the circle keeps. No face detector: the guess is
   cheap and this is the degraded path, not the normal one.

   The disc fills **0.90** of the square (`PHOTO_DISC_FILL`), not all of it. That margin is
   load-bearing: the halo dilates ~2.4 units outward, and a disc filling the whole square would
   put the white ring exactly on the dashed cut-line at r = 33 — hiding the line you are meant to
   cut, and putting the ring outside the cut so it is trimmed off the finished pawn. At 0.90 the
   ring lands just inside the dashes.

   Where the subject does not reach the disc's edge the halo still follows its silhouette, so a
   card is a mix of full discs and silhouettes. That is correct, not a defect: the clip is a
   ceiling on how far the sticker may reach, not a shape imposed on every photo.

6. **The slot contains, it does not crop.** `preserveAspectRatio="xMidYMid meet"` — a non-square
   cutout is scaled to fit and centred, so a tall cutout keeps its head.
7. **Empty is a valid state.** A slot left without an `href` renders as the dotted cut-line
   alone — never a broken image. Filling only some slots is fine.
8. **There are no slot numbers.** The photo is the identity; the numbered chips are gone. Do not
   reintroduce per-slot labelling.

| what                  | value                                                     |
| --------------------- | --------------------------------------------------------- |
| slot box              | 66 × 66 units (18.57 × 18.57 mm)                          |
| cut-line              | dashed circle, r = 33 units, centred in the slot box      |
| white halo            | ≈ 2.4 units (0.68 mm), follows the image's alpha          |
| cutout format         | **transparent RGBA PNG** — required, alpha must be intact |
| cutout size           | 512 × 512 px target (min 220 = 300 DPI, max 768)          |
| payload cap           | < 1,000,000 base64 chars (`deck_html.BG_MIN_CHARS`)       |
| clipping              | in the IMAGE — a disc of 0.90 × the square, always        |
| `preserveAspectRatio` | `xMidYMid meet` (contain — never crops)                   |

## How the generator frames a photo

`generator/build.py` → `square_photo()`, one photo in, one square RGBA PNG out. There is no
guess about where the head is anywhere in it: with a cutout, the alpha says where the person is.

1. **Find the subject** — `subject_box()`. The bounding box of every pixel at or above
   `PHOTO_ALPHA_MIN` (24, low on purpose: a hair matte fades to zero over a few pixels and all of
   it is subject). If the cut left more than one blob, the one whose centre of mass is **nearest
   the centre of the frame** wins, and the others are erased from the alpha — not the biggest,
   because a bystander standing behind the honoree is easily the larger of the two. Blobs under
   `PHOTO_BLOB_MIN_SHARE` (8%) of the biggest are dropped as specks before that choice, so a
   20-pixel scrap at dead centre cannot beat a person. The blob walk runs on a 200 px mask —
   numpy is test-only here, the production image ships `py3-pillow` and nothing else.
2. **Frame it** — `subject_window()`. A square window sized on the subject's **width**, so a wide
   subject is never cropped left or right; we know where the top of a person is, we have no such
   handle on which side of them matters. Vertically, a subject shorter than the disc is centred
   and a taller one is pinned near the top with `PHOTO_SUBJECT_HEADROOM` (11%) of air above it,
   the rest running out of the bottom of the circle — which is usually the photo's own edge, i.e.
   exactly the straight cut we are getting rid of. Past `PHOTO_SUBJECT_MAX_ASPECT` (2:1 wide) the
   sides are allowed to go rather than shrink the subject to a sliver. The window may fall outside
   the photo; cropping past the edge pads with transparency, which is what a sticker wants.
3. **Clip it** — a disc of `PHOTO_DISC_FILL` × the square, anti-aliased, multiplied into the
   alpha. **Unconditional**: steps 1 and 2 can fail, step 3 never runs a different way.

**No usable alpha is a supported state**, not an error: an opaque photo, or a cut that collapsed.
`subject_box()` returns `None`, so steps 1 and 2 are replaced by the head-anchored square crop —
portrait: a square of the short side, centred on `PHOTO_SUBJECT_Y` (0.30) of the height and
clamped inside the photo; landscape: the full height, centred left-to-right. Step 3 runs exactly
as it does on a cutout, so the slot still receives a round PNG and the halo still renders as a
white ring (verified on a real grapefruit render, not assumed: the `#sticker-halo` filter dilates
`SourceAlpha`, and a disc-masked photo has a disc alpha, so the ring follows for free).

What that costs, since it is no longer visible on the card: the circle is full of the photo's
original background, and it is a guess rather than a measurement, so a subject standing off to one
side or low in the frame can be badly framed. Point 1 covers how the miss is recorded instead.

## Geometry

Same as every other card in the new deck:

| property     | value                          |
| ------------ | ------------------------------ |
| `viewBox`    | `0 0 223.92 312` (portrait)    |
| physical     | 63 × 88 mm — 1 unit ≈ 0.281 mm |
| slot size    | 66 × 66 units                  |
| slot spacing | 12 units between slots, 2 × 2  |

The four slots are numbered left-to-right, top-to-bottom, and their geometry is **identical on
every photo card** — so the generator never has to branch on which template it loaded:

| id             | x      | y   | width | height | cut-line centre | cut-line r |
| -------------- | ------ | --- | ----- | ------ | --------------- | ---------- |
| `photo-slot-1` | 39.93  | 87  | 66    | 66     | 72.93, 120      | 33         |
| `photo-slot-2` | 117.93 | 87  | 66    | 66     | 150.93, 120     | 33         |
| `photo-slot-3` | 39.93  | 165 | 66    | 66     | 72.93, 198      | 33         |
| `photo-slot-4` | 117.93 | 165 | 66    | 66     | 150.93, 198     | 33         |

The values above are documentation, not an API: **read `x`/`y`/`width`/`height` off the element**
rather than hardcoding them, so a theme is free to ship a different layout later.

## The frame — measured off the template's own front card

The owner's words: "the card with the pawns should be exactly same size and roundness as the rest
of the cards in this template." Two separate promises, and they are kept in two different places.

**Outer size is kept by the viewBox, and was never the problem.** Every card in a v2 deck is drawn
on `0 0 223.92 312`; `deck_html.DeckDocument` inlines each design into one shared page box and the
printed page is that viewBox in points, so a card's own `width`/`height` attributes never reach the
PDF. Nothing may change that — these cards are printed and cut in a stack, and a pawn card of
another size is a mismatched card whatever it looks like. `generator/test_card_frame.py` pins it.

**Roundness is the frame**, the rounded outline every one of these designs draws just inside the
card, which is the shape a buyer reads as "the card". The shared generic pawn card drew a
SHARP-cornered rectangle at grapefruit's frame box on every deck. Measured off the shipped
artwork, the real frames are:

| template                 | frame box (x, y, w × h)       | radius | stroke          |
| ------------------------ | ----------------------------- | ------ | --------------- |
| grapefruit               | 24.34, 22.44, 175.18 × 266.93 | 7.50   | 1.50 `#711d20`  |
| bachelorette             | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 3.46 `#6b4d56`  |
| birthday-girls           | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 12.10 `#ff7aa9` |
| birthday-boys-basketball | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 12.10 `#e9062a` |
| anniversary              | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 3.46 `#004aad`  |
| japanese                 | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 5.18 `#d42a2a`  |
| trip comeback            | −0.71, 0.12, 224.34 × 312.12  | 31.35  | 10.37 `#7dac9b` |
| football-boys            | −3.92, −3.78, 231.64 × 319.50 | 32.09  | 7.11 `#e90f0f`  |

(The seven sheet-format rows are read off each design's first card and expressed in card units;
the six that share a radius are cut from one Canva master.)

**Two radii over eight designs is why this is not drawn into the file.** One shared `photo.svg`
serves every template that ships no `clean/photo.svg` of its own, and it cannot be 7.5 and 31.35 at
once. So the geometry is applied at COMPOSITION time, per deck: `generator/card_frame.py` reads the
frame off the deck's own front card and `render_page.photo_card_svg` redraws the pawn card's frame
as that one — box, corner radius, stroke width and stroke colour, all four, because a black
hairline at a 12-unit pink band's centreline is neither the same size nor recognisably the same
card. The artwork only has to say WHICH element is its frame:

```xml
<rect class="card-frame" x="24.34" y="22.44" width="175.18" height="266.93" rx="0" ry="0"
      fill="none" stroke="#111111" stroke-width="1"/>
<path class="card-frame-rule" d="M24.34 78.44H199.52" .../>
```

`card-frame` is the frame; `card-frame-rule` is anything anchored to it (the generic card's rule
under the heading), re-spanned across the new frame at its own height. The card's own `fill` does
NOT move — grapefruit fills its frame with the paper and the generic card leaves it open, and that
is each card's decision. `card_paper` owns colour of paper; `card_frame` owns shape of frame.

**It is read off the vector, not a render** — unlike the paper, this needs no browser. A frame is a
stroked outline (`fill="none"` plus a `stroke`) spanning most of the card: the same test
`render_page.frame_box` uses for word layout, and the same transform-resolving reader, reused
rather than rewritten. Two deliberate differences: this answers with the stroke's CENTRELINE (the
pawn card has to redraw that stroke, not sit inside it), and it does NOT require the frame to be
inset from the card edge, because six of the eight designs draw theirs flush with the trim and
rejecting those would no-op the fix on exactly the templates that need it. A full-bleed FILLED rect
is still never mistaken for a frame — it has no stroke.

**The path reader is the one genuinely new piece, and the radius is why.** Canva writes a rounded
corner as a cubic, and a cubic's first control point sits on the same horizontal as the corner's
on-curve point, 0.4477 × r along the top edge. Reading every number in `d` as a coordinate pair
therefore reports grapefruit's radius as **3.36 instead of 7.50**. `card_frame._on_curve` walks the
path commands and keeps only the points the curve passes through.

**Everything degrades to "leave the card exactly as it shipped":** a template with no measurable
frame, a pawn card that marks none, or a frame whose interior would not contain the card's own
pawns and copy — a border drawn THROUGH the pawn grid is worse than one that merely does not match.
A v1 (8-up sheet) template answers None and correctly so: it has no numbered cards, and the v2 deck
is the only thing that prints a pawn card at all.

The check that matters: grapefruit's pawn card was authored BY HAND to match its deck, and
measuring that deck and redrawing from the measurement reproduces it **byte for byte**. That is the
strongest evidence available that the measurement is right, and `test_card_frame.py` pins it.

What still differs, stated plainly: outside the frame, a pawn card shows its deck's PAPER colour
where a word card shows that design's outer bleed (grapefruit's stripes, bachelorette's cream).
Matching that too means copying the front's whole background, which is a redesign of the shared
card rather than a question of size and roundness.

## The sticker

Each slot is a **die-cut sticker**: a white outline dilated from the image's own alpha, over a
dashed circle that marks where to cut. Since the generator hands the slot a disc-clipped image
(point 5 above), that outline reads as a white ring wherever the subject fills the disc and as
the subject's silhouette wherever it does not — and it always lands INSIDE the dashes. Per slot,
in paint order:

```xml
<g class="photo-sticker" data-slot="1">
  <circle class="cut-line" cx="72.93" cy="120" r="33" fill="none"
          stroke="#111111" stroke-opacity="0.45" stroke-width="0.6" stroke-dasharray="2 2.4"/>
  <use href="#photo-slot-1" xlink:href="#photo-slot-1" filter="url(#sticker-halo)"/>
  <image id="photo-slot-1" x="39.93" y="87" width="66" height="66"
         preserveAspectRatio="xMidYMid meet"/>
</g>
```

- **The cut-line goes first, underneath.** The halo covers it wherever the subject reaches it,
  exactly as a real die-cut sticker hides its own cut line, and the dashes stay visible in the
  gaps. There is no fill: the card's own background shows through everywhere the subject and its
  halo do not cover.
- **The halo is a `<use>` of the slot, not a second image.** The generator still fills exactly
  one element; the `<use>` picks the cutout up for free (a forward reference to an element later
  in the document is valid SVG, and `deck_html.namespace_ids` rewrites the id, the `<use>` href
  and the filter reference together).
- **Only the halo copy is filtered.** The photo on top is unfiltered, so it is never rasterised
  through the filter pipeline and stays full resolution in the printed PDF. Verified at 600 dpi
  off a `--print-to-pdf` render.
- **`#sticker-halo`** dilates `SourceAlpha`, blurs it and pushes it back through a steep alpha
  ramp — the blur-and-threshold step rounds off `feMorphology`'s square structuring element,
  which on its own leaves visibly boxy corners — then floods it white and drops a soft shadow:

  ```xml
  <filter id="sticker-halo" x="-25%" y="-25%" width="150%" height="150%"
          color-interpolation-filters="sRGB">
    <feMorphology in="SourceAlpha" operator="dilate" radius="2.4" result="spread"/>
    <feGaussianBlur in="spread" stdDeviation="0.6" result="soft"/>
    <feComponentTransfer in="soft" result="mask">
      <feFuncA type="linear" slope="14" intercept="-3.5"/>
    </feComponentTransfer>
    <feFlood flood-color="#ffffff" result="white"/>
    <feComposite in="white" in2="mask" operator="in" result="halo"/>
    <feDropShadow in="halo" dx="0" dy="0.7" stdDeviation="0.9"
                  flood-color="#111111" flood-opacity="0.30"/>
  </filter>
  ```

A theme may re-tint the cut-line and the shadow (grapefruit uses its maroon), but the **halo
stays `#ffffff`** — that is what makes the sticker read on a patterned card.

The cards carry **no font dependency**: every piece of static copy is already baked to vector
paths. Rendering one needs no `@font-face` injection, unlike `clean/fronts.svg`.

## The paper — measured off the template's front card

The pawn card ships inside the buyer's deck, so it is printed on **that template's own front-card
paper**, not on white and not on one colour for every template. `generator/card_paper.py` measures
it and `render_page.photo_card_svg` applies it; both the deck and the single-card preview compose
the card through that one helper, so they cannot drift.

**It is measured, not read out of the vector, and grapefruit is why.** Its `clean/2.svg` opens with
two full-bleed paths, `#ffffff` then `#f4f1eb`, and neither is the paper: a rounded panel covers
~78% of the card in `#fffdf1`. "Take the fill of the full-bleed rect" answers `#f4f1eb`; the card a
buyer holds is `#fffdf1`. So the front is rendered once and the paper is **the mode of its pixels**
— the same question `calibrate._background` asks ("the mode of the un-inked pixels"), and a
`clean/` card is un-inked by definition, so the whole card is the crop.

Measured across the shipped templates (the row for the since-retired
`birthday-girls-neon` is dropped):

| template                 | front paper | share |
| ------------------------ | ----------- | ----- |
| trip comeback            | `#d0e4d7`   | 71.7% |
| bachelorette             | `#ffc6d7`   | 78.4% |
| birthday-girls           | `#fff1de`   | 72.5% |
| birthday-boys-basketball | `#ffffff`   | 73.3% |
| anniversary              | `#f4f1eb`   | 92.8% |
| japanese                 | `#fdfcf7`   | 77.9% |
| football-boys            | `#a4e9ff`   | 75.8% |
| grapefruit               | `#fffdf1`   | 73.5% |

**A front with no paper answers nothing.** A photographic or continuous-tone front has no colour
holding a large share of the card, so its mode is just the luckiest pixel. `PAPER_MIN_SHARE` (0.25
— far below every row above) is the line: under it, and on any Chrome failure, `front_paper`
returns `None` and the pawn card **keeps the background it was drawn with**. An unmeasurable colour
must never cost a customer their deck, and an arbitrary sampled pixel is worse than white.

Repapering moves **every element painted in the card's own paper colour**, not only the full-bleed
rectangle. Grapefruit's pawn card paints its paper twice — the full-bleed base, and again as the
rounded panel the pawns actually sit on — and repainting only the base would change a colour that
is hidden under the stripes and the fruit, i.e. produce a diff that renders identically. Only
`fill` attributes move; `flood-color` is left alone, because the halo is `#ffffff` by contract and
on the generic card that is also the paper.

A v1 (8-up sheet) template has no numbered fronts; `clean/fronts.svg` carries the same eight cards
on one sheet and the cards cover enough of it that the mode is still the card paper rather than the
gutter. That is not tidiness — v1 is what the owner's store is being migrated FROM, and a
half-migrated template must not answer "no paper".

## The static copy — outlines, with the words kept in the markup

Two lines print on every pawn card: a heading (`החיילים שלכם`) and a caption
(`גזרו אותם לפי הקווים`). They are **outlined paths**, which is what makes the "no font dependency"
rule above true. The cost is that the words are not editable by hand, so each copy path carries the
sentence it draws — and how it is set — as attributes:

```xml
<path data-copy="גזרו אותם לפי הקווים"
      data-font="site/assets/fonts/heebo-300-hebrew.*.woff2"
      data-size="7" data-track="0.3" data-baseline="70" data-cx="111.96"
      d="…" fill="#111111" fill-opacity="0.6"/>
```

`scripts/set_photo_card_copy.py` regenerates `d` from `data-copy`: **edit the words in the SVG, run
the script, commit.** `--check` rewrites nothing and fails if any `d` has drifted from its words,
which is what `generator/test_photo_card_copy.py` runs. `data-font` is a repo-relative path, a glob
so a content-hashed web font can be named without freezing its hash. It needs `fonttools` — a dev
dependency; the production image only ever prints the paths the script leaves behind.

Each card is set in **its own template's face**, not one house font: the generic card is
Heebo (the brand face, self-hosted under `site/assets/fonts/`) at 7 units with 0.3 tracking, and
grapefruit's is Cafe Regular — its own word font — at 7.2 with none. Both sit on baseline 70,
centred on the card's advance width at x = 111.96.

**There is no `דוגרי` wordmark on the card**, and no rule above where it was: the owner had both
removed. Nothing prints below the pawn grid at all now, which is what
`test_nothing_prints_below_the_pawn_grid` pins — searching for the word cannot catch a
reintroduction, because it would come back as outlines.

## Resolution order — which photo card to use

1. `DATA_DIR/templates/<key>/clean/photo.svg` — the owner template overlay, if `DATA_DIR` is set
   and the file exists (same overlay rule the rest of `generator/config.py` follows).
2. `resources/canva/templates/<slug>/clean/photo.svg` — the theme's own photo card. Only
   `grapefruit` ships one today.
3. `resources/canva/templates/_shared/photo-card/photo.svg` — the generic Dugri photo card.
   Black and white, sharp corners, thin Heebo Light headings. Always present, so resolution
   never fails.

A theme opts in simply by dropping a `clean/photo.svg` next to its other artwork; there is no
registry entry and nothing to add to `themes.json`.

## Resolution order — which images to put in the slots

`resources/canva/templates/_shared/photo-fallback/{1,2,3,4}.svg` is the generic pawn set: four
monochrome pawn marks (solid, two-tone, banded, outline) on a **transparent** ground. That
transparency is now load-bearing, not a convenience: the fallbacks go through the same halo as a
customer photo, and a fallback with an opaque ground would print as a white-edged square. Any
replacement pawn — including an owner override uploaded through the admin panel — has to be
transparent for the same reason.

Point 1's "never a rectangle" guarantee does **not** cover them, because they never pass through
`square_photo()` — `resolve_photos()` tops the list up with them untouched, and Pillow cannot open
an SVG anyway. Their own transparency is the whole of it. An owner who uploads an opaque PNG
override gets the white-edged square that customer photos no longer produce; if that becomes a
real complaint, disc-masking the raster overrides at upload is the fix, not routing artwork
through the customer-photo path.

Recommended fill rule:

- The order's `pawn_images` fill slots in order: photo 1 → `photo-slot-1`, photo 2 →
  `photo-slot-2`, …
- **Every slot with no photo takes the fallback of the same index** — slot 3 gets
  `photo-fallback/3.svg`. An order with zero photos therefore gets the full generic set, and an
  order with two photos gets two faces plus pawns 3 and 4.

The fallbacks are 200 × 200 SVGs, each pawn centred on the slot and **drawn inside the cut-line —
never outside it and never on it**, which is the owner's rule and this contract's debt now paid.

They used to be blown up 1.2×, on the theory that a pawn should fill the cut-line and spill a
little past it the way a cropped portrait does. It does not read that way on paper: a customer's
photo is clipped to 0.90 of the slot (`PHOTO_DISC_FILL`) with its halo landing just inside the
dashes, so a fallback crossing them made a half-filled card look like two different products, and
the owner rejected it on a real render. **Do not restore the blow-up.** The drawings were always
sized to fit — at 1× the furthest ink reaches r ≈ 89.7 of the 100-unit cut-line against the disc's
90 — so the fix was to delete the `scale(1.2)` and keep only the re-centring `translate(0 -1.6)`;
the halo then spreads to ≈ 97, still inside the dashes. `tests/unit/photo-card.test.js` bounds each
pawn's reach with a convex hull over its path's control points, which over-estimates and so can
only ever be too strict — the safe direction for a "must not cross" rule.

The fallbacks are artwork and pass through `square_photo()` untouched, so this is the only place
the rule can be enforced for them. Chrome (the generator's rasteriser)
renders an SVG inside `<image href="data:image/svg+xml;base64,…">` fine; if a future renderer does
not, rasterise them to **RGBA** PNG first — do not inline them as markup, since their internal ids
(`lower`, `pawn`) would collide with the host document. They are drawn from bold silhouettes and
knock-outs rather than fine hatching on purpose: Chrome rasterises an SVG-in-`<image>` at roughly
slot resolution, and a fine pattern moirés there.

## Size discipline

Every file here is authored by hand, not exported from Canva, and stays small on purpose:
the grapefruit card's fruit pattern is a single vector slice stamped with `<use>` instead of the
original's 7 MB embedded PNG. `tests/unit/photo-card.test.js` fails the build if a `base64`
payload or a remote URL appears in any of these files, or if a card grows past 64 KB.
