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

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
HERE = os.path.dirname(os.path.abspath(__file__))
# Hebrew word font. Real theme font is FB Bloomfield (not yet sourced); using
# nrkis as the stand-in per request.
HEB = os.path.join(HERE, "..", "resources", "canva", "fonts", "nrkis.ttf")
# title display font for the trip theme (the "WELCOME PARTY" bubble font)
TITLE_FONT = os.path.join(HERE, "..", "resources", "canva", "fonts",
                          "sprite-graffiti", "Sprite Graffiti.otf")


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


def title_block(box, lines, fill, outline):
    """Stack the title lines centered in the title box (Sprite Graffiti), as a
    light fill with a dark outline (paint-order:stroke -> outline behind fill)."""
    x0, y0, x1, y1 = box["x0"], box["y0"], box["x1"], box["y1"]
    cx = (x0 + x1) / 2
    n = len(lines)
    line_h = (y1 - y0) / n
    size = line_h * 1.02
    out = []
    for k, line in enumerate(lines):
        baseline = y0 + line_h * k + size * 0.82
        out.append(f'<text x="{cx:.2f}" y="{baseline:.2f}" font-family="TitleFont" '
                   f'font-size="{size:.2f}" fill="{fill}" stroke="{outline}" '
                   f'stroke-width="{size*0.06:.2f}" paint-order="stroke" '
                   f'stroke-linejoin="round" text-anchor="middle" '
                   f'xml:space="preserve">{escape(line)}</text>')
    return "".join(out)


def build_page(theme, clean_svg, words_by_card, title_lines):
    recipe = json.load(open(os.path.join(HERE, "recipes", f"{theme}.json")))
    svg = open(clean_svg, encoding="utf-8").read()
    style = ("<style>" + font_face("HebWord", HEB)
             + font_face("TitleFont", TITLE_FONT) + "</style>")
    overlay = [style]
    for ci, card in enumerate(recipe["cards"]):
        if not card:
            continue
        if card.get("title") and title_lines:
            # trip title style: light-cyan fill + dark outline (sampled off the
            # real card). TODO: store fill/outline per theme in the recipe.
            overlay.append(title_block(card["title"][0], title_lines,
                                       "#97d8e6", "#0d3e43"))
        words = words_by_card[ci] if ci < len(words_by_card) else []
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


def render(theme, clean_svg, words_by_card, title_lines, out_png):
    svg = build_page(theme, clean_svg, words_by_card, title_lines)
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
