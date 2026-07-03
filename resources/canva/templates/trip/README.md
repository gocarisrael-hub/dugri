# Template: trip  (חזרה מטיול)

Everything the generator needs that it CANNOT auto-detect. Slot positions,
colors, grid, sizes and number format are detected automatically from the
clean+filled pair — do NOT list those here.

## fonts
- title_font: fonts/title.otf   — the big graffiti title (Sprite Graffiti)
- word_font:  fonts/words.ttf   — the Hebrew words (almoni-neue; real design font is FB Bloomfield)

## title
- title_text: "{NAME}'S WELCOME PARTY"
- lines: 3          # line1 "{NAME}'S", line2 "WELCOME", line3 "PARTY"
- language: english # the name is transliterated to English caps

## name
- title_name_form: english-caps   # order name "oz" -> "OZ'S"
- board_name_form: same-as-title   # the same title logo, bottom-left of the board

## pages
- fronts: clean/fronts.svg   (+ filled/fronts.svg)   # 8 cards: title + 4 words each
- backs:  clean/backs.svg    (+ filled/backs.svg)    # 8 backs: centered title
- board:  clean/board.svg    (+ filled/board.svg)    # title bottom-left corner
