# Template: japanese  (דוגרי יפני)

Human-supplied fields. Slot positions, colors, grid, sizes and number format
are auto-detected from the clean+filled pair — not listed here.

## fonts
- title_font: Quick.ttf
- word_font:  Fredoka-Medium.ttf

> ⚠️ **Word font is a stand-in** — real design uses **Egul**.
> #todo — replace word_font with Egul. (title_font Quick is correct.)

## title
- title_text: "{NAME}'S {AGE}S"
- lines: 2  ({NAME}'S / {AGE}S, e.g. TOMER'S 30S)
- language: english (CAPS)
- extra_fields: AGE (decade, e.g. 30)

## name
- name_form: english-caps

## pages
- fronts: clean/fronts.svg (+ filled/fronts.svg)
- backs:  clean/backs.svg  (+ filled/backs.svg)
- board:  clean/board.svg  (+ filled/board.svg)

## status
- filled (with text): present
- clean (no text):    present
- fonts:              present (title correct; words stand-in — see #todo)
