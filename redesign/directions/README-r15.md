# Phase 2, round 15: the body font locked, two waves with a soft field, a leave-your-details form, three more client logos (gate D2)

`r15.html` is r14 with the owner's round-15 notes. `r15-designs.html` shows every design's tapped view, and `r15-faq.html` is r14's FAQ page linked to r15. Everything not listed here is r14, including Alma's illustration placements (the editor's autosave key is now `dugri-r15-placements`).

## 0. Locked: the body font

- **The font:** M PLUS Rounded 1c (r14 option 8) sets all the text that isn't a heading: running text, panels, labels, buttons, prices, the menu, the review cards and the new form. The headings stay Gveret Levin with the pink offset.
- **Size:** it keeps r14's size-adjust (109.8%), so its Hebrew letters stand as tall as Rubik's did.
- **Weights:** only its real weights are used (400, 500, 700, 800, 900).
- **Removed:** the body switch and `#arrow=none`. The arrow now always shows, with its line matched to the 800 button type.
- **FAQ page:** it uses the same font.

## 1. "מה בפנים"

The tapped view now reads, on the page and on the designs page:
1. חפיסת קלפים מותאמת אישית
2. לוח משחק
3. חיילי משחק עם הפרצופים שלכם
4. דף חוקים

## 2. Two waves, and a soft field between them: `#fields=on` (default), `#fields=yellow`, `#fields=off`

- **The first wave:** r14's, between the story and the reviews, unchanged.
- **The second wave:** between "ממליצים עלינו" and "פניות עסקיות". It has its own curve: it falls first and rises late, where the first rises and then falls, so it isn't a copy.
- **The lines:** both are the same 2 px `#ff7aa9`, at every width.

**With fields on (the default)** each wave is the edge of a field, as on Pluto. The reviews between the two waves sit on a light tint of the palette's sky, `#e9f8fd`, which is `#a4e9ff` lifted most of the way to white. The page and the other sections stay on `#fff1de`.
- **How it's drawn:** the field is drawn inside each wave's own box along the same curve, so the colour change sits exactly on the line. There is no seam: 0 px between each wave and the reviews.
- **Yellow:** `#fields=yellow` shows the same with a light yellow, `#ffe9c4` (`#ffd37b` at 28% over the page). I made sky the default. It is the calmer of the two next to the white review cards, it echoes the designs panel, and the pink line reads more cleanly on it. The yellow sits closer to the cream and reads warmer.
- **Off:** `#fields=off` shows the two lines alone on the page colour, as in r14.

Shots: `shots/r15-fields*.png`, phone and desktop, all three.

## 3. Business enquiries: a short form

"או בטלפון: 054-657-7715" is gone. Under the WhatsApp button, which stays as before, there is a form: "או השאירו פרטים ונחזור אליכם".
- **Fields:** שם, חברה, טלפון, and the button "שלחו".
- **Layout:** stacked on a phone; one row on desktop, with the button level with the fields.
- **Labels:** each field has a real label above it. The fields are 48 px tall and use 16 px text, so iOS doesn't zoom in.
- **Validation** runs on send, and again as you correct a field:
  - a name and a company of at least 2 letters;
  - an Israeli phone number: 0 and then 8–9 digits (a mobile or a landline), or the same after +972;
  - spaces, dashes and brackets are ignored.

  Each error appears under its own field (`aria-invalid` and `aria-describedby`), and focus goes to the first wrong field. The phone message gives an example, "054‑123‑4567", with non-breaking hyphens so it never splits across lines.
- **Success:** a valid send hides the form and shows "תודה! נחזור אליכם בקרוב" in a card (`role="status"`, and focus moves to it).

**The prototype has no backend:** a valid send only shows the thank-you. The live version needs an endpoint that receives the three fields and emails the owner (and, if wanted, adds a row to the admin). Until that exists the form must not go live, or leads would be lost.

## 4. Three more client logos

Microsoft, Elbit Systems and Bank Hapoalim, in both places, in the order Microsoft, Elbit, Bank Hapoalim, H&M, STAR CAR:
- **"כבר שיחקו":** in פניות עסקיות, wrapping to two lines on a phone.
- **The review row:** as logo cards. Between them come the eight reviews, in r14's order: Microsoft, two reviews, Elbit, two reviews, Bank Hapoalim, two reviews, H&M, two reviews, STAR CAR.

They get the same treatment as H&M and STAR CAR: original colours, no frame, the same "לקוח עסקי" card. The heights are set by eye so the five weigh about the same: the wide wordmarks are drawn lower. In "כבר שיחקו", Microsoft is 30 px, Elbit 40, Hapoalim 22, H&M 40 and STAR CAR 52.

Where each file came from (fetched 2026-10-16):

| File | Source | Notes |
| --- | --- | --- |
| `logos/microsoft.webp` | Microsoft's own newsroom: `news.microsoft.com/source/wp-content/uploads/2023/01/Microsoft-logo.png` (1020 × 961, the four squares and the wordmark) | Microsoft's own sites serve the logo only as raster images (the microsoft.com header logo is 216 × 46 px). The newsroom file is the full logo on white. Cropped to the logo; the white was turned transparent only where it is background, so the logo's colours stay exact (red `#F25022` and blue `#00A4EF` checked at full opacity). Lossless, 796 × 180. |
| `logos/elbit.svg` | Elbit Systems' own site: `elbitsystems.com/themes/elbit/images/logo-elbit.svg` | The vector as served, byte for byte: 14 paths, blue `#1B458F` and yellow `#FDE134`, no scripts or links. |
| `logos/hapoalim.svg` | Bank Hapoalim's own site: `bankhapoalim.co.il/api/media/l3hlwykh/logo-poalim-1.svg` | The vector as served, byte for byte: the Hebrew wordmark in grey `#525252` with the red symbol `#F0000B`, no scripts or links. |

## 5. Each title's own offset colour

The titles keep r14's treatment: Gveret, in ink, with a 0.04em offset. Only the offset's colour changes, rotating down the page. Each colour was checked on the background its title really sits on:

| Title | Sits on | Offset |
| --- | --- | --- |
| דוגרי, המשחק הכי אישי | the page | `#ff7aa9` pink |
| העיצובים שלנו | the designs panel (tinted by the centred design, sky at first) | `#5fd0f5`, a deeper sky: `#a4e9ff` disappears into the sky-tinted panel |
| איך דוגרי נולד | the page | `#f7b32b`, a deeper yellow: `#ffd37b` is too faint on `#fff1de` (`#ffc44f` was tried and still read thin) |
| ממליצים עלינו | the sky field | `#ea4795`, the logo pink: it reads more strongly on the sky field than `#ff7aa9`, and it differs from the hero's pink |
| פניות עסקיות | the page | `#a4e9ff` sky (it reads on the page) |

The FAQ page has one title, its h1, so it takes the first colour, pink. `shots/r15-titles.png` shows all five on a phone, each on its own background.

## Checked

Playwright, Chromium and WebKit, phone 390×844 (touch) and desktop 1440×900 (mouse).

**Font:**
- Every non-heading element checked uses M PLUS Rounded 1c: the panels, the button, the lede, the story, a review card, the form, the menu.
- Weights 400, 500, 700, 800 and 900 load; the headings are Gveret.
- There is no switch, and `#arrow=none` no longer hides the arrows.

**"מה בפנים":** the new order, in all 10 designs, on the page and the designs page.

**Waves:**
- The order is story > wave > reviews > wave > business, with 0 px seams.
- The two curves differ, and both lines are pink and 2 px.
- With fields on, the reviews and both waves' fields are `#e9f8fd`, while the story and the business section stay on the page.
- `#fields=yellow` turns the field `#ffe9c4`; `#fields=off` drops the field and both wave fills.
- The hash keeps `#place`.

**Form:**
- Real labels, stacked on a phone and in one row on desktop. No phone link is left, and the WhatsApp button sits above the form.
- An empty send flags all three fields, with their messages, and focus goes to the name.
- A bad phone number flags only the phone field.
- Phone cases:

  | Accepted | Refused |
  | --- | --- |
  | 054-123-4567 | 12345 |
  | 0541234567 | 054123456789 |
  | 03-1234567 | abc |
  | +972 54 123 4567 | |
  | +972541234567 | |

- A valid send hides the form and shows the thank-you, focused, as a `status`.

**Titles:** each title's offset is its own colour and the same 0.04em, with ink text in Gveret, in both engines; the FAQ title is pink.

**Logos:** they come in the order Microsoft, Elbit Systems, בנק הפועלים, H&M, STAR CAR, in both places, and none is broken.

**Tapped view:**
- It fits all ten designs at 390×844, 375×667, 390×700, 360×740, 430×932, 1440×900, 1100×800, 1280×720 and 1024×700, with at least 19 px between the cards and the name.
- The button reads "יאללה בואו נתחיל", and no animation is left once it opens.

**Floating controls:** WhatsApp and the `#place` palette are clear and on screen at 360, 390, 430, 1100 and 1440, with and without `#place` and `#fields=off`, in both engines (30 of 30).

**Other checks:**
- The editor works by mouse and by touch; the review row stays still under a resting finger.
- 0 dealt cards on the hero text, and no page errors.
- The menu opens with focus inside.
- The designs page shows 10 views, 30 images and none broken.

**Illustrations:**
- **As before:** r14's overlaps on her story placements:
  - `pstar story 61.4, 7.8` (phone) and `pstar story 87.4, 14.2` (desktop) on the heading;
  - `star story 58.6, 55` (phone) on "ועלמה";
  - `cross order 83, 84.2` on the button under reduced motion.
- **New:** M PLUS sets wider lines than Rubik, so a few of her marks that sat just beside text now graze it. They are left where she put them:
  - Desktop (1100 and 1440):
    - `sparks top 18.2, 19` touches the end of the headline "דוגרי, המשחק";
    - `bstar top 35.8, 53.8` touches "ומה הקאץ'?" / "כל המילים עליכם!";
    - `cross top 28.2, 90.2` touches the hero button.
  - Phone at 360 only: `cross order 83, 84.2` touches "חפיסה ולוח:".

  A small nudge in `#place` clears each one.

impeccable's detector reports the same accepted findings as r14: low contrast on the outlined yellow and sky words, the cream page, and the flat type hierarchy. The form's error red, `#b3002d`, is 6.4:1 on the page.

## Before anything ships

- Remove the testing switch `#fields`, keeping the chosen field.
- Give the form a real endpoint, see 3.

## Files

| Committed | Local only |
| --- | --- |
| `r15.html`, `r15-designs.html`, `r15-faq.html`, `README-r15.md` | `media/reviews/` |
| `logos/microsoft.webp`, `logos/elbit.svg`, `logos/hapoalim.svg` | |
| `shots/r15*.png` (the founders' photos blurred from the first frame) | |
