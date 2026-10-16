# Phase 2, round 16: no price line under the designs, a Pluto-style form, the owner's new placements (gate D2)

`r16.html` is r15 with the owner's round-16 notes. `r16-designs.html` shows every design's tapped view, and `r16-faq.html` is r15's FAQ page linked to r16. Everything not listed here is r15 (the editor's autosave key is now `dugri-r16-placements`).

## 1. The price line under the designs is gone

"חפיסה ולוח: {price}" no longer appears under the designs strip, and its style is gone with it. The tapped design view keeps its own price. It appeared nowhere else on the page.

## 2. The form, in Pluto's form language

- **Fields:** fully rounded pill fields, 50 px tall, with a thin 1.5 px ink line, 22 px inside padding, a white fill and 16 px text.
- **Labels:** a bold label above each field, 700 weight, with a small asterisk in the logo pink `#ea4795` on each required field. The asterisk is hidden from screen readers, because the fields carry `required`.
- **Layout:** on screens 600 px wide and up, שם and חברה share a row, and טלפון takes the full width under them. On a phone the three are stacked.
- **Button:** "שלחו" is our pill CTA, with the drawn forward arrow, start-aligned under the fields.
- **Errors:** each error sits under its field, indented to the field's text.
- **Unchanged:** the validation, the thank-you state and the note that the live version needs an endpoint (README-r15).

**Fixed (it shipped in r15):** the phone error's example number read backwards, "4567-123-054". The non-breaking hyphens I used in r15 are bidi-neutral, so the right-to-left line reordered the digit groups. The number is now isolated left-to-right, and it reads "054-123-4567" in Chromium and WebKit.

## 3. Her new placements, verbatim

`PLACEMENTS` is the owner's JSON from 2026-10-16 exactly as sent: 15 items on a phone and 23 on desktop, including the x values of -1 and 101.

**The -1 and 101 items:** x is a percentage of the content column, so these sit just past the column's edge.
- On a phone, and on desktop below about 1100 px, they reach the screen edge and are cut there by their section.
- On wide desktops (1440 and up) the margins beside the column leave room, so they sit fully in view beside the content.
- **Horizontal scroll:** none at 360, 390, 430, 900, 1100, 1440 or 1920, with and without `#place`, in Chromium and WebKit (28 of 28). The page width equals the screen width, and a sideways scroll attempt moves nothing at any depth of the page.

**Overlaps with text or content, reported and not moved:**

Phone (390, 360 and reduced motion):
- `popper order 11.5, 7.9` on the designs subtitle "כל עיצוב מתאים לכל חגיגה".
- `cross order 83, 84.2` on the designs button "בונים את המשחק". The price line under it is gone, so the section is shorter and her % position now lands on the button.
- `glass story 47.6, 19.9` over the two story photos.
- `pstar story 61.4, 7.8` on the heading "איך דוגרי נולד" (as since r13).
- `star story 58.6, 55` on "ועלמה" in the first paragraph (as since r13).
- `bstar story 23.8, 85.9` on the second paragraph "מאז הפכנו את זה".
- `star top 13.7, 63.9` on the edge of the sky panel (390 only).
- `bstar order 9.4, 77.8` on the static designs grid, under reduced motion only.

Desktop (1100 and 1440):
- `sparks top 18.2, 19` at the end of the headline "דוגרי, המשחק".
- `bstar top 35, 53.5` on "ומה הקאץ'?" / "כל המילים עליכם!".
- `cross order 61.4, 84.6` on the designs button.
- `pstar story 87.4, 14.2` on the heading "איך דוגרי נולד".

## Checked

Playwright, Chromium and WebKit.

- **No page errors.** The price line is gone at every width.
- **Form:**
  - Pill radius on every field; 50 px tall; labels 700; three pink asterisks; "שלחו" with the arrow.
  - Name and company share a row from 600 px up, with the phone full width below (640 px wide against 312 px each on desktop); stacked on a phone.
  - Validation passes: an empty send flags all three fields; a bad phone flags only the phone; the phone cases are as in r15; a valid send shows the thank-you.
- **Tapped view:** it fits all ten designs at 390×844, 375×667, 390×700, 360×740, 430×932, 1440×900, 1100×800, 1280×720 and 1024×700, with at least 19 px between the cards and the name.
- **Illustrations:**
  - The editor shows her 15 and 23 and works by mouse and by touch; the review row stays still under a resting finger.
  - 0 dealt cards on the hero text.
- **Floating controls** are clear in 30 of 30 cases.
- **Unchanged from r15 and still passing:**
  - fields and waves, with 0 px seams;
  - the logos;
  - the menu;
  - the M PLUS body font;
  - the designs page: 10 views and no broken images.

impeccable's detector reports the same accepted findings as r15.

## Before anything ships

- Remove the testing switch `#fields`, keeping the chosen field.
- Give the form a real endpoint (README-r15, section 3).

## Files

| Committed | Local only |
| --- | --- |
| `r16.html`, `r16-designs.html`, `r16-faq.html`, `README-r16.md` | `media/reviews/` |
| `shots/r16*.png` (the founders' photos blurred from the first frame) | |
