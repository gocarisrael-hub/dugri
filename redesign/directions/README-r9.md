# Phase 2, round 9: one big line, even cards, the FAQ on its own page (gate D2)

Owner on r8, five notes. Round 9 is `r9.html`, built on r8-a, plus a new `r9-faq.html`. Both use Rubik.

Section order: hero › designs › ממליצים עלינו › our story › footer.

## The notes

0. **האלאנד.** The football-boys design is now named "האלאנד" everywhere (it was "מרקאנה").
1. **The FAQ has its own page.** `r9-faq.html` has our header and footer, the live FAQ verbatim (5 questions, a snapshot of `/api/faq`), and a WhatsApp line. The homepage footer now links "שאלות נפוצות" next to "איסוף עצמי". The FAQ section and its pawn slot are gone from the homepage.
2. **Even card outlines.** The shared preview rule, below.
3. **Illustrations on hold.** The empty `<!-- ILLUS:hero|designs|recs|story -->` slots and the `ILLUS:css` / `ILLUS:js` markers are still in `r9.html`, so a chosen icon set can be dropped in the same way `r8-b` was generated.
4. **A hero that isn't a wall of text.**
   - The cards come first: on a phone, the deck is the first thing under the header.
   - Then one big line from her own words: "ומה הקאץ׳?" small above, and "כל המילים עליכם!" huge (Rubik 900, about 53 px on a phone, 96 px on desktop).
   - Then her paragraph, cut into small pieces. Every word of "מתחלקים לקבוצות… הכל נכנס." is still there, in her order.
   - Two variants, switched with `?hero=a` / `?hero=b` or with the small "פתיח א | פתיח ב" pill at the bottom left, which updates the URL:
     - **A, a punchy stack:** the kicker "דוגרי, המתנה הכי אישית", the big line, her list as chips (פדיחות · סיפורים מצחיקים · יריבים מושבעים · אהבה ראשונה · ואפילו אקסים · "- הכל נכנס." in pink), three short numbered lines (מתחלקים לקבוצות / שולפים קלף… / הקבוצה שלכם צריכה לנחש…), and the CTA. On desktop the cards sit beside the words.
     - **B, a Pluto-style poster:** the big line huge and centred (about 62 px on a phone, 132 px on desktop), her list as one sentence under it, the three steps as three numbered mini-cards in a row, and the CTA. On desktop the words come first, centred, with the deck below, like Pluto's hero.

## The card frame rule (shared with the design preview)

r9 uses the preview helper's cards as they are, so the page matches the preview the owner is reviewing. The rule, quoted in full with per-card values in `cards9/outline-rules.txt` (a copy of `.design-preview/outline-rules.txt`):

- **Target frame:** card edge to the outer edge of the inner art panel = **10.78% of the card width**, taken from סנטוריני and טריפה. Those two, and every card already within 9.8–12.3%, are left exactly as printed.
- **Thin frames** (פריז, סיישל, דני, האלאנד and אואזיס fronts; the טוקיו, ברוקלין, סיישל, דני, האלאנד and אואזיס backs, all measured about 4%): the panel is cut out with a rounded mask (52 px radius at 400 px, the template corner) and laid on a flat card of the design's frame colour, sized so the side frame is exactly the target. The card stays 400 × 564. For האלאנד and אואזיס this drops the printed decoration in the frame (footballs, grapefruit slices).
- **No trimming:** no printed frame is thicker than target + tolerance.
- **Display:** every card gets the same shape on the page: corner radius 6% / 4.26% and a 1.5 px solid black border. In r9 this is `--rad: 6% / 4.26%` and `outline: 1.5px` on the deck, the table cards, the strip and the flood.
- **Boards:** `boards9/` holds the preview's boards, so they match too.

`shots/r9-outlines.png` shows all 10 designs, front and back, as r9 draws them.

(My first pass at this note used my own measurement, a 42 px target with an un-masked panel. It is superseded by the shared rule above; its files are gone from `cards9/` (still in history at 7350ee2).)

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r9.html`, `r9-faq.html`, `README-r9.md` | `media/r9-motion.mp4` |
| `cards9/` (the preview's 55 cards) and `cards9/outline-rules.txt`, `boards9/` (the preview's 10 boards) | |
| `shots/r9-a.png`, `r9-b.png` (phone hero), `r9-a-desktop.png`, `r9-b-desktop.png`, `r9-full.png` (story photos blurred) | |
| `shots/r9-outlines.png`, `r9-flood.png` (האלאנד), `r9-faq.png`, `r9-faq-desktop.png` | |

## Checked

Playwright on `r9.html` and `r9.html?hero=b`, at 390×844 with touch, 1440×900 with mouse, and 390×844 with reduced motion:

- No page errors.
- The FAQ is off the homepage, and the footer links `r9-faq.html`.
- The design names include האלאנד and no longer מרקאנה.
- On a phone the deck sits above the headline in both variants.
- The pile stays tight; drag follows the finger with 0 px drift, then glides; a tap flips.
- The floods load the board and both cards.
- The phone review band has no overlaps and stays on screen.
- The story photos don't overlap.
- `r9-faq.html` loads with no errors.

Every committed shot is blurred from its first frame.
