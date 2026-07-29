# `_shared` — artwork that is not tied to one theme

## `photo-card/photo.svg`

The generic **photo card**: the deck's 104th front, a 223.92 × 312 portrait card holding the
buyer's four pawn photos. Used whenever the ordered theme does not ship its own
`clean/photo.svg`. Black and white, sharp corners, thin Heebo Light headings.

Four slots, numbered left-to-right then top-to-bottom, each an `<image>` with **no `href`** — the
generator fills one by setting `href` to a `data:` URI and touching nothing else:

| id             | x      | y   | width | height |
| -------------- | ------ | --- | ----- | ------ |
| `photo-slot-1` | 39.93  | 87  | 66    | 66     |
| `photo-slot-2` | 117.93 | 87  | 66    | 66     |
| `photo-slot-3` | 39.93  | 165 | 66    | 66     |
| `photo-slot-4` | 117.93 | 165 | 66    | 66     |

Each slot is drawn as a **die-cut sticker**: a dashed circle (r 33) marking the cut, then a
`<use>` of the slot filtered through `#sticker-halo` — which dilates the image's own alpha into a
white outline that follows the **subject's silhouette** — then the unfiltered image on top. There
is no disc and no fill: the card shows through everywhere the subject and its halo do not cover,
and the subject is free to spill past the cut-line, which is what makes it read as die-cut rather
than as a photo in a circle.

Because the outline comes from the image's alpha, **a transparent cutout is required**: an opaque
photo has no silhouette and prints as a white-edged rectangle. The slot carries
`preserveAspectRatio="xMidYMid meet"` (contain, so a tall cutout is never cropped) and no
`clip-path`. An empty slot renders as the dashed cut-line alone, never a broken image.

A theme overrides this card by dropping its own `clean/photo.svg` — same ids, same geometry.
`grapefruit` does. Full contract and resolution order: `docs/photo-card.md`.

## `photo-fallback/{1,2,3,4}.svg`

The generic pawn set used for any slot with no customer photo: four monochrome pawn marks
(solid, two-tone, banded, outline) on a **transparent** ground. 200 × 200, indexed to match the
slot numbers — slot 3 takes `3.svg`.

The transparency is load-bearing, not a convenience: these go through the host card's halo filter
exactly like a customer photo, so the white outline traces the pawn's silhouette. An opaque
replacement would print as a white-edged square. Each pawn is centred and drawn at 1.2× so it
fills the cut-line and spills a little past it, and the four are told apart by bold silhouette
knock-outs rather than fine hatching — Chrome rasterises an SVG-in-`<image>` at roughly slot
resolution, where a fine pattern moirés.

## Editing

These files are hand-authored, not Canva exports. Keep them that way: no embedded rasters, no
remote references, no `<text>` (static copy is baked to vector paths so rendering needs no
fonts). `tests/unit/photo-card.test.js` enforces all of it.
