#!/usr/bin/env python3
"""Render one full 8-card page: overlay title + words onto the CLEAN background
at the recipe slots. No masking needed (background is already text-free).

  python3 generator/render_page.py <theme> <clean_svg> <csv> <row> <title> <out.png>
"""
import base64
import functools
import json
import os
import re
import subprocess
import sys
import csv as csvmod

import config

CHROME = os.environ.get(
    "CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
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


@functools.lru_cache(maxsize=8)
def _word_metrics(font_path, ref=200):
    from PIL import ImageFont
    return ImageFont.truetype(font_path, ref), ref


def word_text(x_right, baseline, size, color, num, word, font_path):
    # RTL numbered line: the marker ("1.") must sit on the RIGHT (the Hebrew
    # reading start) and the word flow to its LEFT. Chrome's headless SVG text
    # engine ignores ``direction="rtl"`` (and inline bidi controls) for run
    # ORDERING, and when Hebrew + digits + the neutral "." share one <text> the
    # bidi algorithm reorders the "." AWAY from its digit (".01" / marker on the
    # wrong side). So we render the marker and the word as TWO independent <text>
    # elements — no bidi can cross the element boundary. The marker is pinned by
    # its right edge to the slot's right edge; the word is right-aligned just to
    # its left, measuring the marker's width so the gap is exact.
    marker = f"{num}."
    msize = size * 0.9
    font, ref = _word_metrics(font_path)
    marker_w = font.getlength(marker) / ref * msize
    gap = size * 0.30
    word_x = x_right - marker_w - gap
    return (
        f'<text x="{x_right:.2f}" y="{baseline:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" text-anchor="end" '
        f'xml:space="preserve">{marker}</text>'
        f'<text x="{word_x:.2f}" y="{baseline:.2f}" font-family="HebWord" '
        f'font-size="{size:.2f}" fill="{color}" text-anchor="end" '
        f'xml:space="preserve">{escape(word)}</text>'
    )


def escape(s):
    return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


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
                                     wi + 1, words[wi], word_font))
    body = "".join(overlay)
    return svg.replace("</svg>", body + "</svg>")


def render(theme, clean_svg, words_by_card, title_lines, out_png, word_font=None):
    svg = build_page(theme, clean_svg, words_by_card, title_lines, word_font=word_font)
    svg_path = out_png.replace(".png", ".svg")
    open(svg_path, "w", encoding="utf-8").write(svg)
    w, h = dims(clean_svg)
    subprocess.run([CHROME, "--headless", "--no-sandbox",
                    "--disable-dev-shm-usage", "--disable-gpu",
                    "--force-device-scale-factor=2", f"--screenshot={out_png}",
                    f"--window-size={w},{h}", svg_path],
                   check=True, stderr=subprocess.DEVNULL)
    return out_png


def load_csv_row(path, row):
    rows = list(csvmod.DictReader(open(path, encoding="utf-8-sig")))
    r = rows[row]
    return [[r.get(f"c{c}w{w}", "") for w in range(1, 5)] for c in range(1, 9)]


def _sample_cell(recipe):
    """Cell of a representative card: the first that carries a title, else the
    first non-empty card. Mirrors preview.py's front-card pick so the cropped
    back matches the cropped card's aspect."""
    cards = recipe["cards"]
    for c in cards:
        if c and c.get("title"):
            return c["cell"]
    for c in cards:
        if c:
            return c["cell"]
    return cards[0]["cell"]


def render_back(theme, name, out_dir, extra_fields=None, max_w=700):
    """Render the design's REAL personalized card BACK for the order preview and
    return ``{"back": path}`` (or ``{}`` if the theme has no back art).

    Uses the same production path as the duplex PDF (``build.render_backs`` — the
    centered title on the design's clean back), then crops ONE back out of the
    8-up sheet (same recipe cell preview.py uses for the front card) and
    down-samples it, so the returned back mirrors the returned card exactly."""
    import json as _json
    import build
    from PIL import Image

    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    backs_clean = config.clean_path(theme, "backs")
    if not os.path.exists(backs_clean):
        return {}
    os.makedirs(out_dir, exist_ok=True)
    tlines = config.title_lines(cfg, name, extra_fields or {})
    with open(os.path.join(HERE, "recipes", f"{cfg['recipe']}.json"), encoding="utf-8") as f:
        recipe = _json.load(f)

    full = os.path.join(out_dir, "back_full.png")
    build.render_backs(theme, backs_clean, tlines, full)

    x0, y0, x1, y1 = _sample_cell(recipe)
    _, _, vbw, vbh = recipe["viewBox"]
    img = Image.open(full)
    sx, sy = img.width / vbw, img.height / vbh
    box = (
        max(0, int(x0 * sx)),
        max(0, int(y0 * sy)),
        min(img.width, int(round(x1 * sx))),
        min(img.height, int(round(y1 * sy))),
    )
    crop = img.crop(box)
    if crop.width > max_w:
        h = round(crop.height * max_w / crop.width)
        crop = crop.resize((max_w, h), Image.LANCZOS)
    out = os.path.join(out_dir, "back.png")
    crop.save(out)
    return {"back": out}


def _parse_fields(pairs):
    out = {}
    for p in pairs or []:
        if "=" in p:
            k, v = p.split("=", 1)
            out[k.strip()] = v
    return out


if __name__ == "__main__":
    # Back-render mode for the order preview (spawned by server /api/preview):
    #   python3 render_page.py --back <theme> <name> <out_dir> [--field K=V ...]
    # Prints a JSON line {"back": path} (or {}) the server parses.
    if len(sys.argv) > 1 and sys.argv[1] == "--back":
        _theme, _name, _out = sys.argv[2:5]
        # remaining args are "--field K=V" pairs; _parse_fields keeps only K=V.
        _fields = _parse_fields(sys.argv[5:])
        import json as _json
        print(_json.dumps(render_back(_theme, _name, _out, _fields)))
    else:
        theme, clean, csvp, row, title, out = sys.argv[1:7]
        wbc = load_csv_row(csvp, int(row))
        render(theme, clean, wbc, title.split("|"), out)   # "OZ'S|WELCOME|PARTY"
        print("wrote", out)
