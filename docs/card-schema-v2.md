# Card structure v2 — single-card deck (shared schema)

Status: **proposed by Agent C (generator owner), pending B sign-off.**
This is the contract the generator reads. Agent B writes it (asset migration +
calibration form); Agent D consumes the two output artifacts.

Nothing here is optional-by-accident: every field below is either required, or
has a stated default the generator applies when it is absent.

## 1. What changes

|            | v1 (today)                                 | v2                                          |
| ---------- | ------------------------------------------ | ------------------------------------------- |
| Page       | landscape A4 sheet, 8 cards                | portrait single card, viewBox ~223.92 x 312 |
| Deck       | N front sheets + shared back sheet + board | (back, front) x 104 = 208 pages             |
| Words/card | 4                                          | 4 (unchanged)                               |
| Words/page | 32                                         | 4                                           |
| Deck words | 416                                        | 412 (103 word cards x 4)                    |
| Fronts     | one `fronts.svg`                           | eight, `2.svg`..`9.svg` (icon differs only) |
| Back       | one `backs.svg` (8-up)                     | one `1.svg`, page 1 of every pair           |
| Board      | last page of the deck PDF                  | **separate output file**                    |
| Photo card | —                                          | card 104, 4 customer pawn-photos            |

## 2. Asset contract

```
<slug>/
  clean/
    1.svg          back                (required)
    2.svg .. 9.svg 8 fronts            (required, all 8)
    board.svg      board               (required — NOT part of the numeric deck set)
    board-chasers.svg                  (optional, unchanged behaviour)
    photo.svg      photo-card template (optional; falls back to front 2's art)
  filled/
    1.svg .. 9.svg text-filled twins of clean/, for calibration diffing
  fonts/
    ...            unchanged
```

Reference export: `resources/canva/templates/grapefruit/new structure/`.

- The numeric set `1..9` is the **deck**. The board deliberately stays a named
  file: it is a different geometry and a different output artifact, so it is not
  in the numeric sequence.
- All nine share one viewBox. `9.svg` in the reference export is `224.25 x
311.999995` against the others' `223.92 x 312` — a ~0.15% Canva rounding
  artifact. The generator renders each front at **its own** viewBox and lays
  slots out in _fractions of the card cell_, so this is harmless. B does not
  need to re-export for it.

### 2.1 Shared background dedupe (ground rule 3)

Verified on the grapefruit export: all 8 fronts embed the **byte-identical**
5.4 MB PNG (`md5` of the base64 payload matches across `2.svg`..`9.svg`).
That is ~43 MB per theme, ~344 MB across 8 themes, in the image _and_ on the
`DATA_DIR` volume.

The deduped form: the payload is lifted out once per theme, and each front keeps
a **marker** in place of its `xlink:href`:

```
<slug>/shared/<hash>.png                     the payload, stored once
clean/2.svg:  xlink:href="dugri:shared/<hash>.png"
```

The generator **re-inlines it at render time** (`card_assets.inline_shared`), so
the SVG handed to Chrome is byte-equivalent to the original. Chosen over a
relative `file://` href because headless Chrome's file-access rules for
sub-resources of a local SVG are a portability trap, and because it keeps a
rendered card self-contained.

`generator/card_assets.py` provides **both** directions —
`extract_shared(svg_paths, out_dir)` for B's migration/upload path and
`inline_shared(svg_text, theme_dir)` for the render path. Use the shared helper
rather than a second implementation, so strip and inline can never disagree.

A front with a normal inline payload still renders unchanged: `inline_shared` is
a no-op when no marker is present. Dedupe is therefore not a prerequisite for
anything else in v2.

## 3. themes.json entry

New/changed keys only; everything else (`slug`, `dir`, `wordlist`, `display_he`,
`visibility`, `title_lines`, `language`, `name_form`, `extra_fields`,
`title_font`, `word_font`, `calibrated`) is unchanged.

```jsonc
{
  "card_layout": "single",        // v2 discriminator. Absent or "sheet" = v1 8-up.
  "fronts": [2, 3, 4, 5, 6, 7, 8, 9],   // default when absent: [2..9]
  "back_index": 1,                      // default when absent: 1
  "photo_card": {                       // optional; omit to disable the photo card
    "template": "photo.svg",            // in clean/; default: front #1 of `fronts`
    "fallback": [                       // repo-relative generic Dugri images (B ships)
      "resources/dugri-pawns/1.png", "...2.png", "...3.png", "...4.png"
    ]
  },
  "title_style": {
    "fill": "#...", "outline": "#...", "outline_w": 0.05,
    "arch": 0.11, "shadow": true,
    "size": 23.9,                 // SHARED across all 8 fronts
    "back_size": 30,              // back title (1.svg)
    "board_size": 12,             // board title
    "align": "center", "italic": false,
    "offset": [0.0, 0.0],         // SHARED nudge, fractions of the card cell
    "front_offset": {             // PER-FRONT nudge, overrides `offset` for that front
      "4": [0.0, -0.03],
      "7": [0.01, 0.02]
    }
  },
  "word_size": 19,                // SHARED across all 8 fronts
  "board": { "frac": {...}, "fill": "...", "outline": "..." },   // unchanged
  "back":  { "frac": {...}, "fill": "...", "outline": "..." }    // unchanged
}
```

**Why the title split.** "Per-front title position" has two halves and they live
in different files, exactly as v1 already splits them:

