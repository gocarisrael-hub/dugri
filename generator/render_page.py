#!/usr/bin/env python3
"""Render one full 8-card page: overlay title + words onto the CLEAN background
at the recipe slots. No masking needed (background is already text-free).

  python3 generator/render_page.py <theme> <clean_svg> <csv> <row> <title> <out.png>
"""
import base64
import json
import os
import re
import subprocess
import sys
import csv as csvmod

import config

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))


def dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    return w, h


def font_face(name, path):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    return (f"@font-face{{font-family:'{name}';font-weight:400;font-style:normal;"
            f"src:url(data:font/ttf;base64,{b64}) format('truetype');}}")


def word_text(x_right, baseline, size, color, num, word):
    return (f'<text x="{x_right:.2f}" y="{baseline:.2f}" font-family="HebWord" '
            f'font-size="{size:.2f}" fill="{color}" direction="rtl" '
            f'text-anchor="start" xml:space="preserve">'
            f'<tspan font-size="{size*0.9:.2f}">{num}.</tspan> '
            f'<tspan>{escape(word)}</tspan></text>')


def escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


import functools


@functools.lru_cache(maxsize=8)
def _title_metrics(font_path, ref=200):
    from PIL import ImageFont
    return ImageFont.truetype(font_path, ref), ref


_TITLE_UID = [0]


def title_block(box, lines, fill, outline, font_path, outline_w, arch, shadow):
    _TITLE_UID[0] += 1
    uid = _TITLE_UID[0]
    """Graffiti-style stacked title: sized so the WIDEST line fills the box
    width, tight line spacing, an optional drop shadow + thick dark outline
    behind a light fill — the 3D bubble look. All style knobs come from the
    theme config: ``outline_w`` (dark ring thickness as a fraction of glyph
    size), ``arch`` (upward bulge fraction) and ``shadow`` (draw the drop
    shadow layer or not)."""
    x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
    cx = (x0 + x1) / 2
    bw, bh = x1 - x0, y1 - y0
    f, ref = _title_metrics(font_path)
    ratios = [f.getlength(ln) / ref for ln in lines]      # width per unit size
    n = len(lines)
    # size to fill the width; cap so the stacked lines still fit the box height
    size = min(bw * 0.89 / max(ratios), bh / (0.80 * n) * 1.02)
    gap = size * 0.78
    total = gap * (n - 1)
    top = (y0 + y1) / 2 - total / 2
    dx, dy = size * 0.035, size * 0.06                    # drop-shadow offset
    bulge = size * arch                                   # graffiti upward arch
    # Boldness = a heavy dark OUTLINE ring (not fattened fill). Three stacked
    # layers per line on the arched path: shadow, dark dilated body (outline),
    # light fill on top -> the visible dark ring thickness equals T. (Agent B.)
    w_fat = size * 0.005                                  # minimal body fatten
    t_ring = size * outline_w                             # dark outline ring
    outer = w_fat + 2 * t_ring
    defs, out = [], []

    def on_path(pid, fill_c, stroke_c, swv, line):
        return (f'<text font-family="TitleFont" font-size="{size:.2f}" fill="{fill_c}" '
                f'stroke="{stroke_c}" stroke-width="{swv:.2f}" paint-order="stroke" '
                f'stroke-linejoin="round" stroke-linecap="round">'
                f'<textPath href="#{pid}" startOffset="50%" text-anchor="middle">'
                f'{escape(line)}</textPath></text>')

    for k, line in enumerate(lines):
        by = top + gap * k + size * 0.33
        wln = ratios[k] * size
        xl, xr = cx - wln / 2 - size * 0.15, cx + wln / 2 + size * 0.15

        def arc(pid, ox, oy):
            defs.append(f'<path id="{pid}" fill="none" d="M {xl+ox:.1f} {by+oy:.1f} '
                        f'Q {cx+ox:.1f} {by+oy-2*bulge:.1f} {xr+ox:.1f} {by+oy:.1f}"/>')

        if shadow:
            arc(f"t{uid}s{k}", dx, dy)                    # shadow path
        arc(f"t{uid}m{k}", 0, 0)                          # main path
        if shadow:
            out.append(on_path(f"t{uid}s{k}", outline, outline, outer, line))  # shadow
        out.append(on_path(f"t{uid}m{k}", outline, outline, outer, line))   # outline
        out.append(on_path(f"t{uid}m{k}", fill, fill, w_fat, line))         # fill body
    return "<defs>" + "".join(defs) + "</defs>" + "".join(out)


def build_page(theme, clean_svg, words_by_card, title_lines, word_font=None):
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    recipe = json.load(open(os.path.join(HERE, "recipes", f"{cfg['recipe']}.json")))
    # word_font optionally overrides the theme's card font (a filename); it
    # resolves against the theme's own fonts/ dir first, then the shared
    # word-fonts/ pool. No override -> the theme's configured word_font.
    word_font = config.resolve_word_font(theme, word_font)
    title_font = config.font_path(theme, cfg["title_font"])
    ts = cfg["title_style"]
    svg = open(clean_svg, encoding="utf-8").read()
    style = ("<style>" + font_face("HebWord", word_font)
             + font_face("TitleFont", title_font) + "</style>")
    overlay = [style]
    for ci, card in enumerate(recipe["cards"]):
        if not card:
            continue
        if card.get("title") and title_lines:
            overlay.append(title_block(card["title"][0], title_lines,
                                       ts["fill"], ts["outline"], title_font,
                                       ts["outline_w"], ts["arch"], ts["shadow"]))
        words = words_by_card[ci] if ci < len(words_by_card) else []
        # A card may carry a title but no word slots (its title was drawn above);
        # skip the word pass so statistics.median([]) can't crash the whole page.
        if not card["words"]:
            continue
        # ONE uniform word size per card (like the real card); per-word ink
        # heights vary by letters, so fit from the median, not each slot.
        import statistics
        heights = [s["y1"] - s["y0"] for s in card["words"]]
        size = statistics.median(heights) * 1.4
        for wi, slot in enumerate(card["words"]):
            if wi >= len(words) or not words[wi]:
                continue
            baseline = (slot["y0"] + slot["y1"]) / 2 + size * 0.34
            overlay.append(word_text(slot["x1"], baseline, size, slot["color"],
                                     wi + 1, words[wi]))
    body = "".join(overlay)
    return svg.replace("</svg>", body + "</svg>")


def render(theme, clean_svg, words_by_card, title_lines, out_png, word_font=None):
    svg = build_page(theme, clean_svg, words_by_card, title_lines, word_font=word_font)
    svg_path = out_png.replace(".png", ".svg")
    open(svg_path, "w", encoding="utf-8").write(svg)
    w, h = dims(clean_svg)
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    "--force-device-scale-factor=2", f"--screenshot={out_png}",
                    f"--window-size={w},{h}", svg_path],
                   check=True, stderr=subprocess.DEVNULL)
    return out_png


def load_csv_row(path, row):
    rows = list(csvmod.DictReader(open(path, encoding="utf-8-sig")))
    r = rows[row]
    return [[r.get(f"c{c}w{w}", "") for w in range(1, 5)] for c in range(1, 9)]


if __name__ == "__main__":
    theme, clean, csvp, row, title, out = sys.argv[1:7]
    wbc = load_csv_row(csvp, int(row))
    render(theme, clean, wbc, title.split("|"), out)   # "OZ'S|WELCOME|PARTY"
    print("wrote", out)
