# Phase 2, round 17: the illustrations that sat on text, moved just clear of it

`r17.html` is r16 with one change: each illustration that touched text or content moves the smallest distance that clears it at every width of its layout. Everything else is the owner's r16 layout, unchanged. `r17-designs.html` and `r17-faq.html` are r16's, linked to r17; the editor's autosave key is now `dugri-r17-placements`.

## How "just clear" was measured

- **What counts as touching:** the text and the content around it: headings, paragraphs, buttons, the hero panels, the story photos, the designs and the review cards.
- **The drawing's real extent:** the mark's drawn outline over its whole animation (eight phases of its loop). A twinkling star turns 45° at its peak, so a check of the still drawing misses grazes. r16's report measured random frames.
- **Margin:** 3 px.
- **Widths:**
  - phone: 360, 375, 390 and 430, plus 360 and 390 under reduced motion;
  - desktop: 1100, 1280, 1440 and 1920, plus 1100 and 1440 under reduced motion.
- **The move:** the nearest clear spot, searched in 0.1% steps and ranked by distance in px at 390 (phone) or 1440 (desktop). The mark keeps its size and turn.

## Moved (14)

| Layout | Mark | Section | r16 → r17 (x, y %) | Moved | It touched |
| --- | --- | --- | --- | --- | --- |
| Phone | black star | top | 13.7, 63.9 → 13.7, 65.4 | 14 px | the sky panel's edge |
| Phone | popper | designs | 11.5, 7.9 → 11.5, 5 | 23 px | the subtitle |
| Phone | sky star | designs | 9.4, 77.8 → 6.9, 79.9 | 19 px | the grid (reduced motion) |
| Phone | plus | designs | 83, 84.2 → 89.7, 84.2 | 24 px | the button |
| Phone | hourglass | story | 47.6, 19.9 → 37.9, 14 | 57 px | the photos |
| Phone | pink star | story | 61.4, 7.8 → 61.4, 2.5 | 40 px | the heading |
| Phone | black star | story | 58.6, 55 → 58.6, 48.1 | 53 px | "ועלמה" |
| Phone | sky star | story | 23.8, 85.9 → 23.8, 92.8 | 53 px | the second paragraph |
| Desktop | sparkles | top | 18.2, 19 → 18.2, 20.1 | 7 px | the headline |
| Desktop | sky star | top | 35, 53.5 → 35, 51.9 | 11 px | "ומה הקאץ'?" |
| Desktop | plus | designs | 61.4, 84.6 → 62.7, 84.6 | 14 px | the button |
| Desktop | pink star | story | 87.4, 14.2 → 87.4, 1.8 | 71 px | the heading |
| Desktop | sky star | designs | -1, 27.9 → -1, 27.4 | 4 px | the grid (reduced motion) |
| Desktop | sparkles | designs | 7.2, 92.3 → 7.2, 94.6 | 19 px | the grid (reduced motion) |

The story's moves are larger because the story text wraps differently at 360, 390 and 430: a spot clear at one width is on a line at another.

`shots/r17-moves-phone.png` and `shots/r17-moves-desktop.png` show each moved mark before and after, outlined, with the founders' photos blurred from the first frame.

## Left where she put them, for her to decide

**Desktop under reduced motion only.** There the moving strip becomes a static grid of the designs, which is taller and fills the space these marks use. Clearing them would move each far from where she put it:
- popper at 23.4, 13.9: 77 px;
- pink star at 90.3, 22: 141 px;
- pink star at 34.4, 21.8: 153 px;
- sparkles at 101, 9: 33 px.

Another option is to hide the designs section's marks under reduced motion.

**Narrower desktops, 900–1099 px (for example an iPad on its side).** The desktop layout starts at 900 px, but the hero text wraps onto more lines below 1100. A few of her desktop marks touch the hero text, the buttons or the story text there:
- the sky star by "ומה הקאץ'?" would need 165 px to clear at 1024;
- the plus marks and a star in the designs section;
- two story marks, at 900 only.

Options:
- move the desktop layout's start up to 1100;
- give 900–1099 its own placements;
- accept it.

## Checked

Playwright, Chromium and WebKit.

- **Overlaps:** 0 at every width listed above, except the four reduced-motion marks and the narrower desktops described above.
- **r16's own test**, run three times with live animations: 0 overlaps on phone (390, 360, reduced motion) and desktop (1100, 1440).
- **The tapped view** still fits all ten designs at all nine screen sizes.

## Files

| Committed | Local only |
| --- | --- |
| `r17.html`, `r17-designs.html`, `r17-faq.html`, `README-r17.md` | `media/reviews/` |
| `shots/r17-moves-phone.png`, `shots/r17-moves-desktop.png` | |
