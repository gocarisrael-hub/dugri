# Phase 2, round 5: the deck on the side, thrown across (gate D2)

Owner on round 4: she "really likes the C option from yesterday" (r2-c, "תור"): "the deck on the side, throwing the card to another side of the screen. Less organised, but not messy."

r5-a (Pluto colours) and r5-b (Dugri colours) are one page, as before: only the THEME block differs. The designs section (lean strip + colour flood) carries over from round 4 unchanged, and so do Rubik 900, the stickers, pills and outlines.

## Hero

- **The deck sits on the right**, the inline start in RTL. Twelve real cards lie face down, every design twice, never the same design twice in a row, and the back on top matches the card under it. I tried both sides (`?side=left` mirrors the hero; `shots/r5-side-compare.png` shows right then left). On the right, the throw follows the reading direction and the card lands where the eye goes next, so the right wins.
- **Tap flips** the top card face up on the deck with a small lift. Dragging it more than a few px deals it face up as well.
- **The throw** uses r2-c's rule: past 100 px or a fast flick, the card is thrown. A shorter drag springs back onto the deck. A second tap (or "להפוך קלף" pressed again, or Enter) throws it with a default flick.
  - **Flight:** the card flies across on a parabola. Harder flicks go higher (it scales up at the top of the arc to read as height) and spin. A hard flick, or about one throw in six, adds a full turn. When it touches down it slides on with inertia.
- **"Less organised, but not messy":** cards land anywhere in a loose zone on the left, outlined by a faint dashed edge. They land at angles up to ±34° and overlap at different spots, nudged toward where you flicked. At most seven stay on the table: the oldest slides out of the zone and fades. A sticker names the design that just landed.
- **When the deck runs out**, the table sweeps back to the deck face down and the deck riffles. "לערבב", the occasion tab and the who tiles do the same, and the tab makes its occasion the next card.
- **Reduced motion:** flips crossfade, a throw places the card in the zone with a fade, the spring-back is instant and there is no riffle.

## The 60-second clock and the pawn

They stay in how-it-works, not the hero. The hero now has exactly one thing to do (flip, throw), and a running clock next to it would compete with the card for the thumb. The clock in how-it-works is now live: tap it and it counts 60 to 0 (black from 10). The pawn still walks the three steps.

## Files

| | Page | Committed shots | Local only (`media/`) |
| --- | --- | --- | --- |
| A | `r5-a.html` | `shots/r5-a.png` (390×844, seven cards thrown, the eighth flipped), `shots/r5-a-full.png` | `media/r5-a-motion.mp4` |
| B | `r5-b.html` | `shots/r5-b.png`, `shots/r5-b-full.png` | `media/r5-b-motion.mp4` |
| | | `shots/r5-side-compare.png` (deck right vs deck left) | |
