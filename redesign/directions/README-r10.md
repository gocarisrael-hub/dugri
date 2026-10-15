# Phase 2, round 10: ten openings, each checked for the AI look (gate D2)

Owner on r9's hero (A and B): "still super claudey, super AI vibes". `r10.html` is r9 with only the hero changed. It holds ten genuinely different openings, switched in place by `#hero=1` … `#hero=10`. A small numbered row at the bottom left does the same; it is a review tool and is hidden in the committed shots. Everything below the hero is r9.

Every opening uses only real material: the site's own product photos (`site/assets/hero-*.jpg`, `gallery-*.jpg`), the party clip (`site/assets/video/party.mp4`), real customer WhatsApp screenshots (`site/assets/testimonials/`), the real cards and boards (`cards9/`, `boards9/`), a real photo of the printed leaflet, and the site's own 60-second timer. All text is her words: her line "כל המילים עליכם!", her "מה זה דוגרי?" paragraph (whole sentences or her own clauses), "דוגרי, המתנה הכי אישית", and the site's CTA "בונים את המשחק ›".

## How each opening was checked

Each opening went through three critique skills, in rounds, until it passed:

1. **Detector.** impeccable's detector (`impeccable detect --json`, the local engine 0.1.14) ran on a standalone copy of the page with only that opening.
2. **Two isolated reviewers.** Each one is a sub-agent that never saw the other's output. Reviewer 1 judged 1-5, reviewer 2 judged 6-10. Both used the phone (390×844) and desktop (1440×900) screenshots and the source, and applied:
   - **taste-skill** (the anti-slop skill): 4.7 layout discipline, 4.8 visual assets, 4.9 content density, and all of section 9's AI tells, including the em-dash ban.
   - **redesign-skill:** its full AI-pattern design audit.
   - **impeccable:** the craft-floor Verify and Refuse lists, and the critique's Assessment A (design specificity: "could an unrelated product use it unchanged?").
   - **The owner's own list.** These are blockers: a centred mega headline with a kicker and a pill, chips, numbered step cards, perfect symmetry, generic even sections, sticker labels, a highlighted pink word, and fake-friendly copy.
   - **Verdict:** PASS means no blocker and no major.

### What the detector still reports (accepted, not fixed)

- `cream-palette`: the beige page is the owner's fixed choice.
- `cramped-padding`: on the full-bleed photo and video panels, intentionally.
- `flat-type-hierarchy`: from page-wide elements below the hero (out of scope).

### What every opening shared in round 1, fixed for all

- **Gutter:** the hero's CSS had cancelled the section's 16 px side padding, so text touched the screen edge on phones, and on desktop everything was pinned right.
- **Desktop:** none of the openings had a desktop composition.

Both reviewers failed all ten in round 1.

### Page-wide detector fixes

- The review sheet's empty `<img>` (now created on open).
- Leading of 1.25 raised to 1.3.
- 0.06em tracking on the CTA reduced to 0.02em.
- An undersized 7 px line removed.
- Low-contrast (2.4:1) script lines set to #6d655c (5:1).
- A pink glow on the timer removed.
- Each opening's visible line made its `<h1>`.

## Per opening

### 1. Magazine cover

A real product photo full-bleed, the real logo as the one masthead (the header logo hides while it shows), her line as the cover line.

- **R1:** FAIL. Kicker label; a duplicate list of her words over the card's own printed words; the logo twice; gutter.
  - **Changes:** kicker and duplicate list removed (the real card in the photo carries its own words); one masthead.
- **R2:** FAIL (desktop). The headline sat over the card's printed words.
  - **Changes:** moved.
- **R3:** FAIL (desktop). The headline now crossed the board's white circles.
  - **Changes:** on desktop the cover became a framed page with the words beside it on the beige.
- **R4:** FAIL. Phone regression: moving the words out of the cover dropped their white.
  - **Changes:** restored white with a shadow on the phone; 18 px CTA gap on desktop.
- **Final:** PASS. The phone matches round 3, which passed; the desktop matches round 4, which passed.
- **Open minor:** the photo is a soft video still at desktop size.

### 2. A table seen from above

The real printed board as the table, her line handwritten above it with a drawn arrow, the deck dealing onto it.

- **R1:** FAIL. The note was a rotated white box with a shadow (a sticker); the desktop was broken.
  - **Changes:** the note is now handwriting straight on the beige; cards on the board get soft contact shadows.
- **R2:** FAIL. Her how-to was cut at a comma, a broken sentence.
  - **Changes:** her complete sentence "משחק מילים אישי שכל כולו על האדם שחוגגים לו."; the arrow re-aimed at the dealt pile; the desktop copy top-aligned.
- **R3:** PASS.
- **Open minors:** the arrow's tail grazes "עליכם!" on the phone; the desktop CTA sits low.

### 3. One real card, blown up

The real פריז card art with its own four printed words cleared (in its own panel colour) and her four words written where they were, in the same handwriting. Tap it (or press Enter) and it turns over to her how-to on the real card back.

- **R1:** FAIL. It was a CSS-drawn card, not a real one; clipped; desktop broken.
  - **Changes:** rebuilt on the real card art and real back; her line moved outside the card; the "tap to flip" label replaced by a corner lift as the card comes into view.
- **R2:** PASS.
- **R3:** PASS.
- **Open minors:** confirm her line is "ואפילו אקסים - הכל נכנס." (it is in the live index-about-body text); a sharper card render.

### 4. The morning after

Real WhatsApp messages from customers, with their own wallpaper and timestamps, then the deck and her line.

