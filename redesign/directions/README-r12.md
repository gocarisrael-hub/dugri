# Phase 2, round 12: an illustration editor, the owner's three colours, and corrected cards and boards (gate D2)

`r12.html` is r11 with the owner's round-12 notes. `r12-designs.html` shows every design's tapped view, one after another, and `r12-faq.html` is r11's FAQ page linked to r12. Everything not listed here is r11.

## 1. Illustrations, and an editor to place them

**The set.** Seven kinds, each with its own animation:
- her four picks: #13 hourglass, #25 confetti popper, #27 disco ball, #91 sparkle cluster;
- the 4-point star of r4–r8, both solid black and the pink one with an ink line, twinkling as in r8;
- the thin "+" of r8, which twinkles without turning so it never reads as an "×".

**Normal view.** The page draws them from the `PLACEMENTS` constant: `{ m: phone, d: desktop }`, each a list of `[type, section, x, y, width px, turn°]`.
- **x** is % of the page's content column (1040 px on desktop, the screen less its 16 px gutters on a phone), so an item keeps its place beside the content at any width.
- **y** is % of its section (`top`, `order`, `recs`, `story`).
- The phone layout applies below 900 px and the desktop layout above.

**The starting layout** (12 on a phone, 13 on desktop) was placed by a script, not by eye:
- Each pick sits beside its own heading's end: the sparkles after "אישי", the popper after "העיצובים שלנו", the disco ball after "ממליצים עלינו", the hourglass after "איך דוגרי נולד".
- Two or three small marks per section are each tied to a piece of content: the catch line, the CTA, the price, the sticker, the signature, below the review row.
- A spot is used only if it is clear of every text line, card, panel, pill, the deck and its pile at every width of its layout (phone 360/390/430; desktop 900–1440), and never in the top or bottom 7% of a section, so marks don't bunch at a seam.

**The editor, at `#place`.** It works by touch and with a mouse.
- **Palette:** a floating bar to add any of the seven kinds. On a phone it is compact, and ▾ folds it away.
- **Move:** drag an item. It lifts out of its section while it moves, the page scrolls when it is held near the top or bottom edge, and it lands in whichever section it is dropped on.
- **Size and turn:** the corner handle resizes and the top handle turns. On a phone, two fingers pinch and turn; the second finger can land anywhere.
- **Delete and copy:** ✕ (or Delete) removes an item. ⧉ copies it, and so does holding a finger still on it.
- **Grab area:** every item has a 44 px+ grab area, and the handles are 40 px.
- **טלפון / מחשב:** edits that layout. It says so when the screen is the other kind.
- **"העתק מיקומים":** copies a compact JSON to the clipboard, with a text-box fallback. **"טען"** takes that JSON back, keeps only valid rows, and says how many it dropped. **"התחלה מחדש"** returns to `PLACEMENTS`.
- **Autosave:** the work in progress is saved in `localStorage` (inside try/catch), so a refresh keeps it. The normal view always shows `PLACEMENTS`; her pasted JSON becomes the next `PLACEMENTS`.

## 2. The hero's colours

Exactly #ffd37b (yellow), #a4e9ff (sky) and #ff7aa9 (pink), in the same leaflet treatment:
- the sky panel with ink text;
- "כל המילים עליכם!" in yellow with an ink outline and a pink offset;
- the pink panel with ink text, where "סיפורים מצחיקים", "אהבה ראשונה" (yellow) and "ואפילו אקסים" (sky) are set in colour, 20 px bold, with an ink outline (1.6 px on a phone).

All text on the fills is ink: 15:1 on sky and 8:1 on pink. Text set in a colour is always outlined in ink.

## 3. The designs panel

The panel is strong at the top: the design's colour, lifted only until black text reads at about 9:1. It gets lighter and lighter down the panel, through oklch so there is no grey band, until it is the page itself, with no bottom edge. It still follows the centred design.

## 4. `r12-designs.html`

All ten tapped views, still, one after another, each the same render as r12 (they share `fillFlood`). A switch at the top shows option a or b.

## 5. Tapping a design: `#flood=a` and `#flood=b`

