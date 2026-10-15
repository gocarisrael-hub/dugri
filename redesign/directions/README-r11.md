# Phase 2, round 11: the leaflet's colours, one panel, Pluto's card row (gate D2)

The owner chose r9's hero A over the ten r10 openings, and asked for five changes on top of it. `r11.html` is r9 with these changes and `r11-faq.html` is r9's FAQ page on the new ground. Everything else is r9: `cards9/`, `boards9/`, the deck physics, the designs strip and flood, the story and the footer.

## The owner's notes

1. **Page ground `#fff1de`** everywhere, on the FAQ page too.
2. **Hero text:**
   - The chips, the kicker "דוגרי, המתנה הכי אישית" and the numbered lines are gone.
   - The headline is "דוגרי, המשחק הכי אישי".
   - Under it is her whole "מה זה דוגרי?" paragraph, word for word, coloured the way the printed leaflet's "על המשחק" page is coloured. The colours were sampled from the live product photo of the leaflet:
     - **A sky-blue panel** (`#a6d8ec`, the leaflet's `#8ccce4`) holds the how-to. Its first sentence, "משחק מילים אישי שכל כולו על האדם שחוגגים לו.", is in the leaflet's pink lettering on blue (`#a61d4a`, 4.7:1).
     - **"ומה הקאץ׳?"** is in the same pink. **"כל המילים עליכם!"** is in the leaflet's title treatment: mustard fill (`#e8b85c`) with a pink outline and a pink offset. It is one size below the headline, and stays on one line.
     - **A pink panel** (`#cf3b62`, the leaflet's `#e85c78` deepened so white reads at 4.7:1) holds the list, in 20 px bold. The words take three colours: white, butter `#ffe49a` for "סיפורים מצחיקים" and "אהבה ראשונה", and pale blue `#d4effa` for "ואפילו אקסים" (3.8:1 and 3.9:1; AA for large bold text).
3. **No separators.** No section has a rule, a fill or an alternate background, and the page flows on `#fff1de`. The one exception, by her correction, is the designs section.
   - **The designs panel** is Pluto's "to the rescue" card: inset (16 px on a phone, 20 px on desktop), with 40 px and 80 px corners, and a soft vertical gradient.
   - **The gradient** is two tints of the centred design's colour, and cross-fades as the strip moves (as r9's colour did).
   - **The top tint** is stepped down until it stands clear of the page, so the rounded edge always shows; that matters for the yellow designs.
   - **Dark designs** keep a light bottom tint. The near-black טוקיו is tinted toward the page, so it reads warm, not grey.
   - **The strip opens on קליפורניה (blue)**, so the hero's pink panel is not followed by a pink panel.
4. **Reviews: Pluto's card row**, measured on pluto.security:
   - **The card:** white, 16 px corners, 1 px black line, a hard `6px 7px` black shadow, 18 px padding, 360×176 on desktop (272 wide on a phone).
   - **The tag:** cream `#fdf2d4`, a small tag at the card's reading start. That is the top right, because the page is RTL; Pluto's sits top left in LTR.
   - **The highlighted card:** the bachelorette review, on light pink, with a pink tag (`#c8246a`, white text at 5.5:1).
   - **The content:** tag = the occasion (from r6), title = the short quote, text = the `{שם} · {תאריך}` caption (`data-edit`, which she fills in the admin). A tap opens the review screenshot sheet, as before.
   - **The logos:** H&M and STAR CAR are cards in the same row, tagged "לקוח עסקי".
   - **Endless:** three copies side by side, with the scroll kept inside the middle one. It drifts right to left at about 30 px/s.
   - **It stops while:**
     - a mouse is over it;
     - a finger is on it, and for 1.8 s after;
     - a keyboard user is on a card;
     - the sheet is open;
     - it is off screen.
   - **Moving it:** a finger swipes it, a mouse drags it, and a drag never opens a card. Under reduced motion it does not drift but can still be swiped.
5. **Illustrations**, her four picks from the first batch, each with its own gallery animation, scoped so nothing else is touched:
   - **#91 sparkle cluster:** after the headline's last word, like the sparkles beside the leaflet's title.
   - **#25 confetti popper:** the designs panel's top corner.
   - **#27 disco ball:** after "ממליצים עלינו".
   - **#13 hourglass:** after "איך דוגרי נולד".
   - **Measured:** none touches text, a card, a panel, a print or a pill, on a phone, on desktop and under reduced motion. Reduced motion holds them still.

## Other changes

- **Shadows:** every hard shadow on the page now falls bottom-right, the same way as the review cards: the deck, the dealt cards (their flip mirrors it correctly), the strip, the prints and the catch line's offset.
- **The deck hint** "לגעת בחפיסה" is plain words under the deck, not a pill on it.
- **The design names** under the strip cards are plain words, not pills.
- **The desktop deck** is 210 px (was 170).
- **The hero deck** leaves out ברוקלין, whose back is an NBA-like logo (as in r10). It stays in the designs strip.
- **Story on a phone:** the heading comes first and the prints follow, so the section is not an untitled run of photos.
- **The footer** sits in the content column on desktop and wraps cleanly on a phone.

## Checked for the AI look

The same three skills as r10 (taste-skill, redesign-skill, impeccable) plus her blocker list. Two isolated reviewers each judged their part from the phone and desktop shots and the source: one the hero and the designs panel, the other the reviews, the story, the footer and the page flow.

- **Round 1: FAIL.**
  - The catch line competed with the headline.
  - The hint and the name pills sat on cards (sticker labels).
  - The desktop deck was small.
  - The panel's top edge vanished for yellow designs.
  - The marquee could stay paused for good after two quick taps.
  - Mouse users could not move the row.
  - On a phone the story's photos came before its heading.
  - The shadows fell two ways.
  - The footer sat outside the content column.
  - All fixed as above.
- **Round 2: PASS on every part.** The minors taken: the lede's dash kept on its line, more room under the tilted cards, a soft fade at the panel's sides, no text selection while dragging, footer dots that travel with their link, and a tighter story end on a phone.

impeccable's detector still reports, accepted:
- **`low-contrast`:** the mustard fill of "כל המילים עליכם!" on the page (1.7:1). It is the leaflet's title colour she asked for, and the letters' edge is the pink outline, at 6.5:1.
- **`cream-palette`:** her page colour.
- **`flat-type-hierarchy`:** reads the hidden flood and sheet headings, as in r10.

Her follow-ups, done:
- Every "בונים את המשחק" link now ends in "‹", which points forward (left) in RTL. There are three, in the hero, under the strip and in the design flood; the FAQ page has none.
- The story text reads "מרגשת אותנו!" (no space before "!"). The live site's text still has the space.
- The sticker "הסיפור שלנו" is kept from r9.

## Files

| Committed | Local only |
| --- | --- |
| `r11.html`, `r11-faq.html`, `README-r11.md` | `media/reviews/` (the sheet's redacted crops) |
| `shots/r11.png`, `r11-desktop.png` (first screen), `r11-designs*.png`, `r11-recs*.png`, `r11-story*.png`, `r11-full*.png` | |

The founders' photos are blurred from the first frame in every committed shot.

## Checked

Playwright at 390×844 (touch), at 1440×900 (mouse), and at 390 with reduced motion:

- No page errors, and no border on any section, header or footer.
- The body is `#fff1de`, and no section other than the panel has a background.
- Each illustration is clear of content.
- The panel's radius is 40 / 80 px, and its colour layer follows the centred design.
- The row drifts. Hover pauses it and leaving resumes it. After two quick taps it moves again.
- A 300 px mouse drag moves it 300 px and opens nothing. A swipe re-centres it into the middle copy.
- A card opens the sheet with its caption and screenshot; Esc closes it.
- The 20 hidden copies take no focus.
- Under reduced motion, nothing drifts or animates.
- The FAQ page is on `#fff1de` with no rules, and its links point to r11.