- **R1:** FAIL. Cropped to a generic grey bubble; no attribution; gutter.
  - **Changes:** the real screenshots with their wallpaper; the source line "הודעות שקיבלנו בוואטסאפ" (no names: the owner's privacy rule).
- **R2:** FAIL. Two long messages filled the phone fold.
  - **Changes:** one message on the phone, cropped to its first three lines with the bubble closed; both whole on desktop; the NBA-like basketball back removed from the hero deck.
- **R3:** PASS.
- **Open minor:** the source line is plural above a single message on the phone.

### 5. The lid

A photo of the real leaflet as a sliding lid over the box, resting half open. The box floor and the dealt cards show in the open half, and a tap slides it further.

- **R1:** FAIL. A CSS rectangle with a centred logo (symmetry); a new blue accent; clipped.
  - **Changes:** the real leaflet photo; the blue accent and the peeking cards removed.
- **R2:** FAIL. A split hero with evenly spaced text; the lift could not be seen; a comma-cut sentence.
  - **Changes:** a tight text stack; her whole sentence; a resting lift.
- **R3:** FAIL. A hinge lift cannot be seen from above; the lid broke the phone gutter.
  - **Changes:** replaced with a sliding lid; the box narrowed to 76vw.
- **R4:** PASS.
- **Open minors:** the deck is cropped at the box's right wall on desktop; the box walls have no depth.

### 6. A wall of real words

About 50 real words from real cards in a dense wall, with her line inside it. One word at a time is being described (a fuse underline burns down), then guessed and struck through, with a "ניחשתם: N" count. Every third word is hidden on the phone to keep the CTA in view.

- **R1:** FAIL. Gutter; nothing said what the product is.
  - **Changes:** her plain line "דוגרי, המתנה הכי אישית" above the CTA; two weights only; the tally rewritten.
- **R2:** FAIL. Card phrases split across lines.
  - **Changes:** every word is nowrap.
- **R3:** PASS.
  - **Changes after:** the tally spacing tightened.
- **Open minor:** some uneven line endings (rag) on the phone.

### 7. The real timer

The site's own 60-second timer (its huge black numerals, "טיימר · 60 שניות", and התחל / עצור): it counts down, rings at 0 and resets. The deck sits under it.

- **R1:** FAIL. It was an invented sports scoreboard: a mirror layout, a dark slab, a fake UI.
  - **Changes:** replaced by the real timer; the layout is asymmetric.
- **R2:** PASS, conditional on the glow being gone.
  - **Changes:** the glow removed, then re-shot.
- **R3:** PASS.
  - **Changes after:** the label no longer wraps.

### 8. Prints on a table

Real product photos and a real card, dropped on the beige like prints, with her line handwritten straight onto the page.

- **R1:** FAIL. Sticker scrap over a photo; the stock Polaroid-and-tape kit; the desktop hid the CTA.
  - **Changes:** frames and tape removed; photos at their own ratio; her line written onto the beige.
- **R2:** PASS.
- **R3:** PASS.
  - **Changes:** tight text group; one print swapped for the blue board.

### 9. Quiet

Her line, the deck as the one big object, her plain line under it, the CTA.

- **R1:** FAIL. The logo twice; small cards in empty space; desktop.
  - **Changes:** the duplicate logo removed; the deck enlarged.
- **R2:** PASS.
- **R3:** PASS.
  - **Changes after:** "דוגרי, המתנה הכי אישית" added.
- The reviewer's note: the least distinctive of the ten.

### 10. A turn in progress

The real party clip of a guest acting out a card. Her whole how-to runs as the reel's captions on solid ink strips, with a real card in the corner.

- **R1:** FAIL. On desktop the clip was stretched about 5×; the card covered the guest's face; caption contrast.
  - **Changes:** native portrait size on desktop; the card moved to the empty corner; ink-strip captions.
- **R2:** FAIL. On desktop a lone CTA sat in an empty column.
  - **Changes:** her whole how-to in that column as the reel's script, with the spoken line in ink, synced to the captions.
- **R3:** PASS.
  - **Changes after:** the active line is also bolder.
- The reviewer's note: the strongest concept and the strongest phone fold.

## Final

All ten pass (no blockers, no majors). None was dropped; 5 was reworked (hinged lid to sliding lid) rather than replaced.

Reviewers' picks:
- **Strongest:** 10 (a turn in progress), 3 (one real card), 2 (table from above).
- **Weakest:** 9 (quiet), passing but generic.

## For the owner

- The live basketball design's card back is an NBA-style logo. It is kept out of the hero deck because the hero would put a trademark-like mark first on the homepage. It still shows in the designs strip, as on the live site.
- The switch row (`#hero=N`) is fixed at the bottom left and can cover a CTA at the bottom of the fold (1, 10). It exists only to compare; the chosen opening ships without it.

## Files

| Committed | Local only |
| --- | --- |
| `r10.html`, `README-r10.md` | |
| `hero10/card-front-blank.webp`, `card-back-blank.webp` (the real פריז card with its printed words cleared), `leaflet-lid.webp` (crop of the live leaflet photo), `review-1-top.webp` | |
| `shots/r10-1.png` … `r10-10.png` (phone fold), `r10-1-desktop.png` … `r10-10-desktop.png` | |

## Checked

Playwright on every opening, at 390 with normal motion and with reduced motion:

- No page errors.
- The deck moves into the opening that has a slot (2, 4, 5, 7, 9), and the first deal is פריז.
- 3 turns on a tap and on Enter.
- 5 slides open, with the deck clickable.
- 6 guesses words (still under reduced motion).
- 7 counts down, and its timer stops when you switch away.
- 10 cycles its captions (all lines shown under reduced motion).
- Switching away stops every timer.

The headless browser can't decode H.264, so 10's screenshots show the poster frame; real browsers play the clip.
