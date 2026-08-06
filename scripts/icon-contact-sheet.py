#!/usr/bin/env python3
"""Draw what the icon scan sees, so it can be judged by eye instead of asserted.

    python3 scripts/icon-contact-sheet.py [outdir] [theme ...]

One PNG per template: its CLEAN artwork with every surviving obstacle rectangle
stroked in MAGENTA and every calibrated word slot in CYAN. Classification is a
judgement about pictures — whether a shape is a badge or a backdrop — and the
only honest check is to look at it. The numbers in ``card_obstacles`` were picked
off these images and the owner asked to see them.

Not part of the render path and not imported by it: a developer tool, run by
hand, that shells out to Chrome once per template.
"""
import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(HERE, "generator")
sys.path.insert(0, GEN)

import chrome                                            # noqa: E402
import config                                            # noqa: E402
import render_page as rp                                 # noqa: E402


def _rect(box, color, width=1.2, dash=None):
    d = f' stroke-dasharray="{dash}"' if dash else ""
    return (f'<rect x="{box[0]:.2f}" y="{box[1]:.2f}" '
            f'width="{box[2] - box[0]:.2f}" height="{box[3] - box[1]:.2f}" '
            f'fill="none" stroke="{color}" stroke-width="{width}"{d}/>')


def annotate(theme, svg_text, cards):
    """``svg_text`` with the scan's answer drawn over it, plus a per-card tally."""
    marks, tally = [], []
    for label, cell, slots in cards:
        found = rp.card_obstacles(svg_text, cell)
        marks.append(_rect(cell, "#00c8ff", 0.8, "4 3"))
        for s in slots or []:
            marks.append(_rect([s["x0"], s["y0"], s["x1"], s["y1"]], "#00c8ff", 0.8))
        for b in found.rects:
            marks.append(_rect(b, "#ff00c8", 1.2))
        tally.append((label, len(found.rects), found.unreadable))
    return svg_text.replace("</svg>", "".join(marks) + "</svg>"), tally


def sheet(theme, out_dir):
    cfg = config.theme(theme)
    rec = config.recipe_or_empty(cfg)
    clean = os.path.join(config.theme_dir(theme), "clean")
    v2 = bool((cfg.get("card_slots") or {}).get("words"))
    out = []
    if v2:
        files = [(os.path.basename(p), p)
                 for p in sorted(glob.glob(os.path.join(clean, "[0-9].svg")))]
    else:
        files = [("fronts.svg", os.path.join(clean, "fronts.svg"))]
    for name, path in files:
        if not os.path.exists(path):
            print(f"  {theme}: no {name}")
            continue
        txt = open(path, encoding="utf-8").read()
        if v2:
            cell = rp._recipe_cell(rec)
            cards = [(name, cell, config.card_word_boxes(cfg, rec, cell))]
        else:
            cards = [(f"card {i + 1}", c["cell"], c.get("words"))
                     for i, c in enumerate(rec["cards"]) if c and c.get("cell")]
        marked, tally = annotate(theme, txt, cards)
        stem = f"{cfg['slug']}-{os.path.splitext(name)[0]}"
        svg_out = os.path.join(out_dir, stem + ".svg")
        png_out = os.path.join(out_dir, stem + ".png")
        open(svg_out, "w", encoding="utf-8").write(marked)
        w, h = rp.dims(path)
        chrome.screenshot(svg_out, png_out, w, h, scale=2,
                          what=f"the contact sheet for {theme}")
        for label, n, bad in tally:
            print(f"  {theme:26s} {label:9s} obstacles={n:3d}"
                  + (f"  UNREADABLE={bad}" if bad else ""))
        out.append(png_out)
    return out


def main():
    args = sys.argv[1:]
    out_dir = args[0] if args else os.path.join(HERE, "icon-contact-sheet")
    themes = args[1:] or list(json.load(
        open(os.path.join(GEN, "themes.json"), encoding="utf-8")))
    os.makedirs(out_dir, exist_ok=True)
    made = []
    for theme in themes:
        made += sheet(theme, out_dir)
    print(f"\n{len(made)} sheet(s) in {out_dir}")


if __name__ == "__main__":
    main()
