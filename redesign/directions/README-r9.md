# Phase 2, round 9: one big line, even cards, the FAQ on its own page (gate D2)

Owner on r8, five notes. Round 9 is `r9.html`, built on r8-a, plus a new `r9-faq.html`. Both use Rubik.

Section order: hero › designs › ממליצים עלינו › our story › footer.

## The notes

0. **האלאנד.** The football-boys design is now named "האלאנד" everywhere (it was "מרקאנה").
1. **The FAQ has its own page.** `r9-faq.html` has our header and footer, the live FAQ verbatim (5 questions, a snapshot of `/api/faq`), and a WhatsApp line. The homepage footer now links "שאלות נפוצות" next to "איסוף עצמי". The FAQ section and its pawn slot are gone from the homepage.
2. **Even card outlines.** See the rule below. `shots/r9-outlines.png` shows all 10 designs, front and back, as the page draws them.
3. **Illustrations on hold.** The empty `<!-- ILLUS:hero|designs|recs|story -->` slots and the `ILLUS:css` / `ILLUS:js` markers are still in `r9.html`, so a chosen icon set can be dropped in the same way `r8-b` was generated.
4. **A hero that isn't a wall of text.**
   - The cards come first: on a phone, the deck is the first thing under the header.
   - Then one big line from her own words: "ומה הקאץ׳?" small above, and "כל המילים עליכם!" huge (Rubik 900, about 53 px on a phone, 96 px on desktop).
   - Then her paragraph, cut into small pieces. Every word of "מתחלקים לקבוצות… הכל נכנס." is still there, in her order.
   - Two variants, switched with `?hero=a` / `?hero=b` or with the small "פתיח א | פתיח ב" pill at the bottom left, which updates the URL:
     - **A, a punchy stack:** the kicker "דוגרי, המתנה הכי אישית", the big line, her list as chips (פדיחות · סיפורים מצחיקים · יריבים מושבעים · אהבה ראשונה · ואפילו אקסים · "- הכל נכנס." in pink), three short numbered lines (מתחלקים לקבוצות / שולפים קלף… / הקבוצה שלכם צריכה לנחש…), and the CTA. On desktop the cards sit beside the words.
     - **B, a Pluto-style poster:** the big line huge and centred (about 62 px on a phone, 132 px on desktop), her list as one sentence under it, the three steps as three numbered mini-cards in a row, and the CTA. On desktop the words come first, centred, with the deck below, like Pluto's hero.

## The card frame rule (for the preview page)

**The goal:** every card shows the same visible frame, from the card's outer edge to its inner panel, as טריפה and סנטוריני do: **42 px on every side of a 400 × 564 card** (10.5% of the width, 7.4% of the height). The black outline (2.5 px) and the slight corner (4% / 2.8%) are drawn by the page and are the same for every card.

**How the frame is measured:**
- The panel colour is the most common colour in the card's lower-middle band (60–78% down, 30–70% across), which avoids the words.
- From each edge, along four lines (40, 50, 60 and 70% of the way across), the first run of 8 px within 34 RGB units of the panel colour marks where the frame ends. The median of the four lines is that side's frame.
- **Sanity checks:** a side outside 6–80 px takes its opposite side's value. If the four sides still disagree by more than 10 px, the reading caught the art, so the card takes its source's typical frame: **45 px for print-template renders, 24 px for deck-sheet cuts.**

**How it is normalised:**
- The panel is kept exactly as printed.
- Each side is cropped where its frame is wider than 42, or widened where it is thinner.
- A widened band is filled with that side's own frame colour (the median of its outer 6 px). It is never a mirror of the art, which would bring the panel's edge back out.
- The result is resized to 400 × 564.

**The per-design values** (sides are left/top/right/bottom in px on the 400 × 564 source; + = widened, − = cropped):

| Design | Card | Source | Frame measured | Change |
| --- | --- | --- | --- | --- |
| פריז (`bachelorette`) | front | sheet | 20/24/21/21 | 28/21/27/24 |
| פריז (`bachelorette`) | back | template | 45/45/45/45 | -4/-4/-4/-4 |
| קליפורניה (`birthday`) | front | template | 48/45/48/46 | -8/-4/-8/-5 |
| קליפורניה (`birthday`) | back | template | 47/44/48/45 | -6/-2/-7/-3 |
| אואזיס (`grapefruit`) | front | sheet | 22/25/23/22 | 25/20/24/23 |
| אואזיס (`grapefruit`) | back | sheet | 24/24/24/24 (default) | 23/21/23/21 |
| סנטוריני (`marriage`) | front | template | 45/45/45/45 (default) | -4/-4/-4/-4 |
| סנטוריני (`marriage`) | back | template | 45/45/45/45 (default) | -4/-4/-4/-4 |
| דני (`daniel`) | front | sheet | 22/24/23/24 | 25/21/24/21 |
| דני (`daniel`) | back | sheet | 24/24/24/24 | 23/21/23/21 |
| טוקיו (`japanese`) | front | template | 46/43/46/43 | -5/-1/-5/-1 |
| טוקיו (`japanese`) | back | sheet | 21/24/22/22 | 26/21/25/23 |
| סיישל (`posttrip`) | front | sheet | 26/29/27/26 | 20/16/19/19 |
| סיישל (`posttrip`) | back | sheet | 28/32/30/32 | 17/12/15/12 |
| האלאנד (`football`) | front | sheet | 24/27/25/25 | 23/18/22/20 |
| האלאנד (`football`) | back | sheet | 28/31/29/28 | 18/13/17/16 |
| טריפה (`tarifa`) | front | template | 44/41/44/42 | -3/1/-3/0 |
| טריפה (`tarifa`) | back | template | 41/38/44/40 | 1/5/-2/3 |
| ברוקלין (`kids`) | front | template | 47/44/47/44 | -6/-2/-6/-2 |
| ברוקלין (`kids`) | back | sheet | 28/31/28/27 | 18/13/18/17 |

All 84 cards (every front and back) are processed the same way. Each one's values are in `cards9/frames.json`, and the scripts are `cards9/frame.py` (measure) and `cards9/norm.py` (normalise). Re-measured after normalising, every reliably measured card is 42 ± 1 px on all four sides.

The "default" rows are cards whose frame is too close to the panel colour to measure: סנטוריני's line-drawing border, and the full-pattern backs of אואזיס and דני. They take their source's typical frame.

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r9.html`, `r9-faq.html`, `README-r9.md` | `media/r9-motion.mp4` |
| `cards9/` (all cards, even frames), plus `frames.json`, `frame.py` and `norm.py` | |
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
