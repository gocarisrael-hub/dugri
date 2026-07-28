# Card-structure schema (portrait single cards)

Status: **proposed by Agent B, pending Agent C sign-off.** This is the contract the
asset migration, the generator rewrite and the admin UI all code against. Ground
rule 1: lock this before parallel work.

## What changes

Today the deck is landscape A4 sheets of 8 cards (one `fronts.svg` per theme, a
shared `backs.svg`, a `board.svg` page). We move to **portrait single cards**:

- Card-deck PDF = `(back, front) × 104` = **208 pages**, back first in each pair.
- **103 word cards**, 4 words each (~412 words), cycling 8 front styles evenly.
- **1 photo card** (the 104th front) carrying the customer's 4 pawn-photos.
- **Board is a separate output file**, delivered alongside the deck — never inside
  the 208 pages.

## 1. Asset contract

Per template directory (in the image under `resources/canva/templates/<slug>/`,
or on the volume under `$DATA_DIR/templates/<slug>/`):

```
<slug>/
  clean/1.svg  … 9.svg     1 = back, 2–9 = the eight fronts
  filled/1.svg … 9.svg     same nine, with Canva's specimen text still in place
  assets/<sha16>.<ext>     de-duplicated shared images (see §4)
  fonts/                   theme fonts, unchanged
  clean/photo.svg          OPTIONAL — background for the photo card (§3)
```

`clean/` is what we render onto. `filled/` exists only so calibration can diff
clean↔filled and locate the text slots.

**The board is not in the numbered set.** Board artwork stays where it is today
(`clean/board.svg`, plus the optional `clean/board-chasers.svg` variant). It is
excluded from the 1–9 contract and from the deck, and is rendered to its own
output file.

Card geometry is `viewBox="0 0 223.92 312"` (portrait, ~0.718 aspect).

## 2. Single-card geometry — `card_slots` on the theme entry

**Geometry for a single-card template lives on the themes.json entry, NOT in the
recipe file.** A `card_structure: "cards"` theme carries:

```jsonc
"card_structure": "cards",   // absent => "sheet", i.e. a legacy 8-up template
"card_slots": {
  // The four word slots — SHARED by all eight fronts, because they never move.
  // One calibration, not eight.
  "words": [ {"x0":…,"y0":…,"x1":…,"y1":…}, …4 total ],
  // The title POSITION per front — the one thing that DOES move. All eight
  // fronts are required: a half-filled map leaves some fronts with the title
  // wherever the last calibration happened to put it.
  "titles": { "2": {…}, "3": {…}, "4": {…}, "5": {…},
              "6": {…}, "7": {…}, "8": {…}, "9": {…} }
}
```

`card_slots: null` means "not calibrated yet" and is a valid state — it is what
a freshly migrated template ships with, alongside `calibrated: false`.

Every box is a **fraction of the 223.92×312 card** (`x0,y0,x1,y1` each in 0..1,
`x0 < x1`, `y0 < y1`), not an absolute coordinate. Fractions survive a re-export
at a different pixel size; absolute coordinates silently would not.

Why the entry rather than the recipe file:

- Owner-uploaded templates live on the volume as a themes.json entry with **no
  shipped recipe file at all**. Entry-based geometry works identically for
  shipped and owner templates; recipe-based would not.
- The admin calibrator already writes calibration into the entry (the board and
  back name slots are `frac` boxes there today). `card_slots` follows the
  convention that already exists rather than adding a second one.
- One source of truth. Geometry in two places is the failure this section exists
  to prevent.

The recipe file for a cards template therefore carries no geometry — only
`format: 2` and the `viewBox` the fractions are relative to — and exists so the
entry's `recipe` key resolves. `generator/recipes/grapefruit.json` is the
reference. Legacy sheet templates keep their existing recipe geometry untouched.

Font, colour and size knobs (`title_style`, `word_font`, `word_size`, `offset`,
`italic`, `outline`…) stay in `themes.json` and stay **shared across the eight
fronts** — only the title's _position_ is per-front.

### What grapefruit's export actually contains (measured, not assumed)

Worth knowing before you calibrate against it:

- `clean/2` … `clean/8` render **pixel-identical** — grapefruit ships ONE front
  design, not eight. Their SVG text differs only in Canva's randomised element
  ids. Only `clean/9` differs visually (same layout, background pattern
  positioned differently).
- The owner has confirmed the `1 = back / 2–9 = eight fronts` schema is correct
  and that OTHER templates will have genuinely distinct fronts. Grapefruit is
  simply uniform today. Do not "optimise" the eight fronts down to one.
