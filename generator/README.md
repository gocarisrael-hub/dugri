# Dugri card generator

Turns an order (honoree name/title + words) into print-ready cards + board,
reproducing a Canva template exactly — without Canva.

## Pipeline
1. `recipe.py`  — auto-detect a per-theme RECIPE from a text-filled full-deck
   page: the 8-card grid + each card's title/word slots (position, size,
   colour) in SVG user units. Stored in `recipes/<theme>.json`.
   (Robustness upgrade: diff the text-filled page against the client's
   text-hidden background to isolate text with zero decoration confusion.)
2. `render_card.py` — per-card render primitive: lay title + 4 words onto the
   (clean) background at the recipe geometry; render via headless Chrome.
3. TODO: `pack.py` (words CSV -> pages of 32), `render_page.py` (8 cards on one
   page), board name overlay, `build.py` (order -> one PDF).

Fonts: Mr Dafoe (title, OFL) + Cafe (Hebrew words — commercial license TBD).
