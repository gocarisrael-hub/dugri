#!/usr/bin/env python3
"""Per-card render primitive for the bachelorette (רווקות) theme.

Given a card's text (honoree title line + 4 words), lay it onto the real Canva
card background at the calibrated slot geometry and render a print-quality card
via headless Chrome. This is the unit the page/PDF builder repeats.

Geometry here is the output of the auto-fit calibration (fit.py): it reproduces
the real card. Swap the background for the client's text-hidden export and the
same numbers place text into a seam-free card.

  python3 generator/render_card.py            # renders two sample orders
"""
import base64
import glob
import os
import re
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")

# --- calibrated recipe for the bachelorette card (from fit.py) ---
VIEWBOX = "9.5 10 192 277"           # crop of the deck page to one card
OUT_W, OUT_H = 576, 831
SRC_BG, BG = "#ffc6d7", "#f6c8d7"    # source pink -> real card pink
INK, TITLE_COL = "#664e56", "#ac8d97"
NUM_X, NUM_SIZE, WORD_SIZE = 156.4, 16.0, 17.8
WORD_BASELINES = [116.0, 143.0, 170.0, 197.0]
WORD_STROKE = 0.11
TITLE = [dict(x=158.0, y=45.0, size=15.0), dict(x=177.0, y=59.0, size=18.0)]
FONTS = {"CardHebrew": os.path.join(HERE, "Cafe-Regular.ttf"),
         "CardScript": os.path.join(HERE, "MrDafoe-Regular.ttf")}


def find_canva():
    for p in [os.path.join(ROOT, "resources/canva/full deck/דוגרי רווקות חדש/1.svg")]:
        if os.path.exists(p):
            return p
    return glob.glob(os.path.join(ROOT, "**/דוגרי רווקות חדש/1.svg"), recursive=True)[0]


def font_face(name, path):
    b64 = base64.b64encode(open(path, "rb").read()).decode()
    return (f"@font-face{{font-family:'{name}';font-weight:400;font-style:normal;"
            f"src:url(data:font/ttf;base64,{b64}) format('truetype');}}")


def stroke(delta, ink):
    if abs(delta) < 1e-3:
        return ""
    col = ink if delta > 0 else BG
    return f' stroke="{col}" stroke-width="{abs(delta):.3f}" paint-order="fill"'


def build_svg(title_lines, words):
    """title_lines: [line1, line2]; words: list of up to 4 strings."""
    svg = open(find_canva(), encoding="utf-8").read()
    svg = svg.replace(SRC_BG, BG).replace(SRC_BG.upper(), BG)
    svg = re.sub(r'\bwidth="\d+"', f'width="{OUT_W}"', svg, 1)
    svg = re.sub(r'\bheight="\d+"', f'height="{OUT_H}"', svg, 1)
    svg = re.sub(r'viewBox="[^"]*"', f'viewBox="{VIEWBOX}"', svg, 1)

    style = "<style>" + font_face("CardHebrew", FONTS["CardHebrew"]) + \
        font_face("CardScript", FONTS["CardScript"]) + "</style>"
    # masks over the original title + words bands (solid-bg -> seam-free)
    masks = (f'<rect x="74" y="24" width="120" height="52" fill="{BG}"/>'
             f'<rect x="34" y="82" width="164" height="140" fill="{BG}"/>')

    ts = stroke(0.0, TITLE_COL)
    title = "".join(
        f'<text x="{t["x"]:.2f}" y="{t["y"]:.2f}" font-family="CardScript" '
        f'font-size="{t["size"]:.2f}" fill="{TITLE_COL}"{ts} text-anchor="end">'
        f'{txt}</text>'
        for t, txt in zip(TITLE, title_lines))

    # RTL numbered line: the marker ("1.") sits on the RIGHT (the Hebrew reading
    # start) and the word flows to its LEFT. Chrome's SVG text engine ignores
    # ``direction="rtl"`` for run ordering, and mixing Hebrew + digits + the
    # neutral "." in one <text> makes bidi split the "." from its digit — so we
    # render the marker and word as TWO independent <text> elements (no bidi
    # crosses the boundary): the marker's right edge is pinned to NUM_X and the
    # word is right-aligned just left of it, measuring the marker width for the gap.
    from PIL import ImageFont
    hebfont = ImageFont.truetype(FONTS["CardHebrew"], 200)
    sw = stroke(WORD_STROKE, INK)
    body = ""
    for i, (y, w) in enumerate(zip(WORD_BASELINES, words), start=1):
        marker = f"{i}."
        marker_w = hebfont.getlength(marker) / 200 * NUM_SIZE
        word_x = NUM_X - marker_w - WORD_SIZE * 0.30
        body += (f'<text x="{NUM_X:.2f}" y="{y:.2f}" font-family="CardHebrew" '
                 f'font-size="{NUM_SIZE:.2f}" fill="{INK}"{sw} '
                 f'text-anchor="end" xml:space="preserve">{marker}</text>'
                 f'<text x="{word_x:.2f}" y="{y:.2f}" font-family="CardHebrew" '
                 f'font-size="{WORD_SIZE:.2f}" fill="{INK}"{sw} '
                 f'text-anchor="end" xml:space="preserve">{w}</text>')
    return svg.replace("</svg>", style + masks + title + body + "</svg>")


def render(title_lines, words, out_png):
    svg_path = out_png.replace(".png", ".svg")
    open(svg_path, "w", encoding="utf-8").write(build_svg(title_lines, words))
    subprocess.run([CHROME, "--headless", "--no-sandbox",
                    "--disable-dev-shm-usage", "--disable-gpu",
                    "--force-device-scale-factor=2", f"--screenshot={out_png}",
                    "--window-size=576,831", svg_path],
                   check=True, stderr=subprocess.DEVNULL)
    return out_png


if __name__ == "__main__":
    os.makedirs("/tmp/gen", exist_ok=True)
    render(["Noa's", "Bachelorette"],
           ["חתונה בקיץ", "ריקודים", "השמלה הלבנה", "טיול רווקות"],
           "/tmp/gen/order_noa.png")
    render(["Dana's", "Bachelorette"],
           ["בר בתל אביב", "נעלי עקב", "הזמנות", "מסיבת הפתעה"],
           "/tmp/gen/order_dana.png")
    print("rendered /tmp/gen/order_noa.png and order_dana.png")
