# Phase 2, round 5: r2-a's deck in r4-b's world (gate D2)

Owner: "I like r2-a: the deck opening and the cards tossing, no buttons needed. But with r4-b." This replaces the earlier round 5 (deck at the side, after r2-c). That version is at commit 14702e3 if anyone needs it.

One file: `r5.html`.

## What carries over from r4-b unchanged

The Dugri colours: white, sand, beige, and logo pink as the only accent. Rubik 900, the stickers, pills, outlines and the occasion tab carry over too. So does every section below the hero: who, how it works (clock and pawn), and the designs strip with its lean and colour flood.

## The hero (r2-a's mechanics)

- **The deck opens with a deal.** On load, one card leaves the deck with a real throw and slides to rest with friction. The throw velocity is set so friction stops the card exactly on its spot; there is no CSS entrance. The first card is a פריז card, to match the רווקות tab, which starts pressed.
- **Tap the deck** and it deals the next real card. The card turns face up in the air, lifts (it scales up and its shadow falls further while it is fast), and spins. About one deal in five adds a full turn.
- **The deck's top back** is always the design it deals next. That design is never the one just dealt, and a design shows a front you haven't just seen.
- **Any card on the table:**
  - **Hold it** and it turns about the point you hold: pulled by a corner, it swings so its centre trails your finger (`shots/r5-drag.png`).
  - **Let go fast** and it slides on with inertia and spin.
  - **Tap it** and it flips front and back.
  - **Edges:** the screen's sides and the table's top and bottom are soft walls that push a card back instead of stopping it dead.
- **No buttons in the hero.** The flip button, the next-card button, the counter and shuffle are gone. The only hint is one sticker on the deck, "לגעת בחפיסה", which fades at the first touch. The order pill under the table stays; it is the page's CTA, not a deck control.
- **Not a messy pile.**
  - There is no game-board background: the table is the white hero.
  - Each new card lands on whichever of several random spots is furthest from every card already there, so the table fills evenly.
  - At most 6 cards stay on the table on a phone, 8 on desktop. Past that, the card nobody touched longest slides off and fades.
- **The deck has a fixed spot**, bottom right of the table, inside a dashed outline. No card ever lands on it. A card thrown onto it is pushed off the way it would slide off a block, so the deck is always clear to tap.
- **The tab and the who tiles** each deal their design as the next card. A tile first scrolls up to the table.

## Keyboard, screen reader, reduced motion

- **Keyboard and screen reader:** the deck is a real `<button>` with no visible text and `aria-label="לחלק קלף מהחפיסה"`, so Enter and Space deal. Each deal is announced in a polite live region ("קלף מהעיצוב פריז"). Cards on the table are `aria-hidden`; they are decoration for pointer play.
- **Reduced motion:** a deal fades the card in at its spot, a flip is a crossfade, a dragged card doesn't turn and stops where it is let go, and there are no throws.

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r5.html` | `media/r5-motion.mp4` (390×844: four deals, a flip, a corner drag and fling, four more deals, the birthday tab) |
| `shots/r5.png`: the 390×844 fold on arrival, one card dealt, the hint on the deck | |
| `shots/r5-play.png`: after five more deals | |
| `shots/r5-drag.png`: a card held by its corner, mid-swing | |
| `shots/r5-full.png`: the whole page | |
| `shots/r5-desktop.png`: 1440×900 after seven deals | |

## Checked

Playwright, at 390×844 and 1440×900 with normal motion, and at 390×844 with reduced motion:

- No page errors.
- Ten deals in a row, with no design twice in a row.
- The cap holds at 6 / 8.
- Enter on the focused deck deals.
- A tap flips a card.
- A fling slides and then settles.
- No settled card overlaps the deck.
