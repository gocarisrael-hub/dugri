#!/usr/bin/env python3
"""Assemble a full order into ONE print-ready PDF: front card pages (title +
words from the CSV) + the game board (title) — onto the clean text-free
backgrounds.

  python3 generator/build.py <theme> <fronts_clean.svg> <board_clean.svg> \
                             <csv> <NAME> <out.pdf>

NAME is the honoree as it appears in the title, e.g. OZ  ->  "OZ'S WELCOME PARTY".
"""
import os
import subprocess
import sys
import re
from PIL import Image

import render_page as rp

CHROME = rp.CHROME
HERE = os.path.dirname(os.path.abspath(__file__))

# board title slot, measured by diffing text-filled vs clean board (fractions)
BOARD_TITLE_FRAC = dict(x0=0.020, y0=0.883, x1=0.135, y1=0.985)
TITLE_FILL, TITLE_OUTLINE = "#97d8e6", "#0d3e43"


def svg_dims(svg):
    head = open(svg, encoding="utf-8").read(2000)
    w = int(re.search(r'width="(\d+)"', head).group(1))
    h = int(re.search(r'height="(\d+)"', head).group(1))
    vb = [float(x) for x in re.search(r'viewBox="([^"]+)"', head).group(1).split()]
    return w, h, vb


def render_svg(svg_text, w, h, out_png):
    p = out_png.replace(".png", ".svg")
    open(p, "w", encoding="utf-8").write(svg_text)
    subprocess.run([CHROME, "--headless", "--disable-gpu",
                    "--force-device-scale-factor=2", f"--screenshot={out_png}",
                    f"--window-size={w},{h}", p], check=True, stderr=subprocess.DEVNULL)
    return out_png


def render_board(board_clean, title_lines, out_png):
    w, h, vb = svg_dims(board_clean)
    box = {k: (BOARD_TITLE_FRAC[k] * vb[2] if "x" in k else BOARD_TITLE_FRAC[k] * vb[3])
           for k in BOARD_TITLE_FRAC}
    svg = open(board_clean, encoding="utf-8").read()
    style = "<style>" + rp.font_face("TitleFont", rp.TITLE_FONT) + "</style>"
    body = style + rp.title_block(box, title_lines, TITLE_FILL, TITLE_OUTLINE)
    return render_svg(svg.replace("</svg>", body + "</svg>"), w, h, out_png)


def main():
    theme, fronts, board, csvp, name, out_pdf = sys.argv[1:7]
    title_lines = [f"{name.upper()}'S", "WELCOME", "PARTY"]
    os.makedirs("/tmp/gen/build", exist_ok=True)
    rows = rp.load_csv_row  # noqa
    import csv as csvmod
    data = list(csvmod.DictReader(open(csvp, encoding="utf-8-sig")))

    pages = []
    for i in range(len(data)):
        wbc = rp.load_csv_row(csvp, i)
        png = f"/tmp/gen/build/front_{i+1}.png"
        rp.render(theme, fronts, wbc, title_lines, png)
        pages.append(png)
        print(f"front page {i+1}/{len(data)}")
    board_png = render_board(board, title_lines, "/tmp/gen/build/board.png")
    pages.append(board_png)
    print("board")

    imgs = [Image.open(p).convert("RGB") for p in pages]
    imgs[0].save(out_pdf, save_all=True, append_images=imgs[1:], resolution=300)
    print(f"\nwrote {out_pdf}  ({len(pages)} pages: {len(data)} fronts + board)")


if __name__ == "__main__":
    main()
