# Phase 2, round 13: the product page's buying block, a drawn arrow, WhatsApp, a menu, fonts, business enquiries (gate D2)

`r13.html` is r12 with the owner's round-13 notes. `r13-designs.html` shows every design's tapped view, and `r13-faq.html` is r12's FAQ page linked to r13. Everything not listed here is r12: the cards, the boards, the hero, the panel, the review row and the illustration editor (`#place`; its autosave key is now `dugri-r13-placements`).

## 1. The tapped view, option b (`#flood=b`)

Option b is now the live product page's buying block (`product.html?design=marriage`, read 2026-10-16), in the new look and in the same order:
- the design's name, then the price, large (`{price}`);
- how it reaches you, as two options side by side: "איסוף עצמי · תל אביב, בלי תוספת" and "משלוח עד הבית · בשליח +{delivery_fee}". The product page itself has no version choice; this is the checkout's (`collect.html`: one printed game, with delivery on top for the fee). The two are real radio buttons, with pickup chosen first;
- the button "בונים את המשחק";
- its note, word for word from the live page: "מוכן תוך 4 ימי עסקים · ללא הגבלת מילים";
- "מה בפנים" as ticked lines, the live page's four: חפיסת קלפים מותאמת אישית, לוח משחק, דף חוקים, חיילי משחק עם הפרצופים שלכם.

There is no title line and no design description. The block is start-aligned (right) in one column, like the live page.

Fitting it on the screen:
- On short phones (760 px tall or less) the board is smaller.
- Below 700 px tall, "מה בפנים" is left out so the choice and the button stay on screen.
- It fits all ten designs at 375×667, 390×700, 360×740 and 390×844.
- The three extra fronts of r12 show only on desktop screens at least 1000 px tall, where they fit under the list.

Option a is unchanged.

## 2. The button arrow

The "‹" glyph is gone. Each "בונים את המשחק" button ends in a drawn arrow pointing forward (left), so it looks the same in every font. Its line follows the button type's weight, and it changes with the font.

**Kept, not dropped:** with the arrow the button reads as an action; without it, it reads as a label. For comparison, `#arrow=none` (or the switch at the bottom of the font list) hides every arrow.

## 3. Floating WhatsApp

