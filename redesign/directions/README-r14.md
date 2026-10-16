# Phase 2, round 14: locked headings, body fonts, story first, a wave, a new menu icon, one sharper tapped view (gate D2)

`r14.html` is r13 with the owner's round-14 notes. `r14-designs.html` shows every design's tapped view, and `r14-faq.html` is r13's FAQ page linked to r14. Everything not listed here is r13, including Alma's illustration placements, which are kept as she placed them (the editor's autosave key is now `dugri-r14-placements`).

## 0. Locked: the headings

- **Font:** Gveret Levin (r13 font 18) for the hero headline, the section titles, the tapped view's name and "כל המילים עליכם!". Its one real weight is 400. Its Latin letters and digits come from the body font.
- **Treatment:** r13 title 2, "צל ורוד": ink with a soft `#ff7aa9` offset of 0.04em.
- **Removed:** the title switch and the other nine treatments.
- **FAQ page:** the same headings, so the menu's "שאלות נפוצות" link doesn't land on the old look.

## 1. Body fonts: `#body=1` … `#body=10`

The font chooser is replaced by a dashed ‹ name › switch at the bottom right, while testing. It changes `#body=N` and keeps `#place`.

The chosen font sets all the text that isn't a heading: running text, the panels, labels, buttons, prices, the menu and the review cards. The headings stay Gveret in every option.

| # | Font | Buttons / labels | Prices |
| --- | --- | --- | --- |
| 1 | Rubik (now) | 800 | 900 |
| 2 | Heebo | 800 | 900 |
| 3 | Assistant | 800 | 800 |
| 4 | Varela Round | 400 | 400 |
| 5 | Alef | 700 | 700 |
| 6 | IBM Plex Sans Hebrew | 600 | 700 |
| 7 | Noto Sans Hebrew | 800 | 900 |
| 8 | M PLUS Rounded 1c | 800 | 900 |
| 9 | Fredoka | 600 | 700 |
| 10 | Playpen Sans Hebrew | 700 | 800 |

- **Hebrew-first size:** at the same font size, the Hebrew letters differ by up to 15% between these fonts (Alef and M PLUS draw small, IBM Plex draws large). Each font gets a `size-adjust` that brings its Hebrew letter height to Rubik's at the same size. The height was measured as the median top of בהכמםסשנ at 100 px; Chromium and WebKit agree. The reading size stays 17 px for running text.
- **Real weights only:** `font-synthesis` is off, and only the weights each family really has are used. Varela Round has only 400, so in option 4 the bold lead of the sky panel and the coloured words in the pink panel are not bold. That is the font, not a bug.
- **Playpen Sans Hebrew** (the live site's) draws Hebrew in handwritten script letters (ktav yad). It reads as a hand, next to a hand-drawn heading.
- **Loading:** the faces are Google Fonts' own files, Hebrew and Latin subsets, under the aliases `b1`…`b10`. A face downloads only when it is used.

`shots/r14-body-fonts.png` shows the hero in all ten.

## 2. Order

"איך דוגרי נולד" now comes before "ממליצים עלינו". The page order is the hero, the designs, the story, the wave, the reviews, then business enquiries. The menu lists them in that order too.

## 3. The wave

One line between the story and the reviews, like Pluto's boundary between its two fields, but only the line, with no colour fields.
- **Shape:** a single smooth S across the full width.
- **Colour and weight:** the palette pink `#ff7aa9`, 2 px at every width (the stroke doesn't scale with the box).
- **Height:** 44 px on a phone, up to 96 px on desktop.
- **Accessibility:** decorative and hidden from screen readers.

## 4. The small line

"דוגרי · הדר ועלמה" is gone from the footer of r14, the FAQ page and the designs page. The story's handwritten signature "הדר ועלמה" stays.

## 5. The menu icon

The square box is gone. `shots/r14-menu-icons.png` shows three variants, closed and open:

- **א (shipped):** three right-aligned lines of 20, 13 and 8, with rounded caps, ink with a pink middle line. Under the pointer or keyboard focus, the shorter lines grow a little. On open, the sheet's ✕ is the same icon on the same spot: the two ink lines grow and cross, and the pink one shrinks away.
- **ב:** two ink lines and a pink dot ("=•"); the dot sinks into the centre of the ✕.
- **ג:** the middle line is a pink wave, echoing the divider; it straightens and goes.

I shipped א:
- It reads as a menu at a glance.
- The pink shows without a second shape.
- Its ✕ is all ink, so it keeps full contrast.

Behaviour is unchanged from r13: a modal sheet, Tab kept inside, and Esc, ✕ or a tap outside to close. Reduced motion skips the morph.

## 6. Tapping a design: one view

Options a and b were near-identical after these changes, so they are **merged into one**. The א/ב switch is gone, and so is the version switch on the designs page.

Order, start-aligned in one column like the live product page:
1. the name;
2. the price, large;
3. "מה בפנים" with its four ticked lines;
4. the button "יאללה בואו נתחיל";
5. "מוכן תוך 4 ימי עסקים", on its own line under the button.

Removed:
- the pickup / delivery options;
- "ללא הגבלת מילים";
- the row of three small fronts;
- option a's line "כל עיצוב מתאים לכל חגיגה - את הכותרת אתם כותבים", which is still the designs section's subtitle.

The page's other two buttons still say "בונים את המשחק".

Since the options are gone, the board is a little larger than r13's b: up to 520 px wide. Short screens get a smaller board.

**Sharpness.** The blur came from the fly-in animation, not the files:
- **The cause:** the animations that drop the board and fly the card in (`fill: both`) stayed attached after they finished. That kept the board and cards on a layer rasterised at the animation's starting scale. In Chromium, an opened design measured 1508 against 2415 for the same view without the animation (Laplacian variance on a 3x phone capture: higher is sharper).
- **The fix:** the opening animations are dropped as soon as they finish. Chromium now gives 2680 against 2680 with no animation, identical. WebKit was not affected and stays about the same (1880 now).
- **Boards:** the boards now carry a 2x `srcset`. `boards14/` holds the live deck boards at their native 2000 px, beside `boards12/`'s 1200 px. ברוקלין has no 2000 px source, so it stays 1x.
  - The browser picks by displayed size × DPR. A 3x phone shows the board at about 312 px wide, which needs 936 device px, so it still takes the 1200 px file. The 2000 px file is for larger 2x and 3x screens.
- **Cards:** the cards stay 400 × 564. A 3x phone shows a card at about 340 device px and a 2x desktop at about 320, so the 400 px cards already exceed what the screen draws. The live sources are the deck sheets, at about 500 px per card, so a re-export would add little real detail.

## Checked

Playwright, Chromium and WebKit, phone (touch) and desktop (mouse).

**Tapped view:**
- It fits all ten designs, with the time line on screen and at least 19 px between the cards and the name, at 390×844, 375×667, 390×700, 360×740, 430×932, 1440×900, 1100×800, 1280×720 and 1024×700.
- Its order is name > price > "מה בפנים" > button > time, with the swipe hint on tall phones.
- It has no radios, no fronts row and no switch, and no animation is left once it opens.

**Order:** story before reviews, with one wave between them, 2 px pink and full width. The story's own order is title > photos > text > signature.

**Small line and headings:** the small line is gone; the signature stays. Every heading is Gveret with the pink offset, and the title switch is gone.

**Menu:**
- The icon has no border; its lines are ink, pink and ink, with round caps.
- The sheet's ✕ lands on the ≡'s spot within 1.5 px and has morphed.
- Focus moves in, and 20 Tab and Shift+Tab presses never leave the sheet.
- Esc and ✕ close it, and focus returns to the ≡.
- The story link scrolls to the story and focuses its heading.

**Body fonts:**
- All ten apply to the text, labels and buttons, with no mixing.
- Each face is really loaded, and the buttons' weight is a real weight of that font.
- The headings stay Gveret, and `#place` is kept.
- ‹ › step through the fonts and wrap from 1 to 10.

**WhatsApp:** it hides with a design open and with the menu open, and comes back after.

**Floating controls:** the body switch, WhatsApp and the `#place` palette are clear of each other and on screen at 360, 390, 430, 1100 and 1440, with and without `#place`, in both engines (30 of 30), and every button can be tapped.

**r13's checks, rerun:**
- **Illustrations:** only the overlaps r13 listed, on her story placements:
  - `pstar story 61.4, 7.8` (phone) and `pstar story 87.4, 14.2` (desktop) on the heading;
  - `star story 58.6, 55` (phone) on "ועלמה";
  - `cross order` on the button under reduced motion only.
  - Nothing touches the wave.
- 0 dealt cards on the hero text.
- The editor works by mouse and by touch.
- The review row stays still under a resting finger.
- The designs page shows 10 views, 30 images and none broken.

impeccable's detector reports the same accepted findings as r13: low contrast on the outlined yellow and sky words, the cream page, and the flat type hierarchy.

## Before anything ships

Remove the testing tools: the body-font switch (`#body`) and `#arrow`.

## Files

| Committed | Local only |
| --- | --- |
| `r14.html`, `r14-designs.html`, `r14-faq.html`, `README-r14.md` | `media/reviews/` |
| `boards14/` (9 boards at 2000 px) | |
| `shots/r14*.png` (the founders' photos blurred from the first frame) | |
