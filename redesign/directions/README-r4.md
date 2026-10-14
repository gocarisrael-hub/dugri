# Phase 2, round 4: the face-down deck and the colour flood (gate D2)

Owner on round 3: "not good". She asked for a face-down deck that flips a card over on every touch, a DIFFERENT design on each one, "like a pretty organised mess", "a little bit crazier, but organised". For the designs section she asked for a "special crazy animation" for moving between designs: scrollable, and maybe touching one turns the whole screen that design's colour.

As in round 3, r4-a (Pluto colours) and r4-b (Dugri colours) are one page. Only the THEME block differs, and `r4-b.html` is generated from `r4-a.html`. Rubik 900, the stickers, pills and outlines, the occasion tab and the who/how sections carry over from round 3.

## Hero: two piles

- **The deck** is a face-down pile of twelve real cards, every design twice. Each card sits a few px and degrees off true, so it's one clear pile, a little messy. The back on top is always the back of the card about to flip.
- **A tap** (or "להפוך קלף", or Enter) lifts the top card with a tilt and flips it in the air. It overshoots the landing and bounces onto the face-up pile beside the deck, at its own small random angle and offset. About one card in five turns a full circle on the way. A sticker under the pile names the design.
- **Never the same design twice in a row**, including across a reshuffle. Within a design, the front shown changes each time (no repeat among its last five).
- **Drag** the top face-up card and throw it off the table. A short drag springs back.
- **When the deck runs out**, every card, thrown ones included, flies home face down. The deck then riffles: two halves split and interleave. "לערבב" does the same at any time. The occasion tab and the who tiles reshuffle so that occasion's design is the next card.
- **Reduced motion:** a card crossfades onto the pile. The reshuffle is a fade.

## Designs: the strip and the flood

- **The strip** is a horizontal scroll-snap row of the six designs, one big card centred with its neighbours peeking. The cards lean and tilt with scroll velocity, so a harder swipe means a harder lean. A spring brings them back upright, overshooting a little.
- **The section colour** cross-fades between the neighbouring designs' colours as you scroll. That's six stacked colour layers, opacity only. Each colour is the dominant colour sampled from that design's real card. Text turns white where black would fail AA (סנטוריני, טוקיו).
- **The flood:** a tap grows a circle (clip-path) from your finger until the whole screen is that design's colour. The tapped card flies to the centre and its seven other real fronts fan out behind it like a hand of cards. The design name, `{price}` and an order pill sit below. Tap outside the cards, swipe down, press Escape or ✕ to close: the fan folds back, the card returns to its place in the strip, the circle shrinks into it, and focus goes back to that card.
- **Reduced motion:** a static 3×2 grid on the section colour, and a plain fade for the flood.

Motion is transform and opacity throughout, plus clip-path for the flood.

## Files

| | Page | Committed shots | Local only (`media/`) |
| --- | --- | --- | --- |
| A | `r4-a.html` | `shots/r4-a.png` (390×844, after five flips), `shots/r4-a-full.png`, `shots/r4-a-flood.png` | `media/r4-a-motion.mp4` |
| B | `r4-b.html` | `shots/r4-b.png`, `shots/r4-b-full.png`, `shots/r4-b-flood.png` | `media/r4-b-motion.mp4` |
