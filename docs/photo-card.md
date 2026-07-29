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

1. **Four slots, filled by setting ONE attribute.** Each is an `<image>` with an id, explicit
   `x`/`y`/`width`/`height` and **no `href`**. Set `href` (plus `xlink:href`) to a `data:` URI and
   touch nothing else. Ids: `photo-slot-1`, `photo-slot-2`, `photo-slot-3`, `photo-slot-4`.
2. **Hand us a transparent-background cutout.** Background already removed, alpha preserved —
   PNG, not JPEG. The card draws a **white disc behind the image**, so whatever the subject does
   not cover reads as the sticker's white face, never the card's background pattern. The template
   does no masking, no background removal and no silhouette work of its own.
3. **Render it square.** Target **512 × 512 px**; floor **220 px** (that is 300 DPI over the
   slot's 18.57 mm), ceiling **1024 px** — every pixel above that is base64 that ships in the
   order's PDF four times over.
4. **Only the inscribed circle is visible.** The image is clipped to a circle of radius 33 units
   centred in the slot box. Fit the subject inside a centred disc of **0.46 × the image side**
   (≈ 8 % margin) or its edges get cut. Corners of the source image are never visible.
5. **The slot contains, it does not crop.** `preserveAspectRatio="xMidYMid meet"` — a non-square
   cutout is scaled to fit and centred, so a tall cutout keeps its head. (This changed from
   `slice`: cover-cropping a 2:3 cutout to fill the square cut the subject's head off.)
6. **Empty is a valid state.** A slot left without an `href` renders as a designed empty white
   sticker, never a broken image. Filling only some slots is fine.

| what                  | value                                                  |
| --------------------- | ------------------------------------------------------ |
| slot box              | 66 × 66 units (18.57 × 18.57 mm)                       |
| visible disc          | circle, r = 33 units, centred in the slot box          |
| white die-cut ring    | r = 33 → 37 units (≈ 1.13 mm) — artwork, not the image |
| cutout format         | transparent PNG, square                                |
| cutout size           | 512 × 512 px target (min 220 = 300 DPI, max 1024)      |
| subject safe area     | centred disc, r ≤ 0.46 × image side                    |
| `preserveAspectRatio` | `xMidYMid meet` (contain — never crops)                |

## Geometry

Same as every other card in the new deck:

| property     | value                                       |
| ------------ | ------------------------------------------- |
| `viewBox`    | `0 0 223.92 312` (portrait)                 |
| physical     | 63 × 88 mm — 1 unit ≈ 0.281 mm              |
| slot size    | 66 × 66 units, clipped to an inscribed disc |
| slot spacing | 12 units between slots, 2 × 2 grid          |

The four slots are numbered left-to-right, top-to-bottom, and their geometry is **identical on
every photo card** — so the generator never has to branch on which template it loaded:

| id             | x      | y   | width | height | disc centre | disc r |
| -------------- | ------ | --- | ----- | ------ | ----------- | ------ |
| `photo-slot-1` | 39.93  | 87  | 66    | 66     | 72.93, 120  | 33     |
| `photo-slot-2` | 117.93 | 87  | 66    | 66     | 150.93, 120 | 33     |
| `photo-slot-3` | 39.93  | 165 | 66    | 66     | 72.93, 198  | 33     |
| `photo-slot-4` | 117.93 | 165 | 66    | 66     | 150.93, 198 | 33     |

The values above are documentation, not an API: **read `x`/`y`/`width`/`height` off the element**
rather than hardcoding them, so a theme is free to ship a different layout later.

## The sticker

Each slot is drawn as a round **die-cut sticker**, not a framed crop. Per slot, in order:

```xml
<g class="photo-sticker" data-slot="1">
  <circle cx="72.93" cy="120" r="37" fill="#ffffff" filter="url(#sticker-lift)"/>
  <image id="photo-slot-1" x="39.93" y="87" width="66" height="66"
         preserveAspectRatio="xMidYMid meet" clip-path="url(#photo-slot-1-clip)"/>
  <circle cx="72.93" cy="120" r="37" fill="none" stroke="#111111"
          stroke-opacity="0.12" stroke-width="0.4"/>
</g>
```

- The **white circle comes first**, behind the image, and is 4 units wider than the image disc.
  That is both the sticker's face (what shows through a transparent cutout) and its white
  die-cut border (what shows around a subject that reaches the disc edge). It has to be a
  separate element: painting it onto the image would defeat the cutout's alpha.
- `filter="url(#sticker-lift)"` is a single `feDropShadow` declared once in `<defs>` — it lifts
  the sticker off the card. It is applied to the white disc **only**, so the customer's photo is
  never pushed through a filter. Verified in headless Chrome, both `screenshot()` and
  `--print-to-pdf`.
- The hairline circle on top closes the die-cut edge where the card behind it is also white.
- The four numbered badges are drawn **after all four stickers**, in one
  `<g class="photo-sticker-badges">`, so a badge that straddles its own sticker's rim is never
  buried under the neighbouring sticker's disc.

A theme may re-tint the hairline and the shadow (grapefruit uses its maroon), but the **face
stays `#ffffff`** — that is what makes the cutout contract hold on a patterned card.

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
monochrome pawn marks (solid, two-tone, banded, outline) on a transparent ground, so they sit on
whatever white sticker face the card draws and stay distinguishable at token size. Each is drawn
large and bottom-anchored inside its 200 × 200 box — it fills the sticker the way a real cutout
portrait does, and clears the number badge — so a card with no photos still reads as finished
artwork rather than as four empty holes.

Recommended fill rule:

- The order's `pawn_images` fill slots in order: photo 1 → `photo-slot-1`, photo 2 →
  `photo-slot-2`, …
- **Every slot with no photo takes the fallback of the same index** — slot 3 gets
  `photo-fallback/3.svg`. An order with zero photos therefore gets the full generic set, and an
  order with two photos gets two faces plus pawns 3 and 4.

The fallbacks are 200 × 200 SVGs. Chrome (the generator's rasteriser) renders an SVG inside
`<image href="data:image/svg+xml;base64,…">` fine; if a future renderer does not, rasterise them
to PNG first — do not inline them as markup, since their internal ids (`lower`, `pawn`) would
collide with the host document. They are drawn from bold silhouettes and knock-outs rather than
fine hatching on purpose: Chrome rasterises an SVG-in-`<image>` at roughly slot resolution, and a
fine pattern moirés there.

## Size discipline

Every file here is authored by hand, not exported from Canva, and stays small on purpose:
the grapefruit card's fruit pattern is a single vector slice stamped with `<use>` instead of the
original's 7 MB embedded PNG. `tests/unit/photo-card.test.js` fails the build if a `base64`
payload or a remote URL appears in any of these files, or if a card grows past 64 KB.
