# Phase 2, round 7: beige, compact, in our own words (gate D2)

Owner on r6: "nice job", with 12 notes. Round 7 is two files that differ only in type:

- `r7-a.html`: Rubik, as before.
- `r7-b.html`: the live site's typefaces. Heebo Light headings, tracked 0.1em (tokens.css `--h-weight: 300`, `--h-spacing: 0.1em`); Heebo 800 buttons, like the site's `.btn`; Assistant body text. The fonts are the site's own variable files from `site/assets/fonts/`.

`r7-b` is generated from `r7-a` by `gen_b.py`, which swaps only the FONTLINK and FONT blocks. Everything after `FONT:END` is byte-identical.

Section order: hero › designs › how it works › recommendations › our story › questions + self-pickup › footer.

## The 12 notes

1. **Beige page.** The page ground is the live site's sand, `tokens.css --section` `#f4efe6`, and the alternate sections use `--accent-tint` `#ece3d5`. Stickers, pills and boxes stay white.
2. **The occasion tab is gone,** with its styles and code.
3. **Hero deck, between r3 and r6:**
   - The deck sits on the right, and each deal is one short toss onto a loose pile just to its left (jitter about ±13% of a card, rotation ±13°, an occasional full turn). At most 6 cards on a phone, 7 on desktop; the oldest slides off.
   - The table is about 1.2 card heights tall: 260 px on a 390-px phone, down from about 415.
   - **Less stuck:**
     - A held card follows the finger exactly. Every coalesced touch point is applied, and the measured finger-to-card offset stayed at 0 px through a 20-step drag.
     - On release the card keeps the speed of the last 100 ms instead of the last 6 samples. A finger that stopped before letting go puts the card down where it is.
     - The lift eases back instead of snapping.
     - Image drag is off (`draggable="false"`, with no pointer events on the images), so a browser's native image drag can't grab a card.
     - Lost pointer capture always releases the card.
     - Cards may hang about 45% over the table's edges before the soft walls push back.
   - Checked with real touch events (CDP touchStart/Move/End): a fling glides 90–140 px and settles.
4. **Our language.** Every button and label now uses the live site's wording:
   - "הזמינו עכשיו" (the header).
   - "בונים את המשחק ›" (the hero, the strip and the flood).
   - "יש שאלה? דברו איתנו בוואטסאפ".
   - The headings "העיצובים שלנו", "איך זה עובד", "איך דוגרי נולד" and "שאלות נפוצות", with "כל עיצוב מתאים לכל חגיגה - את הכותרת אתם כותבים" under the designs heading.
   - Footer links "תקנון ותנאי שימוש" and "איסוף עצמי".
   - The how-it-works lines come from the site's own sentences: the marquee ("מפעילים את הטיימר. מנחשים מילים. כל המילים עליכם."), the products line, and the FAQ's ordering answer.
   - "ממליצים עלינו" stays because the owner asked for it.
5. **The old font:** `r7-b`.
6. **Pastel strip.** Each design's background is its sampled colour lifted 62% toward white, so the hue is the same but much lighter. The flood uses the same pastel. The colour morph across the endless wrap is unchanged.
7. **One outline for every card.** The six original card images keep a white wedge between their printed rounded corner (up to 56 px on a 400 px card) and our 26 px rounding, so the black outline looked detached. Every card now uses the printed corner (`--rad: 14% / 9.7%`), so the outline sits on the card's real edge for all ten designs. The images are unchanged.
8. **Tap a design:** a pastel flood. The design's real board drops onto the table, the tapped card flies from the strip onto it, and the back slides out from under it.
   - Boards come from `site/assets/designs/*/gallery-board.webp` for the 5 built-ins that ship one. For דני, מרקאנה and טריפה, I rendered `boards/*.webp` from the live `/api/template-image/<id>/board`.
   - ברוקלין and אואזיס ship no board, so they show front and back side by side, larger.
9. **Reviews on a phone:** the oval becomes a low stadium (229 px tall, where r6 stacked all ten pills down the page), with one swipe row of pills clipped to its curve, logos first. Desktop keeps the oval with fixed spots.
   - Each quote's caption is now `<small data-edit="index-review-N-caption">{שם} · {תאריך}</small>`, editable in the content editor. The sheet shows the same caption under the screenshot.
   - Note: the text "נלקח מאירוע אמיתי" doesn't exist in r6 or on the live site. I read the note as the caption under each review and replaced the occasion line with this field.
10. **The game first.** The hero opens with the live site's "מה זה דוגרי?" text (index-about-body), verbatim, with "ומה הקאץ׳? כל המילים עליכם!" marked in pink. A small sticker h1 "דוגרי, המתנה הכי אישית" sits above it, and the CTA below. On a phone, the compact deck follows; on desktop it sits beside the text.
11. **Story photos:** no captions and no interaction (no tabindex, no drag). Each print drifts very slowly on its own timing (13 s and 17 s, a few px and about 1°). Reduced motion keeps them still.
12. **Questions + self-pickup at the bottom:**
    - The FAQ is a snapshot of the live `/api/faq`, verbatim, as open/close rows.
    - Beside it (below it on a phone) is a self-pickup box from `site/pickup.html`: the "wait for our message" note, the address, the hours, what to bring, and a "איסוף עצמי ›" pill to the live pickup page.
    - **Mismatch to fix in the admin:** pickup.html says Sun–Wed 9:00–16:30 and Thu 9:00–15:30, but the live FAQ answer says "בימים א׳-ה׳ בין השעות 9:00-16:00". The box follows pickup.html.

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r7-a.html`, `r7-b.html`, `README-r7.md` | `media/r7-motion.mp4` (390×844 touch: deals, a corner fling, a slow slide, the strip, a flood with its board, the review row, the story, the FAQ) |
| `boards/daniel.webp`, `boards/football.webp`, `boards/tarifa.webp` | `media/r7-sheet.png`, `media/r7-story.png` (photos unblurred) |
| `shots/r7-a.png`, `r7-b.png` (phone fold), `r7-a-desktop.png`, `r7-b-desktop.png` | `media/reviews/` (redacted crops, from round 6) |
| `shots/r7-a-full.png`, `r7-b-full.png` (story photos blurred) | |
| `shots/r7-designs.png`, `r7-flood.png` (טוקיו with its board), `r7-flood-noboard.png` (אואזיס), `r7-flood-desktop.png` (טריפה) | |
| `shots/r7-recs.png` (phone row), `r7-recs-desktop.png`, `r7-faq.png` | |

## Checked

Playwright on both files, at 390×844 with touch, 1440×900 with mouse, and 390×844 with touch and reduced motion:

- No page errors.
- The page background is #f4efe6 and there is no `.tabs`.
- 7 deals keep the pile within about 30×25 px.
- A touch or mouse drag follows the finger with 0 px drift, then glides and settles.
- A tap flips a card.
- The floods for פריז, ברוקלין and טריפה load every image and fit above the name.
- The review row scrolls on a phone and is fixed spots on desktop.
- All 8 captions are `data-edit` fields.
- The sheet opens and shows the caption.
- The story prints have no captions, are not interactive, and drift (still under reduced motion).
