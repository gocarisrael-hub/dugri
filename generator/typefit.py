"""What size the press will actually set — asked, not guessed.

The calibration screen carries its own copy of the fit, in JavaScript, so it can
answer while a box is being dragged. A second implementation of anything drifts,
and this one has: it read 21.05 where the press printed 12.94, it clamped a
pinned size the press honours, and it fed the settled pitch back into the
spacing so a wall of cards decayed. Every one of those was invisible until the
two answers were put side by side.

So the screen stops guessing about the number that matters. It sends the words
and the knobs here, THE GENERATOR ITSELF answers, and the screen shows both. A
disagreement is then something the owner sees on the page rather than something
that reaches a customer's deck.

  echo '{"theme":"grapefruit","words":["מסיבה","ריקודים","צחוקים","חברים"]}' \\
      | python3 typefit.py

Answers `{word_size, title_size, lines, ...}` in card viewBox units — the same
units card_slots is written in, so the two numbers are directly comparable.

`overrides` merges over the theme entry WITHOUT saving, which is the whole point
during a calibration: the owner is asking about numbers she has not committed to.
"""
import json
import sys

from PIL import ImageFont

import config
import render_page as R


def _slots(cfg, cell):
    """The four word boxes in viewBox units, from the entry's own card_slots."""
    slots = config.card_slots(cfg) or {}
    out = []
    for frac in (slots.get("words") or [])[: config.CARD_WORD_SLOTS]:
        box = R._box_from_frac(frac, cell) if hasattr(R, "_box_from_frac") else {
            "x0": frac["x0"] * cell[2], "y0": frac["y0"] * cell[3],
            "x1": frac["x1"] * cell[2], "y1": frac["y1"] * cell[3],
        }
        box["color"] = "#000"
        out.append(box)
    return out


def typefit(theme, words, overrides=None, title_lines=None):
    cfg = dict(config.theme(theme))
    # Unsaved knobs answer for themselves — she is asking about numbers she has
    # not committed to yet, which is the only moment the answer is useful.
    cfg.update(overrides or {})

    vb = cfg.get("card_viewbox") or {"w": 223.92, "h": 312}
    cell = [0, 0, float(vb["w"]), float(vb["h"])]
    slots = _slots(cfg, cell)
    if not slots:
        return {"error": "this template has no calibrated word slots"}

    face = config.resolve_word_font(theme)
    font = ImageFont.truetype(face, 200)
    layouts = R._word_layouts(
        slots, list(words)[: len(slots)], font, 200, cell=cell,
        word_size=cfg.get("word_size"),
        max_size=config.type_ceiling(cfg, "word_max_he"),
    )
    live = [l for l in layouts if l]
    out = {
        "theme": theme,
        "word_size": round(max((l.size for l in live), default=0.0), 4),
        "lines": [None if l is None else len(l.lines) for l in layouts],
        "word_box": round(slots[0]["y1"] - slots[0]["y0"], 4) if slots else None,
    }

    lines = title_lines or config.title_lines(cfg, "MAYA") if hasattr(config, "title_lines") \
        else (title_lines or ["MAYA"])
    boxes = (config.card_slots(cfg) or {}).get("titles") or {}
    if boxes:
        first = sorted(boxes, key=lambda k: int(k))[0]
        frac = boxes[first]
        tbox = {"x0": frac["x0"] * cell[2], "y0": frac["y0"] * cell[3],
                "x1": frac["x1"] * cell[2], "y1": frac["y1"] * cell[3]}
        import re
        svg = R.title_block(
            tbox, list(lines), "#000", "#000", config.resolve_title_font(theme),
            0.0, 0.0, False,
            rtl=R.title_is_rtl(cfg, list(lines)),
            fixed_size=(cfg.get("title_style") or {}).get("size"),
            max_size=R.title_ceiling(cfg, list(lines)),
            align=(cfg.get("title_style") or {}).get("align", "center"),
        )
        sizes = [float(m) for m in re.findall(r'font-size="([0-9.]+)"', "".join(svg))]
        out["title_size"] = round(max(sizes), 4) if sizes else None
    return out


def main():
    req = json.load(sys.stdin)
    try:
        print(json.dumps(typefit(
            req["theme"], req.get("words") or [],
            req.get("overrides"), req.get("title_lines"))))
    except KeyError as exc:
        # A HANDLED error is still an answer: it exits 0 so the caller reads
        # {"error": ...} and can say WHICH template it could not find. A non-zero
        # exit is reserved for a crash, which the route reports as a 502 — the
        # difference between "no such template" and "the generator fell over"
        # matters to whoever is looking at the screen.
        print(json.dumps({"error": "unknown theme or missing field: %s" % exc}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
