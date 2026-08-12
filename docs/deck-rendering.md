# How the card deck is rendered

**The schema lives elsewhere.** `docs/card-structure-schema.md` is the contract —
asset layout, recipe format, `themes.json` keys — and `docs/photo-card.md` is the
photo-card contract. This document is only about how the generator turns those
assets into the two delivered PDFs, and why it is built the way it is.

## The deck is one document, printed once

v1 screenshotted each page with its own headless-Chrome run and stitched the PNGs
with Pillow. That does not survive v2's 208 pages, and both failure modes were
measured rather than assumed:

- Pillow's PDF writer materialises every page before encoding — a 208-page deck
  at print resolution peaks at **784 MB**. Railway does not have that to give.
- ~106 distinct pages x one Chrome start-up each runs to **minutes**, past the
  server's 120 s `GENERATE_TIMEOUT_MS`.

So the whole deck is assembled as ONE HTML document containing all 208 pages and
printed in a SINGLE `--print-to-pdf` pass (`generator/deck_html.py`). Chrome
paginates it via `@page`; Python never holds a raster at all.

Measured on the real grapefruit export:

| pages   | Chrome     | PDF        | page box            | Python peak RSS |
| ------- | ---------- | ---------- | ------------------- | --------------- |
| 8       | 1.96 s     | 4.4 MB     | 223.92 x 312 pt     | —               |
| 52      | 2.08 s     | 5.5 MB     | 223.92 x 312 pt     | —               |
| **208** | **2.98 s** | **9.4 MB** | **223.92 x 312 pt** | **149 MB**      |

A full order (topup -> pack -> deck + board) runs end to end in **~6 s**.

Three consequences worth knowing:

- **Pages stay vector.** Text is real text, not a resampled bitmap.
- **The page box is the card's physical size in points**, so "print at 100%" is
  literally true. (v1's A4 sheets were declared at 300 DPI over a 1123 px raster,
  i.e. ~190 mm wide rather than 297 mm. v2 does not inherit that.)
- **No `--virtual-time-budget` on the print path.** It makes Chrome sit out the
  whole clock, turning a 3 s deck into minutes. Chrome already waits for webfonts
  before printing. The screenshot path (preview) still needs it.

## Three things the assembler must get right

Each is pinned by tests in `generator/test_deck_html.py`, and each fails
_silently_ — producing a wrong card that still prints, not an error.

1. **Id namespacing.** The nine card SVGs are near-identical Canva exports that
   reuse clip-path and filter ids. Dropped into one document unprefixed, they
   clip each other's artwork. Every id, and every reference to it, is namespaced
   per source file on load. Corollary for anyone editing card artwork: the nine
   files are never rendered in isolation, so id uniqueness within one file is not
   enough.
2. **Payload dedupe.** Each front embeds the same multi-megabyte background. It
   is emitted once into a shared `<defs>` and every card points at it with
   `<use>`.
3. **Art dedupe.** Each of the nine designs is defined once as a `<g>` in
   `<defs>`; a page is a `<use>` of its design plus its own text overlay. A
   208-page deck therefore costs nine copies of the artwork, not 208.

Fonts follow the same rule: `@font-face` is declared once for the document, where
v1 re-embedded it into every page.

## Reading card artwork

Always `card_assets.read_svg(path)`, never `open(path).read()`. De-duplicated
artwork references its images relatively (`../assets/<sha16>.png`), and the
composed SVG is written to the OUTPUT directory rather than next to the artwork —
so a relative reference resolves against the wrong directory and the background
silently vanishes. `read_svg` absolutizes those references as it reads, and is a
no-op on artwork that was never de-duplicated.

## The two output artifacts

```
<out>.pdf          the 208-page card deck   (back, front) x 104
<out>.board.pdf    the board, one page
```

The board path is derived from the deck path (`build.board_pdf_path`), so a
caller that knows one knows the other. `order_to_pdf` returns
`(pdf, pages, board)` and prints `board <path>` on its own line; the server
parses it and records **`board_file`** next to `pdf_file` on the production
record. `board_file` is `null` for a v1 order, whose board is still the deck's
last page.

They are two files rather than one because the board is rendered at the board
artwork's own size (A4-ish), not the card's 223.92 x 312 pt. Concatenating them
would mean printing one of the two at the wrong size.

## Deck composition

104 cards, in fixed order, every card preceded by the back so the file prints
duplex: `[back, card1, back, card2, ..., back, card104]`.

- Cards 1..103 are word cards, 4 words each (412 words). The front style cycles
  `fronts[i % len(fronts)]`, giving 13/13/13/13/13/13/13/12 across eight styles.
  The count comes from the theme, not a hardcoded 8.
- Card 104 is the photo card (`docs/photo-card.md`).

Two deliberate departures from a fixed 104:

- FEWER words than a full deck yields FEWER cards rather than a tail of blank
  ones — only the last card is blank-padded.
- MORE words yields MORE cards. Every personal word is always kept (the product
  promises no upper limit), so an oversized list grows the deck past 103 instead
  of silently dropping the overflow. Front cycling stays even at any size.

### Which words share a card (per order)

The owner picks this per order, in the admin order dialog beside the seed pool
(`card_order` on the collection, `--order` on the generator, `pack.ORDERS`):

| choice           | what a card may hold                                         |
| ---------------- | ------------------------------------------------------------ |
| _(default)_      | anything — one shuffled blend, as every deck was before this |
| `personal-first` | her own words open the deck; the filler follows, never mixed |
| `by-script`      | Hebrew cards and Latin cards, never one card of both         |

Underneath all three, unchanged: **phrases are spread evenly**, so every card is
within one multi-word entry of the deck average (four words on a card render at
one size, and a card of four phrases prints tiny). Grouping only decides which
words a card may draw from — each group is dealt by the same balanced deal.

The cost is one card. A group whose size is not a multiple of four ends on a
short card (2 or 3 words), so a grouped deck can run one card longer than the
same words blended. Filling that card from the next group is the one thing the
option exists to prevent, and the last card of every deck has always been short.

Changing it does **not** discard a frozen word bank — the same 412 words print
either way — so it can be switched after a deck is produced and simply re-run.