- **a:** as in r11: the board, front and back, the name, the line, the price and the CTA.
- **b:** only what helps decide, from the live product page (`product.html`, 2026-10-15) and `/api/pricing`:
  - "בקופסה: חפיסת קלפים מותאמת אישית, לוח משחק ודף חוקים";
  - "איסוף עצמי, או משלוח עד הבית ב־{delivery_fee}";
  - "מוכן תוך 4 ימי עסקים";
  - `{price}` and the CTA;
  - for the designs with 8 fronts, three more real fronts.
  - There is no title or comment line and no design description.
- **Switching:** a small א/ב switch inside the open view switches it for testing (the hash keeps `#place` if it is on).

## The owner's corrections to cards and boards

These are new folders, `cards12/` and `boards12/`, built by `make_assets.py`. r9–r11 keep `cards9/` and `boards9/`.

- **Boards:** every board except ברוקלין (untouched) is now the live shop's deck board (`/api/design-images` deckBoard). Those have the real backgrounds (פריז, קליפורניה and טוקיו were white) and no personal title. דני's was the only one with a title ("Bride in One Pot"); it is painted out with the same rows of its own horizontal stripes, below the circles.
- **טוקיו:**
  - The back's frame is its own black, so its red outline shows again.
  - Its panel and flood colour is a pastel red from the koi red of its art (#b03a3a).
- **דני:** all 8 fronts are framed in the sheet's real vertical stripes, continued outward at the sheet's period (78 px) and phase.
- **אואזיס:** the front is exactly the card the live shop shows, the print template's "יום הולדת לדנה" with its orange-slice frame (already about 11%). It is one card, so אואזיס deals one front.
- **האלאנד:** unchanged (flat blue). Its footballs sit behind the card panel and are cut by its red line on the sheet, so there is nothing whole to continue; a clean frame needs a re-render from its Canva file.

One JPG per design's tapped view (option a, 390×844 at 2x) for the owner is at `~/projects/dugri/.design-preview/r12-shots/NN-<id>.jpg`. The helper's `.design-preview/img/` is regenerated, and its page lists the one real אואזיס front.

## Other fixes found on the way

- **Row touch fix (the peer's report):** the review row's touch pause now runs from the first touch until the last finger lifts (touchstart/touchend). The browser's pointercancel on a scroll no longer starts the 1.8 s timer, so a finger resting on the row keeps it still.
- **Deck hint:** the "לגעת בחפיסה" hint (r11) rose above an open design. The deck, its cards and the hint now stay in their own layer.
- **Desktop deck:** on desktop the deck scales (`min(210px, 19vw)`) and the pile is kept clear of the text column. At 900 px, 40 of 60 deals had landed on the headline; now 0 of 60 at every width from 360 to 1440.
- **Footer:** on a phone the footer links stack without dots, so no line starts with a dot.

## Checked

Playwright, phone 360/390 (touch) and desktop 1100/1440 (mouse), with and without reduced motion:

- No page errors.
- The illustrations are clear of all content at every width.
- No dealt card lands on the hero text (60 deals at each of six widths).
- Options a and b fit all ten designs, with the CTA on screen; b shows the facts and three fronts where there are eight.
- The designs page has 10 views and no broken images.
- **Editor, by mouse:** add, move between sections, edge-scroll, resize, turn, ⧉ copy, delete, a slow click that does not copy, copy to the clipboard, autosave across a reload, a valid and an invalid load, the phone tab, and start over.
- **Editor, by CDP touch:**
  - add, drag, hold to copy, delete;
  - a pinch that resizes and turns the item;
  - a pinch whose first finger moved first and whose second landed off the item, held past the hold time, makes no copy and leaves the item in its section.
- **The review row:** a finger that swiped and still rests keeps it still for 2.4 s, and it moves again after the lift.

The headless browser can't play H.264; it is not used here.

## Files

| Committed | Local only |
| --- | --- |
| `r12.html`, `r12-designs.html`, `r12-faq.html`, `README-r12.md` | `media/reviews/` (the sheet's redacted crops) |
| `cards12/`, `boards12/` | `~/projects/dugri/.design-preview/r12-shots/` (outside the repo) |
| `shots/r12*.png` (the founders' photos blurred from the first frame) | |
