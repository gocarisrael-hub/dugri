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
# placeholder Hebrew word font until the theme's real font is provided
HEB = os.path.join(HERE, "..", "poc", "svglue", "fonts", "VarelaRound.ttf")


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


def build_page(theme, clean_svg, words_by_card, title_lines):
    recipe = json.load(open(os.path.join(HERE, "recipes", f"{theme}.json")))
    svg = open(clean_svg, encoding="utf-8").read()
    style = "<style>" + font_face("HebWord", HEB) + "</style>"
    overlay = [style]
    for ci, card in enumerate(recipe["cards"]):
        if not card:
            continue
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
    render(theme, clean, wbc, [title], out)
    print("wrote", out)
