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

1. **A transparent cutout is REQUIRED, not preferred.** The card no longer draws a white disc
   behind the photo. The white sticker outline is generated **from the image's own alpha**, so an
   image with an opaque background has no silhouette to follow: it renders as a white-bordered
   **rectangle** and the card looks broken. There is no graceful degradation here by design —
   the failure is meant to be obvious rather than subtly wrong.
   **Where the cutout comes from.** It is produced in the BUYER'S BROWSER at upload time, not
   on the server and not at generate time — `site/js/pawn-cutout.js` runs MediaPipe's
   ImageSegmenter over the self-hosted `selfie_multiclass_256x256` model (both Apache-2.0,
   vendored under `site/vendor/mediapipe`, no CDN and no third-party API). The collection then
   keeps BOTH files: `pawn_images` is always the untouched ORIGINAL, and `pawn_cutouts` maps
   each original's path to its cutout path — or to `null` when a cut was attempted and failed,
   which the admin orders table flags in red. `pawnPhotoFiles()` hands the generator the cutout
   when there is one and the original otherwise, so the generator itself never knows the
   difference and never makes a network call. A browser too old to segment simply produces no
   cutout: the original prints (as the rectangle above) and the owner cuts it by hand.
2. **Alpha must survive the generator's own photo prep.** As of today it does not:
   `generator/build.py` → `square_photo()` ends with `im.convert("RGB").crop(box).save(out)`, and
   `convert("RGB")` flattens the alpha channel away. Every customer photo therefore reaches the
   slot opaque, whatever was done upstream. `convert("RGBA")` is the fix; the shipped fallbacks
   are not squared, so they already arrive transparent.
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
5. **Nothing is clipped to the circle.** The subject is allowed to spill past the cut-line, the
   way a real die-cut sticker does. Keep the subject inside the **slot box** (66 × 66 units); the
   halo and its shadow bleed roughly 5 units past that, which the 12-unit gutter between slots
   absorbs.
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
| white halo            | ≈ 2.4 units (0.68 mm), follows the subject's silhouette   |
| cutout format         | **transparent RGBA PNG** — required, alpha must be intact |
| cutout size           | 512 × 512 px target (min 220 = 300 DPI, max 768)          |
| payload cap           | < 1,000,000 base64 chars (`deck_html.BG_MIN_CHARS`)       |
| clipping              | none — the subject may cross the cut-line                 |
| `preserveAspectRatio` | `xMidYMid meet` (contain — never crops)                   |

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

## The sticker

Each slot is a **die-cut sticker**: a white outline that follows the subject's own silhouette,
over a dashed circle that marks where to cut. Per slot, in paint order:

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

Recommended fill rule:

- The order's `pawn_images` fill slots in order: photo 1 → `photo-slot-1`, photo 2 →
  `photo-slot-2`, …
- **Every slot with no photo takes the fallback of the same index** — slot 3 gets
  `photo-fallback/3.svg`. An order with zero photos therefore gets the full generic set, and an
  order with two photos gets two faces plus pawns 3 and 4.

The fallbacks are 200 × 200 SVGs, each pawn centred and drawn at 1.2× so it fills the cut-line
and spills a little past it, the way a cutout portrait does. Chrome (the generator's rasteriser)
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
