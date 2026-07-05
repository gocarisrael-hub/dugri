# Word lists (מאגרי מילים)

Curated, reusable seed word lists for the Dugri guessing game — one file per
audience / event type. These are **starting points**: mix them with the
customer's own personal words (people, inside jokes, habits) to reach the
100+ words an order needs. A good Dugri word is **guessable, funny, and
culturally relatable** — not obscure.

## Files

### Game database — 6 balanced lists of exactly 350 words each

Professionally-designed Alias-style pools. The **generic** list is fully
disjoint from every themed list; each themed list is ~260 generic fillers +
~90 theme words, shuffled together. Hebrew-only, ≤3 words, no proper/brand
names, numbers, or slang.

| File | List | Count |
|------|------|-------|
| `generic-350.txt` | Generic (exclusive — appears in no themed list) | 350 |
| `bachelorette-350.txt` | Bachelorette party — מסיבת רווקות | 350 |
| `kids-birthday-350.txt` | Children's birthday — יום הולדת לילדים | 350 |
| `family-350.txt` | Family — משפחה | 350 |
| `anniversary-350.txt` | Wedding anniversary — יום נישואין | 350 |
| `friends-350.txt` | Friends gathering — מפגש חברים | 350 |

### Earlier curated seed lists

| File | Audience | Count |
|------|----------|-------|
| `friends-25-final.txt` | Group of friends, ~25 y/o (Hadar's picks + more) | 239 |
| `combined-416.txt` | CSV deck words + random friends words, shuffled | 416 |
| `hadar list.txt` | Hadar's hand-picked seed | 112 |
| `friends-25.txt` | Original draft | 300 |

## Format

- One word or short phrase **per line**, UTF-8. Keep each entry **≤ 3 words**.
- Keep words **easy and guessable** — funny/relatable beats clever/obscure.
- **Blank lines are allowed** and ignored — used here to separate themes.
- **No comment lines** (the CSV builder treats every non-empty line as a word),
  so theme labels live in this README, not in the `.txt`.
- Avoid commas inside a line (keeps CSV export clean).

`friends-25.txt` themes, in order: Israeli slang · dating & relationships ·
army & reserves · nightlife & alcohol · food · reality TV & celebs ·
social media & memes · 90s/2000s nostalgia · places in Israel ·
parties & embarrassments · spicy bonus.

## Using a list

Feed a list into the Bulk Create CSV builder (see `build_csv` in the root
`CLAUDE.md`) to produce the 32-column `c1w1…c8w4` sheet — it strips blank
lines and dedupes for you:

```python
words = open('content/wordlists/friends-25.txt', encoding='utf-8').read().splitlines()
build_csv(words, 'friends-25.csv')   # shuffles, dedupes, pads to full pages
```
