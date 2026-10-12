# Phase 2, round 2: three new homepage directions (gate D2)

Round 1 (`a.html`, `b.html`, `c.html`) was rejected: all three read as a Claude-built landing page, and the hand-built card mockups were fake. Round 2 starts from the one thing that worked, the real cards, and from real party footage.

## Rules this round was held to

- Only real Dugri objects: cards cropped one by one from the real print sheets (`site/assets/designs/*/gallery-{front,back}.webp`) into `cards/`, the real boards (`gallery-board.webp`), the real product shots (`store.webp`), the logo. No card, board or word is drawn in HTML or CSS; every word on a card is the word printed on that sample card.
- Banned and checked against each idea: headline + subtitle + CTA + object hero; the hero/how/occasions/designs/testimonials/FAQ stack; fade-up reveals and staggered entrances; pill buttons with an arrow in a circle; glass nav; marquee bands; outlines with hard offset shadows; double-bezel frames; grey/off-white ground with one accent; numbered 1-2-3 steps; FAQ accordions.
- Footage (`resources/clips/`, gitignored, the repo is public) is used only through `media/`, which is excluded from git (`.git/info/exclude`). Nothing derived from it is committed. Open the files locally to see it.
- Live values stay placeholders: `{price}`, `{lead_days}`. Design names are the ones the admin serves today.

## The three ideas

**r2-a, "השולחן" (the table).** The phone screen is the party table seen from above: three real boards laid edge to edge, real cards scattered on them. You pick cards up, throw them (own physics, inertia and spin) and tap to flip them over; the order button is the board's own finish circle.
Banned-list check: no hero block, no sections, no reveal motion; the only motion is what your finger does. Not seen on template sites: a page you play with like a table, not read.

**r2-b, "שישים שניות" (sixty seconds).** Real footage of a real bachelorette turn, cut into stop-motion frames and scrubbed by your scroll: she acts out a word, the room breaks up laughing. A real clock runs down with the scroll, and the few words on screen are burned in like her friends' Instagram story.
Banned-list check: no layout at all, the footage is the page; no CSS motion, only frames of a real night. Not seen on template sites: scroll as a film scrubber made of the brand's own customers.

**r2-c, "תור" (your turn).** The page is one turn of the game. Tap the deck and a real 60-second clock starts; each tap deals the next real card, swipe right for "got it", left for "pass", and a pawn walks the real board. When time runs out the turn ends on the order.
Banned-list check: no steps to read (you play them), no section stack, a clock that actually runs. Not seen on template sites: the product demo is the product's own game loop, in the visitor's hand.

Dropped before building: "the deck where every card is a screen" (it needs our copy printed on cards, which is a made-up card), and "the letter-mask zoom through footage" (seen on award-site templates).

## Files and how each one moves

| | Page | Committed shots | Local only (`media/`, footage) |
| --- | --- | --- | --- |
| A | `r2-a.html` | `shots/r2-a-{390,1440}{,-fold}.png`, `shots/r2-a-motion-strip.png` | `media/r2-a-motion.mp4` |
| B | `r2-b.html` | none: every frame of it is footage | `media/shots/r2-b-{390,1440}{,-fold}.png`, `media/shots/r2-b-motion-strip.png`, `media/r2-b-motion.mp4` |
| C | `r2-c.html` | `shots/r2-c-{390,1440}{,-fold}.png`, `shots/r2-c-motion-strip.png` | `media/shots/c-end.png` (end of turn with the clip), `media/r2-c-motion.mp4` |

`cards/` holds the real cards cut one by one from the public print sheets in `site/assets/designs/`, the real board's finish circle and top row, and the logo as a pawn. `media/` is rebuilt from `resources/clips/` with ffmpeg (10 fps, 540 px, muted) and is never committed.

- **A** moves only under a finger: drag a card and it turns around the point you hold it by; let go fast and it slides with inertia, spin and a soft bounce off the table's edge; tap flips it to its real back (or front). The pile deals the next real card with a throw. On load one card arrives as if tossed across the table (the same physics, not a CSS entrance).
- **B** moves only with the scroll: 204 real frames at 10 fps drawn to a canvas, so slow scrolling reads as stop-motion; the clock counts 60 to 0 across the turn, the real card rises into the shot while she describes, the real WhatsApp message drops in on the laugh, and the six real decks flick past like a hand-placed flipbook.
- **C** moves with time and the thumb: a real 60-second clock, the top card flips from back to front, swipes past 100 px (or a fast flick) throw it with gravity and spin, shorter drags spring back, and every "got it" moves the pawn one circle along the real board. At zero the turn ends on the real laugh clip and the order.
- Reduced motion: A keeps drag and flip without inertia or the toss; B replaces the scrubber with the key stills, captions and the six decks in a plain column; C keeps the turn with instant flips and no throws.