- `clean/1` (the back) is a full-bleed pattern with **no text slot at all** —
  hence `"back": null` in its themes.json entry.
- The board carries **no honoree name either** — the owner has confirmed the
  final board is impersonal — so `"board": null` is correct and there is no board
  name slot to calibrate. Grapefruit therefore ships `clean/board.svg` and
  `clean/board-chasers.svg` but **no `filled/` boards**: `filled/` exists only to
  diff against for text positions, and there is no board text to find.
- The cream panel the text sits in is at `[24.34, 22.44, 199.52, 290.0]` on
  fronts 1–8, but front 9's panel is DIFFERENT. That is the concrete reason
  title geometry is per-front rather than shared.

### Migrating an existing theme's calibration

Legacy recipes are A4-landscape (`viewBox` 841.92×595.5) with 8 cells, and card
0's cell is `[9.7, 10.5, 200.2, 286.4]` — already inside a 223.92×312 box. So
card 0's slots are a good STARTING POINT for the equivalent single card: divide
them by the card's width and height to get the `card_slots` fractions, rather
than hand-calibrating the other seven themes from scratch. Treat the result as a
first guess to be checked against a render, not as finished calibration — the
old cell carried a sheet's margins that the single card does not.

## 3. themes.json additions

```jsonc
"grapefruit": {
  …existing keys…
  "cards": {
    "back": 1,
    "fronts": [2, 3, 4, 5, 6, 7, 8, 9],
    "photo": {
      "template": "clean/photo.svg",     // omit -> fall back to front 2
      "fallback": "photo-fallback"       // dir of 4 generic Dugri images
    }
  },
  "card_structure": "cards",             // absent => legacy "sheet" (§2)
  "card_slots": null                     // §2; null = not calibrated yet
}
```

`card_structure` is what the server and the admin form branch on. **A migrated
template that omits it is treated as a legacy sheet** and the server goes looking
for `clean/fronts.svg`, so it must be set whenever the numbered 1–9 artwork is
installed.

### Which front does word card _n_ get?

Zero-based over the 103 word cards:

```python
front = cards["fronts"][n % len(cards["fronts"])]
```

103 over 8 gives 13/13/13/13/13/13/13/12 — even to within one card, as specified.
Card 104 is the photo card and takes no front from this cycle.

## 4. Image de-duplication (ground rule 3)

Canva embeds each card's background raster as a base64 data URI. The eight fronts
share one ~5 MB PNG, and each ships twice (clean + filled), so grapefruit alone is
**124 MB of SVG carrying 8.6 MB of unique pixels** — ~1 GB across eight templates,
on the volume, in the Docker image, and re-parsed on every render.

Each distinct image is therefore stored **once** as `assets/<sha16>.<ext>` and
referenced as `href="../assets/<sha16>.png"`. Measured on grapefruit:

|           | before       | after              |
| --------- | ------------ | ------------------ |
| 18 SVGs   | 124.2 MB     | 0.98 MB            |
| assets/   | —            | 8.63 MB            |
| **total** | **124.2 MB** | **9.61 MB** (−92%) |

All 18 renders are byte-identical to the embedded originals (verified through the
real pipeline: read → compose → write to a different directory → headless Chrome).

### The one catch — READ THIS BEFORE LOADING A CARD SVG

`render_page.render()` writes its composed SVG to the **output** directory, not
next to the artwork. A relative `../assets/…` reference does not survive that
move: the background silently vanishes and the card renders bare.

So a de-duplicated card SVG must never be loaded with a plain `open()`:

```python
import card_assets
svg = card_assets.read_svg(clean_svg_path)   # NOT open(path).read()
```

`read_svg` rewrites every `../assets/` reference to an absolute path as it reads.
It is a **no-op on artwork that was never migrated**, so callers never have to ask
which form a template is in — it is always the correct way to read a card SVG.

`generator/card_assets.py` also provides `migrate_template(src, dst)` to convert a
Canva export, and runs as a CLI:

```
python3 generator/card_assets.py <src-template-dir> <dst-template-dir>
```

## 5. Ownership

| Area                                                                                                                  | Owner |
| --------------------------------------------------------------------------------------------------------------------- | ----- |
| asset contract, migration, `card_assets.py`, themes.json/recipe entries                                               | B     |
| calibration UI + template onboarding                                                                                  | B     |
| photo-card template + fallback images                                                                                 | B     |
| storefront/gallery                                                                                                    | B     |
| `pack.py`, `build.py`, `render_page.py`, `config.py`, `topup.py`, `order_to_pdf.py`, `calibrate.py`, `recipe_diff.py` | C     |
| board delivery (email + `/pdf` routes)                                                                                | D     |
