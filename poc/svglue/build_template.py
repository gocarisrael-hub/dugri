#!/usr/bin/env python3
"""
POC: build an svglue text-fillable template for the bachelorette (רווקות) card.

Approach (reuse the real design art, don't redraw):
  1. Take the Canva full-deck source page 1 and crop (via viewBox) to the
     top-left card, which is exactly the reference "real card" art:
     pink background + disco ball (top-left) + heels (bottom-right).
  2. Paint background-pink masks over the two baked-text bands (the script
     title, and the 4 numbered words) so the outlined Canva text disappears
     while the decorations stay pixel-identical.
  3. Overlay real <text> with <tspan template-id="..."> placeholders for the
     honoree title + the 4 words, positioned/sized/coloured to match the
     original slots. svglue only rewrites tspan text, never geometry, so RTL /
     font / size behaviour is fully under our control here.

Fonts are embedded as @font-face (base64) so the template renders identically
anywhere Chrome/rsvg can read it.

Output: poc/svglue/template.svg
"""
import base64
import glob
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
# Canva deck source is an (untracked) design resource; look in the worktree
# first, then fall back to the main checkout.
CANVA_CANDIDATES = [
    os.path.join(HERE, "source_deck.svg"),
    "/Users/hadar/projects/alias/resources/canva/full deck/with backgrounf/"
    "דוגרי רווקות חדש/1.svg",
]


def find_canva():
    for p in CANVA_CANDIDATES:
        if os.path.exists(p):
            return p
    hits = glob.glob(
        "/Users/hadar/projects/alias/**/דוגרי רווקות חדש/1.svg", recursive=True
    )
    if hits:
        return hits[0]
    raise SystemExit("Canva source deck 1.svg not found")


# --- design colours (from the design's colour anchors) ---
BG = "#ffc6d7"          # card background pink  (anchor c3)
INK = "#6b4d56"         # dark mauve, used for the words (anchor c0)
TITLE_COL = "#a07f8b"   # lighter mauve for the script title (~anchor c1)

# --- crop: top-left card lives at user origin (9,10), ~192x277 ---
VIEWBOX = "9.5 10 192 277"
OUT_W, OUT_H = 576, 831   # 3x for a crisp raster


def font_face(name, filename):
    p = os.path.join(HERE, "fonts", filename)
    b64 = base64.b64encode(open(p, "rb").read()).decode("ascii")
    return (
        f"@font-face{{font-family:'{name}';font-style:normal;font-weight:400;"
        f"src:url(data:font/ttf;base64,{b64}) format('truetype');}}"
    )


def build():
    svg = open(find_canva(), "r", encoding="utf-8").read()

    # 1) retarget the root <svg> to crop to the top-left card
    svg = re.sub(r'\bwidth="\d+"', f'width="{OUT_W}"', svg, count=1)
    svg = re.sub(r'\bheight="\d+"', f'height="{OUT_H}"', svg, count=1)
    svg = re.sub(r'viewBox="[^"]*"', f'viewBox="{VIEWBOX}"', svg, count=1)

    # 2) embedded fonts
    heb = os.environ.get("HEB_FONT", "Marhey.ttf")
    style = (
        "<style>"
        + font_face("CardHebrew", heb)               # words  (rounded Hebrew)
        + font_face("CardScript", "GreatVibes.ttf")  # title  (English script)
        + "</style>"
    )

    # 3) overlay: masks + text placeholders (card user coords)
    # -- masks that erase the baked outlined text --
    masks = (
        # title band (top-right); clear of the disco ball on the left
        f'<rect x="74" y="24" width="120" height="52" fill="{BG}"/>'
        # words band (middle); clear of disco (above) and heels (below)
        f'<rect x="34" y="82" width="164" height="140" fill="{BG}"/>'
    )

    # -- title: two lines, honoree name is the fillable slot --
    title = (
        f'<text x="184" y="43" font-family="CardScript" font-size="18" '
        f'fill="{TITLE_COL}" text-anchor="end">'
        f'<tspan template-id="title">Shira\'s</tspan></text>'
        f'<text x="186" y="61" font-family="CardScript" font-size="22" '
        f'fill="{TITLE_COL}" text-anchor="end">Bachelorette</text>'
    )

    # -- 4 numbered words --
    # baselines and the right margin were measured off the real card
    baselines = [110, 137, 164, 191]
    num_x = 154      # right margin where the number sits
    word_x = 134     # right edge of the Hebrew word (left of the number+gap)
    words = []
    for i, y in enumerate(baselines, start=1):
        # fixed index, Hebrew-style ".N" (period left, digit rightmost),
        # right-aligned at the margin
        words.append(
            f'<text x="{num_x}" y="{y}" font-family="CardHebrew" '
            f'font-size="15" fill="{INK}" text-anchor="end">.{i}</text>'
        )
        # fillable Hebrew word: RTL, right edge anchored just left of number
        words.append(
            f'<text x="{word_x}" y="{y}" font-family="CardHebrew" '
            f'font-size="16" fill="{INK}" direction="rtl" '
            f'text-anchor="start" xml:space="preserve">'
            f'<tspan template-id="word{i}">מילה {i}</tspan></text>'
        )
    overlay = style + masks + title + "".join(words)

    # 4) inject overlay just before </svg>
    svg = svg.replace("</svg>", overlay + "</svg>")

    out = os.path.join(HERE, "template.svg")
    open(out, "w", encoding="utf-8").write(svg)
    print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    build()
