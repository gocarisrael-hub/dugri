# Template: anniversary  (דוגרי יום נישואין)

Human-supplied fields. Slot positions, colors, grid, sizes and number format
are auto-detected from the clean+filled pair — not listed here.

## fonts
- title_font: Shmulik CLM Medium.ttf
- word_font:  Dana Yad AlefAlefAlef Normal.ttf

> ⚠️ **Fonts not matching the real design — both are stand-ins.**
> #todo — title_font real is **Extaza** (not free); swap when sourced.
> #todo — word_font real is **Dganit** (not free); swap when sourced.

## title
- title_text: "{YEARS} שנה נישואין\n{NAME1} ו{NAME2}"
- lines: 2  (Hebrew: e.g. ‏30 שנה נישואין / מיכל וזאבי)
- language: hebrew
- extra_fields: YEARS, NAME1, NAME2 (two honorees)

## name
- name_form: hebrew

## pages
- fronts: clean/fronts.svg (+ filled/fronts.svg)
- backs:  clean/backs.svg  (+ filled/backs.svg)
- board:  clean/board.svg  (+ filled/board.svg)

## status
- filled (with text): present
- clean (no text):    present
- fonts:              present (stand-ins — see #todo above)
