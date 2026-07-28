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

Each slot already carries `preserveAspectRatio="xMidYMid slice"` (centre-crop to fill) and
`clip-path="url(#photo-slot-N-clip)"` (an inscribed circle, so the photo reads as a game token).
An empty slot renders as the designed empty disc, never a broken image.

A theme overrides this card by dropping its own `clean/photo.svg` — same ids, same geometry.
`grapefruit` does. Full contract and resolution order: `docs/photo-card.md`.

## `photo-fallback/{1,2,3,4}.svg`

The generic pawn set used for any slot with no customer photo: four monochrome pawn marks
(solid, dotted, striped, outline) on a **transparent** ground, so they drop onto whatever disc
the host card draws. 200 × 200, indexed to match the slot numbers — slot 3 takes `3.svg`.

## Editing

These files are hand-authored, not Canva exports. Keep them that way: no embedded rasters, no
remote references, no `<text>` (static copy is baked to vector paths so rendering needs no
fonts). `tests/unit/photo-card.test.js` enforces all of it.
