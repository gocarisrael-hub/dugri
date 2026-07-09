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


def _marker_geometry(font, ref, num, msize):
    # Standard numbered look in RTL: the DIGIT is the rightmost glyph and the
    # PERIOD sits immediately to its LEFT (so reading right-to-left gives "1."),
    # then a gap, then the word. Digit and period are separate <text> runs so
    # bidi can never reorder the "." away from its digit. Returns the digit
    # string, the period's right-anchor offset relative to the digit's right
    # edge (a negative number), and the marker's total width (digit + tiny
    # inter-gap + period) — the caller uses the width to place the word.
    digit = f"{num}"
    digit_w = font.getlength(digit) / ref * msize
    dot_w = font.getlength(".") / ref * msize
    tiny = msize * 0.06                      # hairline gap between digit & period
    dot_x = -digit_w - tiny                  # period right edge, just left of digit
    marker_w = digit_w + tiny + dot_w        # full marker span (digit..period)
    return digit, dot_x, marker_w


def word_text(x_right, baseline, size, color, num, word, font_path):
    # RTL numbered line: the marker must sit on the RIGHT (the Hebrew reading
    # start) and the word flow to its LEFT. Chrome's headless SVG text engine
    # ignores ``direction="rtl"`` (and inline bidi controls) for run ORDERING,
    # and when Hebrew + digits + the neutral "." share one <text> the bidi
    # algorithm reorders the "." AWAY from its digit. So we render the DIGIT,
    # the PERIOD and the WORD as THREE independent right-anchored <text> runs —
    # no bidi crosses an element boundary. The digit's right edge is pinned to
    # the slot's right edge (rightmost glyph); the period is pinned just to its
    # LEFT; the word is right-aligned just left of the whole marker.
    msize = size * 0.9
    font, ref = _word_metrics(font_path)
    digit, dot_x, marker_w = _marker_geometry(font, ref, num, msize)
    gap = size * 0.30
    word_x = x_right - marker_w - gap
    return (
        f'<text x="{x_right:.2f}" y="{baseline:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" text-anchor="end" '
        f'direction="ltr" xml:space="preserve">{digit}</text>'
        f'<text x="{x_right + dot_x:.2f}" y="{baseline:.2f}" font-family="HebWord" '
        f'font-size="{msize:.2f}" fill="{color}" text-anchor="end" '
        f'xml:space="preserve">.</text>'
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


def title_is_rtl(cfg):
    # A title is right-to-left when the theme's language is Hebrew. RTL matters
    # for any title that mixes digits with Hebrew (e.g. anniversary "30 שנה
    # נישואין" or "{NAME} בן {AGE}"): with the default LTR base direction the
    # leading/embedded digit run lays out on the wrong side. English themes stay
    # LTR and are untouched.
    return cfg.get("language") == "hebrew"


def title_block(box, lines, fill, outline, font_path, outline_w, arch, shadow,
                rtl=False):
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
    # RTL (Hebrew) titles: set a right-to-left BASE direction on the <text> so a
    # mixed digit+Hebrew line (e.g. "30 שנה נישואין") reads correctly — the number
    # on the RIGHT (Hebrew reading start), not the LEFT. VERIFIED against the real
    # headless-Chrome SVG rasterizer this generator targets: `direction="rtl"`
    # correctly reorders the runs for BOTH a leading digit ("30 שנה נישואין" ->
    # 30 on the right) and a trailing digit ("{NAME} בן {AGE}" -> age on the
    # left). It does NOT reverse the digits themselves (unlike unicode-bidi
    # "bidi-override", which renders "30" as "03"), so plain `direction="rtl"` is
    # the right, self-contained fix here — no run-splitting like word_text needs.
    # (Not a contradiction with word_text's "Chrome ignores direction=rtl" note:
    # THAT path has a NEUTRAL "." wedged between a Hebrew word and a digit inside
    # ONE plain <text>, where the neutral is reordered away from its digit and a
    # base direction can't pin it — hence its three-run split. A title line has no
    # such stranded neutral: it is a digit run beside Hebrew words on a textPath,
    # where the base direction IS honored. Verified via the real rasterizer in
    # test_title_block_rtl_reorders_digit_in_raster.)
    dir_attr = ' direction="rtl"' if rtl else ""

    def on_path(pid, fill_c, stroke_c, swv, line):
        return (f'<text font-family="TitleFont" font-size="{size:.2f}" fill="{fill_c}" '
                f'stroke="{stroke_c}" stroke-width="{swv:.2f}" paint-order="stroke" '
                f'stroke-linejoin="round" stroke-linecap="round"{dir_attr}>'
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
                                       ts["outline_w"], ts["arch"], ts["shadow"],
                                       rtl=title_is_rtl(cfg)))
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
        # Card's left edge (cell = [x0,y0,x1,y1]) with a small inner margin, so the
        # bounds guard below has something to clamp against. A card may have no cell
        # in older recipes — fall back to no clamp (guard becomes a no-op).
        cell = card.get("cell")
        wf_metrics, wf_ref = _word_metrics(word_font)
        for wi, slot in enumerate(card["words"]):
            if wi >= len(words) or not words[wi]:
                continue
            wsize = size
            # SAFETY GUARD: a word is right-anchored near slot x1 and flows LEFT, so
            # an unusually long (real-order) word could spill PAST the card's left
            # edge. Shrink just that word's font so it always stays inside the card.
            # This is a no-op for every word that already fits (all current designs
            # render byte-identically), so it can't disturb a good layout — it only
            # rescues a word that would otherwise overflow the card bounds. It does
            # NOT push words away from foreground ARTWORK inside the card; that is a
            # per-design recipe concern (see report), not a safe global change.
            if cell:
                left_bound = cell[0] + (cell[2] - cell[0]) * 0.02
                _, _, marker_w = _marker_geometry(wf_metrics, wf_ref, wi + 1, wsize * 0.9)
                word_right = slot["x1"] - marker_w - wsize * 0.30
                avail = word_right - left_bound
                word_w = wf_metrics.getlength(words[wi]) / wf_ref * wsize
                if avail > 0 and word_w > avail:
                    wsize = wsize * (avail / word_w)
            baseline = (slot["y0"] + slot["y1"]) / 2 + wsize * 0.34
            overlay.append(word_text(slot["x1"], baseline, wsize, slot["color"],
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


if __name__ == "__main__":
    theme, clean, csvp, row, title, out = sys.argv[1:7]
    wbc = load_csv_row(csvp, int(row))
    render(theme, clean, wbc, title.split("|"), out)   # "OZ'S|WELCOME|PARTY"
    print("wrote", out)
