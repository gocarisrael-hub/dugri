# Phase 2, round 8: the whole printed card, the live art, and calm (gate D2)

Owner on r7, seven notes. Round 8 is two files, both in Rubik:

- `r8-a.html`: all the fixes.
- `r8-b.html`: r8-a plus illustrations (note 7).

`r8-b` is generated from `r8-a` by `gen_b8.py`, which fills only the `ILLUS` slots. Everything else is byte-identical.

Section order: hero › designs › ממליצים עלינו › our story › questions › footer.

## Live art for every design (integrator, during the round)

ברוקלין showed old art. Template artwork lives on the production volume and overrides the repo, so r8 takes nothing from `site/assets/designs/` any more. Everything comes from what dugri-israel.co.il serves today, through public read-only GETs:

| Design | Cards | Board |
| --- | --- | --- |
| קליפורניה, סנטוריני, טוקיו, ברוקלין | the live print template (`/api/template-image/<theme>/front`, `/back`). One sample front each; the uploaded deck sheets hold older art (ברוקלין's sheet has a red frame where the template has blue, קליפורניה's lacks the fortune-teller, טוקיו's koi differ). טוקיו and ברוקלין have no template back, so their back is the live deck sheet's. | the template board |
| פריז | its live deck sheet's 8 fronts (the template matches it); the template back | the template board |
| סיישל, אואזיס, דני, מרקאנה | their live deck sheets (`/api/design-images` `deckFronts` / `deckBacks`), 8 fronts each. סיישל's template isn't public. The custom designs' sheets match their templates. | the live `deckBoard` |
| טריפה | the live template renders (it has no deck sheets) | the live `deckBoard` |

Every design now has a board and a back, so מרקאנה now has a back too, and the hero deck deals all 10 designs. A design with one sample front deals that front.

## The 7 notes

1. **"איך זה עובד" is gone:** the 60-seconds box, the steps and the dashed track, with their CSS and JS.
2. **No sticker look, and no dashed slot:**
   - The pink tilted label with a hard shadow is gone everywhere. The hero line "דוגרי, המתנה הכי אישית" is now plain bold text with a thin rule under it.
   - Labels (design names, "הסיפור שלנו", "לגעת בחפיסה") are flat, upright, thin-outlined pills with no shadow and no fill colour.
   - "הדר ועלמה" is a handwritten signature in Gveret Levin, not a label.
   - The dashed outline round the deck spot is removed.
3. **The whole printed card:**
   - Every card is cut at its print sheet's cut lines (`cards8/`), so it keeps its own printed frame: פריז's light-pink edge, קליפורניה's orange, טוקיו's black, ברוקלין's blue, סנטוריני's line-drawing border, סיישל's pale yellow.
   - The four custom designs are their full edge-to-edge art, no longer center-cropped by 7 px a side.
   - The cards use the print cell's own ratio (400×564) and only a slight cut corner (4% / 2.8%), so nothing is rounded into the art.
   - `shots/r8-outlines.png` puts all 10 side by side: on top, r8 as rendered; below, the live product photo the site shows today. Every printed frame is there.
4. **Reviews on a phone, the Pluto cut:** a 640-px oval wider than the 390-px screen, with only its middle band on screen and the name plate on top.
   - On it: the two logos and four short quotes. The other four quotes show on desktop only.
   - Desktop is unchanged.
   - Measured on a phone: 6 pills, none overlapping, all on screen, all inside the oval.
5. **Story:**
   - The prints now sit side by side with a gap, so neither covers the other. The childhood photo is on the right and fully visible, both kids included (0 px² of photo overlap on a phone and on desktop).
   - The drift is smaller: about 2 px and half a degree, over 15–19 s.
6. **No pickup box.** The FAQ stays, full width; self-pickup is only the footer link (to the live pickup page).
7. **r8-b illustrations:** inline SVG, black 2.2-px line, flat fills from our palette.
   - **Hero:** a little flag planted in a card stack, with "דוגרי" on it; the flag waves.
   - **Designs:** a party hat whose confetti drifts.
   - **Story:** an hourglass that drains slowly and turns over every 14 s.
   - **FAQ:** a pawn that hops once when it comes into view.
   - **Margins:** thin "+" crosses and 4-point sparkles that twinkle and turn slowly.
   - **Scroll:** the big illustrations shift a few px with the scroll (parallax).
   - **Reduced motion:** everything still, with the SVG animations paused.
   - **Placement:** each piece sits in empty margin. Measured against the real text lines, pills, cards and prints, nothing covers content on a phone or on desktop; the only contacts are a sparkle brushing a moving hero card and a 2-px graze under reduced motion.

## Privacy fix

The round-7 phone shot `shots/r7-recs.png` (pushed in 70b7f59) showed the founders' photos unblurred at its bottom edge. The blur had been applied only to the full-page shot. This commit replaces it with a blurred version, and every committed r8 shot is now blurred from the first frame. **The unblurred version is still in the branch history at 70b7f59**, and removing it from there means rewriting `feat/redesign` (a force-push). That is left to the owner.

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r8-a.html`, `r8-b.html`, `README-r8.md` | `media/r8-b-motion.mp4` (390×844 touch, with the illustrations) |
| `cards8/` (all cards, live art), `boards8/` (all 10 boards, live art) | `media/r8-sheet.png`, `media/r8-story.png` (photos unblurred) |
| `shots/r8-outlines.png` | |
| `shots/r8-a.png`, `r8-b.png`, `r8-a-desktop.png`, `r8-b-desktop.png`, `r8-a-full.png`, `r8-b-full.png` | |
| `shots/r8-designs.png`, `r8-flood.png` (טוקיו), `r8-flood-desktop.png` (טריפה), `r8-recs.png`, `r8-recs-desktop.png`, `r8-faq.png` | |
| `shots/r7-recs.png` (replaced, blurred) | |

## Checked

Playwright on both files, at 390×844 with touch, 1440×900 with mouse, and 390×844 with touch and reduced motion:

- No page errors.
- There is no how-it-works section, pickup box, dashed slot or pink sticker, and the footer has the pickup link.
- The pile stays tight.
- Touch and mouse drags follow the finger with 0 px drift, glide, then settle.
- A tap flips a card.
- The floods for פריז, ברוקלין and טריפה load the board and both cards, and fit.
- The phone review band holds 6 pills: none overlapping, none off screen, none outside the oval.
- The sheet opens with its `{שם} · {תאריך}` caption.
- The story photos have 0 overlap.
- r8-b: the pawn hops once, the flag animates, and everything is still under reduced motion.