- the **detected box** is geometry -> the recipe (`fronts.<n>.title`), written by
  `calibrate.py` / `recipe_diff.py` from the clean<->filled diff;
- the **owner's nudge** is a knob -> `title_style.front_offset.<n>`, written by
  the admin calibration form.

Word slots, word font and all sizes are **shared** — one set for the whole deck.
Only the title box moves per front.

## 4. Recipe JSON (single-card)

`generator/recipes/<name>.json`, or `DATA_DIR/templates/recipes/<name>.json`.

```jsonc
{
  "theme": "grapefruit",
  "layout": "single",             // v2 discriminator; absent = v1 `cards[]` sheet
  "viewBox": [0, 0, 223.92, 312],
  "card": {
    "cell": [0, 0, 223.92, 312],
    "words": [                    // exactly 4, SHARED by all 8 fronts
      { "x0": .., "y0": .., "x1": .., "y1": .., "color": "#3a2a1e" }
    ]
  },
  "fronts": {
    "2": { "title": [ { "x0": .., "y0": .., "x1": .., "y1": .., "color": ".." } ] },
    "3": { "title": [ ... ] }
    // ... one entry per front. A front with no entry falls back to `card.title`
    // if present, else to the union of the other fronts' title boxes.
  },
  "back":  { "title": [ ... ] },  // optional; else themes.json `back.frac` is used
  "photo": { "slots": [ {x0,y0,x1,y1} x4 ] }  // optional; default 2x2 grid, 6% inset
}
```

A title may be recorded as **several boxes** (one per title line); the generator
fits the stacked title into their union, as it does in v1.

## 4a. How the deck is rendered (implemented; measured)

v1 screenshotted each page with its own headless-Chrome run and stitched the
PNGs with Pillow. That does not survive v2's scale, and both failure modes were
measured rather than assumed:

- Pillow's PDF writer materialises every page before encoding — a 208-page deck
  at print resolution peaks at **784 MB**, which Railway does not have;
- 106 distinct pages x one Chrome start-up each runs to minutes, past the
  server's 120 s `GENERATE_TIMEOUT_MS`.

So a v2 deck is built as **ONE HTML document containing all 208 pages** and
printed in a **single `--print-to-pdf` pass** (`generator/deck_html.py`). Chrome
paginates via `@page`; Python never holds a raster.

Measured on the real grapefruit export:

| pages   | Chrome     | PDF        | page box            | Python peak RSS |
| ------- | ---------- | ---------- | ------------------- | --------------- |
| 8       | 1.96 s     | 4.4 MB     | 223.92 x 312 pt     | —               |
| 52      | 2.08 s     | 5.5 MB     | 223.92 x 312 pt     | —               |
| **208** | **2.98 s** | **9.4 MB** | **223.92 x 312 pt** | **149 MB**      |

A full order (topup -> pack -> deck + board) runs end to end in ~6 s.

Three consequences worth knowing:

- **Pages stay vector.** Text is real text, not a resampled bitmap.
- **The page box is the card's physical size in points**, so "print at 100%" is
  literally true. (v1's A4 sheets were declared at 300 DPI over a 1123 px raster,
  i.e. ~190 mm wide rather than 297 mm — v2 does not inherit that.)
- **No `--virtual-time-budget` on the print path.** It makes Chrome sit out the
  whole clock, turning a 3 s deck into minutes. Chrome already waits for
  webfonts before printing. The screenshot path (preview) still needs it.

Three things the assembler must get right, each pinned by tests in
`generator/test_deck_html.py`: per-file **id namespacing** (the nine exports
reuse Canva clip-path ids and would otherwise clip each other's artwork),
**payload dedupe** (the background is emitted once and `<use>`d), and **art
dedupe** (each design is defined once, not once per page).

## 5. Outputs

`order_to_pdf` returns `(deck_pdf, pages, board_path)` and writes two files:

```
<out>.pdf              the 208-page deck   (back, front) x 104
<out>.board.pdf        the board, one page
```

The board path is derived from the deck path by replacing the `.pdf` suffix with
`.board.pdf`, so a caller that knows the deck path knows the board path without
a second round-trip.

The CLI prints the board on its own line (`board <path>`), and the server already
parses it: `runGenerator` resolves `{ pages, board }`, and `db.setProduction`
records **`board_file`** alongside `pdf_file` (null for a v1 order, whose board
is still the deck's last page).

**Agent D**: `board_file` is the hook — wire it into the `pdf_ready` email and
the `/pdf` capability-token download routes so an order delivers both artifacts.
The generator and the production record are done; only delivery is open.

## 6. Card composition

104 cards, in fixed order:

- cards 1..103 — word cards, 4 words each (412 words total).
  Front style cycles round-robin: card `i` (0-based) uses
  `fronts[i % len(fronts)]`, giving 13/13/13/13/13/13/13/12 across the 8 styles.
- card 104 — the photo card: the collection's `pawn_images` (up to 4), padded
  from `photo_card.fallback` when the customer uploaded fewer than 4, and
  entirely from the fallback set when they uploaded none.

Every card is preceded by the back, so the PDF is
`[back, card1, back, card2, ..., back, card104]` = 208 pages, print-ready duplex.

## 7. Back-compatibility

`card_layout` gates everything. A theme without it renders through the v1 8-up
path unchanged, so the seven un-migrated themes keep working while grapefruit
goes first (ground rule 2). The v1 path is removed only once all eight themes
carry `card_layout: "single"`.
