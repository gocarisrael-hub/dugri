# The photo card

The deck's 104th front is the **photo card** — one portrait card carrying the buyer's four
pawn photos (the images collected by the wizard's optional photo step and stored on the
collection as `pawn_images`, max 4). This document is the contract between the card artwork
(Agent B) and the generator that fills it (Agent C).

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

| id             | x      | y   | width | height |
| -------------- | ------ | --- | ----- | ------ |
| `photo-slot-1` | 39.93  | 87  | 66    | 66     |
| `photo-slot-2` | 117.93 | 87  | 66    | 66     |
| `photo-slot-3` | 39.93  | 165 | 66    | 66     |
| `photo-slot-4` | 117.93 | 165 | 66    | 66     |

The values above are documentation, not an API: **read `x`/`y`/`width`/`height` off the element**
rather than hardcoding them, so a theme is free to ship a different layout later.

## Filling a slot

Each slot ships as an `<image>` element with **no `href`**:

```xml
<image id="photo-slot-1" x="39.93" y="87" width="66" height="66"
       preserveAspectRatio="xMidYMid slice" clip-path="url(#photo-slot-1-clip)"/>
```

To fill it, set `href` (and `xlink:href` for older rasterisers) to a `data:` URI. That is the
whole integration — nothing else about the card needs touching:

- `preserveAspectRatio="xMidYMid slice"` centre-crops any aspect ratio to fill the square, so
  portrait and landscape photos both work without pre-cropping.
- `clip-path="url(#photo-slot-N-clip)"` rounds the photo into a token disc. The clip is a circle
  inscribed in the slot: `cx = x + width/2`, `cy = y + height/2`, `r = width/2`.
- A slot left empty renders as the card's designed empty disc (ground + ring + number badge) —
  never a broken image — so a half-filled card still prints cleanly.

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
monochrome pawn marks (solid, dotted, striped, outline) on a transparent ground, so they sit on
whatever disc the card draws and stay distinguishable at token size.

Recommended fill rule:

- The order's `pawn_images` fill slots in order: photo 1 → `photo-slot-1`, photo 2 →
  `photo-slot-2`, …
- **Every slot with no photo takes the fallback of the same index** — slot 3 gets
  `photo-fallback/3.svg`. An order with zero photos therefore gets the full generic set, and an
  order with two photos gets two faces plus pawns 3 and 4.

The fallbacks are 200 × 200 SVGs. Chrome (the generator's rasteriser) renders an SVG inside
`<image href="data:image/svg+xml;base64,…">` fine; if a future renderer does not, rasterise them
to PNG first — do not inline them as markup, since their internal ids (`dots`, `bars`) would
collide with the host document.

## Size discipline

Every file here is authored by hand, not exported from Canva, and stays small on purpose:
the grapefruit card's fruit pattern is a single vector slice stamped with `<use>` instead of the
original's 7 MB embedded PNG. `tests/unit/photo-card.test.js` fails the build if a `base64`
payload or a remote URL appears in any of these files, or if a card grows past 64 KB.