A green circle with the WhatsApp glyph (the same glyph as the live site's footer) sits at the bottom left, the end side in RTL.
- **Target:** wa.me/972552441334, the customer-service number of the live site's WhatsApp links (0552441334), with the live site's opening line "היי! אני רוצה להזמין משחק דוגרי".
- **Placement:** it keeps the safe-area inset and has an ink outline with a hard shadow, like the rest of the page.
- **When it hides:** while a design is open, while the review sheet is open, and while the menu is open.
- **Editor:** in `#place` it rises above the editor's palette.
- **Footer:** the footer has room at the bottom, so it never covers the last links.

## 4. The story

The "הסיפור שלנו" sticker is gone. The order is the title "איך דוגרי נולד", the two photos, the text, then the signature.
- **Phone:** one column in that order.
- **Desktop:** the title spans the width, the photos come first (right) and the text sits beside them.

## 4b. The owner's placements (update, same day)

`PLACEMENTS` is now Alma's layout from the `#place` editor, verbatim: 11 on a phone and 12 on desktop, in her positions, sizes and turns.

There is a new kind, **"bstar"** ("כוכב תכלת" in the editor's palette): the 4-point star in the site's light blue `#a4e9ff` with the black outline, twinkling like the others. About half of her black stars now use it, alternating down the page:
- **Phone:** black (hero), blue (designs), black (story).
- **Desktop:** black, blue (hero), black (designs), blue (story).

She can switch any star between the two kinds herself next time.

**Overlaps, left as she placed them.** The overlap check finds these on text (her story positions match the r12 layout, from before the story reorder):
- `pstar story 61.4, 7.8` (phone) sits on the heading "איך דוגרי נולד", between "דוגרי" and "נולד".
- `star story 58.6, 55` (phone) sits on the first paragraph, on "ועלמה".
- `pstar story 87.4, 14.2` (desktop) sits on "דוגרי" in the heading.
- `popper order 12.3, 6.9` (phone) touches the end of "העיצובים שלנו" at 360 px wide only (clear at 390 and 430).
- `cross order 83, 84.2` (phone) touches the "בונים את המשחק" button under reduced motion only (the designs become a static grid).

The earlier r13 build had moved the first three; that move is undone in favour of her layout.

## 5. Menu

A thin square ≡ sits at the top right, beside the logo. It opens a sheet from the right with:
- העיצובים
- ממליצים עלינו
- איך דוגרי נולד
- שאלות נפוצות
- איסוף עצמי
- פניות עסקיות
- the "הזמינו עכשיו" button

How it behaves:
- It is a modal `<dialog>`, and the ≡ carries `aria-haspopup`, `aria-expanded` and `aria-controls`.
- Tab and Shift+Tab loop inside the sheet. This is handled by the page, because Safari's own Tab skips links.
- Esc, ✕ or a tap outside closes it, and focus returns to the ≡.
- A link to a section closes the sheet, scrolls there and moves focus to that section's heading.
- The page behind it does not scroll.

## 6. Fonts: `#font=1` … `#font=18`

A chooser sits at the bottom right while testing: ‹ name › to step through, or tap the name for the list, where each option is shown in its own font. It changes `#font=N` and keeps `#place` and `flood=b`.

| # | Headings | Text |
| --- | --- | --- |
| 1 | Rubik (now) | Rubik |
| 2 | Heebo | Heebo |
| 3 | Assistant | Assistant |
| 4 | Secular One | Assistant |
| 5 | Suez One | Heebo |
| 6 | Fredoka | Fredoka |
| 7 | Varela Round | Varela Round |
| 8 | Karantina | Heebo |
| 9 | Frank Ruhl Libre | Frank Ruhl Libre |
| 10 | Amatic SC | Assistant |
| 11 | Bellefair | Assistant |
| 12 | David Libre | David Libre |
| 13 | Noto Serif Hebrew | Noto Serif Hebrew |
| 14 | Alef | Alef |
| 15 | IBM Plex Sans Hebrew | IBM Plex Sans Hebrew |
| 16 | M PLUS Rounded 1c (it has Hebrew) | M PLUS Rounded 1c |
| 17 | Playpen Sans Hebrew (the live site's) | Playpen Sans Hebrew |
| 18 | Gveret Levin (the live site's, headings only) | Rubik |

- **Where they come from:** every font is from Google Fonts except Gveret Levin, which is the repo's own file. Each has a Hebrew subset, and only the weights each one really has are loaded, so the browser never fakes a bold.
- **Condensed faces:** Karantina and Amatic SC draw much smaller at the same size, so their display text is scaled to Rubik's letter height, and the pink list keeps the text font.
- **On the page:** `shots/r13-fonts.png` shows the hero in all 18.

## 7. Business enquiries

"פניות עסקיות" comes before the footer and is linked from the menu. It has:
- a short line about team events and gifts for employees;
- the H&M and STAR CAR logos ("כבר שיחקו:");
- a WhatsApp button to wa.me/972546577715, with the live site's business opening line;
- "או בטלפון: 054-657-7715".

Like every section except the designs panel, it has no fill and no line.

## Checked

Playwright, Chromium and WebKit, phone 390×844 (touch) and desktop 1440×900 (mouse):
- **Page:** no page errors. The story order is title > photos > text > signature, with no sticker.
- **Arrows:** no "‹" is left, and there is a drawn arrow in all three buttons, pointing left. `#arrow=none` hides them.
- **WhatsApp:**
  - The link goes to 972552441334, at 16 px from the corner.
  - It hides with a design open, the review sheet open and the menu open, and comes back after.
  - It sits above the palette in `#place`.
- **Menu:**
  - It opens on the right with `aria-expanded=true` and focus inside.
  - 20 Tab and Shift+Tab presses never leave it.
  - Esc closes it and focus returns to the ≡.
  - The business link closes it and focuses its heading.
- **Fonts:**
  - All 18 apply, and the heading and text faces are actually loaded in both engines.
  - The hash keeps `#place` and `flood=b`.
  - The chooser's ‹ › and its list work.
- **Business:** the WhatsApp link goes to 972546577715 and the phone link to +972546577715.
- **r12's checks, rerun on r13** (phones 360/390, desktops 1100/1440, reduced motion):
  - illustrations: only the overlaps listed in 4b;
  - 0 dealt cards on the hero text;
  - options a and b fit every design;
  - the designs page shows 10 views with b's facts;
  - the editor works by mouse and by touch;
  - the review row stays still under a resting finger.

impeccable's detector reports the same accepted findings as r12: the outlined yellow and sky fills, the cream page and the hidden headings' hierarchy.

## Files

| Committed | Local only |
| --- | --- |
| `r13.html`, `r13-designs.html`, `r13-faq.html`, `README-r13.md` | `media/reviews/` |
| `shots/r13*.png` (the founders' photos blurred from the first frame) | |
