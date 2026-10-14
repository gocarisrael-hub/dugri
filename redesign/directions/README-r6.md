# Phase 2, round 6: one table, top to bottom (gate D2)

Owner on r5: the hero is good. `r6.html` is r5 with these section changes; the hero is unchanged.

Section order: hero, designs, how it works, recommendations, our story, footer.

## 1. The occasions section is gone

The "מסיבה אחת. בעל שמחה אחד." section, with its two big tiles and the "וגם:" chips, is removed. The occasion tab in the hero stays.

## 2. The designs strip, in its place, endless

- **All the public designs:** 10 as of 2026-10-15. That is the 6 built-in ones from `site/js/designs.js` plus the 4 the live `/api/custom-designs` lists as public: מרקאנה, אואזיס, דני, טריפה. The number changes whenever the admin adds a template, so the headline drops it: "עיצוב לכל מסיבה. הכותרת שלכם."
- **The four custom designs' cards:** these are the real sample cards, rendered from the live `/api/template-image/<id>/front|back` and cut to `cards/<id>-f1.webp` / `-b1.webp`. מרקאנה has no back on the live site. Their flood shows the front with the back laid beside it, since there is only one sample front each.
- **Endless in both directions:**
  - The list is rendered five times and the middle copy is the real one.
  - When the scroll settles, it moves back into the middle copy by exactly one copy's width. The same cards sit in the same places, so nothing visibly moves.
  - One copy (10 cards) is wider than any fling, so no fling reaches an edge.
  - The lean, the snap and the colour morph all work across the wrap point. `shots/r6-wrap.png` stops halfway between ברוקלין (the last design) and פריז (the first), with the colours mid-morph.
  - Only the middle copy is in the tab order and visible to screen readers.
  - Reduced motion keeps the static grid, with one copy.

## 3. Recommendations: "ממליצים עלינו"

- **The table:** a flat oval in sand with a thin outline, and a name plate at the top centre with two screw dots. On a phone it becomes a tall rounded shape and the pills flow in a loose cluster, with the two logos side by side at the top.
- **Decoration:** white pills, each tilted and inside its own thin orbit ring, with sparkles, small circles and clovers around them. Each pill floats gently (a few px of drift and rotation, each on its own timing). Under reduced motion they are still.
- **The two companies:**
  - **H&M:** `logos/hm.webp`, trimmed from the black-and-white logo used for DG-1633.
  - **STAR CAR ירושלים:** `logos/starcar.webp`, the official badge from their own site, starcar.co.il, which confirms they are the self-drive electric-car tours from the First Station.
- **8 quote pills.** Each quote is verbatim from the customer's own message, trimmed. Each is attributed by occasion only, never a name.
- **Tapping a quote** opens a bottom sheet (a modal `<dialog>`) with that review's screenshot. It closes with ✕, Esc, a tap on the backdrop or a swipe down, and focus returns to the pill.
- **Privacy:** the screenshots come from `resources/reccomendations/`, which is git-ignored.
  - The sheet loads redacted crops from `media/reviews/`, which is never committed. The repo is public, so a fresh checkout shows a blank sheet. Neither the originals nor the crops are committed, and the sheet screenshot stays in `media/`.
  - Each crop keeps only the customer's own message bubbles. The chat header (phone numbers, a name, avatars), the status bar, our own replies, the keyboard and the input box are cut away, and the timestamps inside the kept bubbles are painted over. Nothing needed blurring.

## 4. Our story: two prints on the table

- **The prints:** the two live photos from the site's story section, set as Polaroid-style prints taped at a tilt. Today's print lies on top of the childhood one, with captions "היום" and "גיל 4" in Gveret Levin, the site's handwritten font. The digit is in Rubik because Gveret's 4 reads as an ע.
- **Interaction:** the prints use the hero's physics (the same friction, torque about the held point, inertia, soft edges).
  - **Tap the top print** and it is tossed aside, revealing the other.
  - **Tap a print lying aside** and it comes back onto the pile, on top.
  - **Tap the bottom print** and it lifts to the top in place.
  - **Drag either print** to throw it.
  - Each print is a focusable button, so Enter tosses it.
- **The text:** the story copy is the live text from the content editor ("איך דוגרי נולד" and both paragraphs), with "הדר ועלמה" as a pink sticker.
- **Photos:** they load from the live site's `/content-uploads/` URLs, so nothing of them is in the repo. Committed shots blur them; the clear shots are in `media/`.

## Files

| Committed | Local only (`media/`) |
| --- | --- |
| `r6.html`, `README-r6.md` | `media/r6-motion.mp4` (390×844: the strip through the wrap and back, a flood, a quote sheet, the story toss and a drag) |
| `cards/{football,grapefruit,daniel,tarifa}-f1.webp`, `cards/{grapefruit,daniel,tarifa}-b1.webp` | `media/reviews/r1,2,4,5,6,7,8,9.jpg` (redacted crops) |
| `logos/hm.webp`, `logos/starcar.webp` | `media/r6-sheet.png` |
| `shots/r6-designs.png`, `r6-wrap.png`, `r6-flood.png` (טריפה) | `media/r6-story.png`, `r6-story-before.png`, `r6-story-desktop.png` (photos unblurred) |
| `shots/r6-recs.png`, `r6-recs-desktop.png` | |
| `shots/r6-story.png`, `r6-story-desktop.png`, `r6-full.png` (story photos blurred) | |

## Checked

Playwright, at 390×844 and 1440×900 with normal motion, and at 390×844 with reduced motion:

- No page errors.
- Endless strip: 14 swipes forward and 24 back go through every design in order across the wrap with no edge.
- The custom-design flood fans front and back.
- No quote or logo pill overlaps another or leaves the oval.
- The sheet opens, closes on Esc and returns focus.
- A tap tosses the top print aside.
