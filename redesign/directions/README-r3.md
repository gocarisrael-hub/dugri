# Phase 2, round 3: one layout, two colour worlds (gate D2)

Owner feedback on round 2: r2-a ("the table") is the favourite, but the board background goes and the scattered cards are too chaotic. The touch/drag/flip interaction stays as the hero. Style reference: pluto.security ("nostalgic but new").

r3-a and r3-b are the same page. They differ only in the `THEME:START`…`THEME:END` block at the top of the CSS (`r3-b.html` is generated from `r3-a.html` by swapping that block), so the owner compares colour alone.

- **r3-a, "Pluto colours":** salmon `#ffb89f`, lemon `#ffe45c`, cream `#fff4de` fields, black outlines and type, black pills.
- **r3-b, "Dugri colours":** white, the site's sand `#f4efe6` and beige `#ece3d5` (tokens.css), and the logo's pink `#ea4795` (sampled from `site/assets/logo-pink-original.png`) as the only accent. Pink carries black text only (5.1:1). White on pink fails AA, so the page never uses it.

## Shared language

- Display and body: **Rubik** (900 headlines, 800 stickers and pills, 400 body). Unbounded has no Hebrew. Of the Hebrew candidates (`shots/r3-fonts.png`: Fredoka, Rubik, Secular One, Suez One, Playpen Sans Hebrew), Rubik 900 is the closest to Unbounded's wide, chunky weight. All of them are OFL Google Fonts.
- 3px black outlines, sticker labels with a hard offset shadow (thrown toward the RTL reading start), black pill buttons, outlined four-point sparkles.
- Only real objects: the card fronts and backs in `cards/`, the logo pawn, the logo.

## The page

1. **Hero:** "המתנה הכי אישית" sticker, the lead "משחק מסיבה על אדם אחד.", and a bachelorette / 70th-birthday switch with equal weight. Then one tidy stack of the eight real cards of that deck. Drag the top card: it turns around the point you hold it by. Throw it and it flies off and tucks under the stack. A short drag springs back, a tap flips it to its real back. The "flip" and "next card" buttons and the keyboard (Enter flips, arrows deal) do the same things. A counter shows which card is on top.
2. **Who:** the two occasions as equal tiles (each one switches the hero deck and scrolls back to it), with the smaller occasions as chips.
3. **How:** the 60-second rule, then three stops on a dashed board track. The logo pawn walks to the stop you tap.
4. **Designs + order:** the six real designs back up in a tidy grid with name stickers (tap flips to a real front), the order pill and `{price}`.

Live values stay placeholders: `{price}`, `{lead_days}`. Reduced motion keeps drag, flip and deal without the throw, the deal-in or the pawn hop.

## Files

| | Page | Committed shots | Local only (`media/`) |
| --- | --- | --- | --- |
| A | `r3-a.html` | `shots/r3-a.png` (390×844 fold), `shots/r3-a-full.png` | `media/r3-a-motion.mp4` |
| B | `r3-b.html` | `shots/r3-b.png`, `shots/r3-b-full.png` | `media/r3-b-motion.mp4` |

The videos are scripted Playwright runs at 390×844 (drag and spring back, two throws, tap flip, next card, the birthday deck, the pawn track, design flips, a tile back to the deck, the keyboard).
