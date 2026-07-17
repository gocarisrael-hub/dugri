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

# Headless Chrome screenshots a large SVG BEFORE its base64 data:-URL @font-face
# fonts finish loading, so the word/title text silently falls back to a default
# heavy Hebrew face instead of the theme font (Cafe, Mr Dafoe, …). Advancing a
# virtual clock forces Chrome to wait for the fonts (and all resources) to settle
# before capturing, so the calibrated fonts actually render. Kept as a shared
# constant so every production render path stays in lock-step. Verified: without
# it Cafe renders as a bold fallback; with it the real Cafe face renders.
CHROME_FONT_WAIT = "--virtual-time-budget=15000"


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


# Fraction constants shared with word_text() so the fit calculation and the
# actual render stay in lock-step: the marker (digit+period) renders at 0.9x the
# word size, and a 0.30x gap separates the marker from the word.
_MARKER_SCALE = 0.9
_WORD_GAP = 0.30


def _line_width_at(font, ref, num, word):
    """Full numbered-line width (marker + gap + word) at the metric ``ref`` size.
    Everything scales linearly with the font size, so a width measured at ``ref``
    converts to any render size S by multiplying by S/ref."""
    _, _, marker_w = _marker_geometry(font, ref, num, ref * _MARKER_SCALE)
    return marker_w + ref * _WORD_GAP + font.getlength(word)


# The origin template renders every word on a card at ONE font size (Canva Bulk
# Create fills a fixed-size text box). The recipe's per-slot boxes are just where
# that single size landed on the ORIGIN words, so their heights encode the origin
# size: a slot's box height ~= the ink height of a full Hebrew line (letters +
# number, incl. the odd ascender/descender) at the origin size. Empirically the
# origin size ~= median(box height) x 1.3 for the calibrated Hebrew word face.
_WORD_SIZE_K = float(os.environ.get("DUGRI_WORD_K", "1.3"))


def _word_sizes(slots, words, font, ref, cell=None):
    """One UNIFORM font size for all the card's words (matching the origin's
    single-size look), with a per-word shrink guard so an unusually long word can
    never spill past the card edge into the neighbouring artwork.

    The uniform size comes from the recipe box heights (see ``_WORD_SIZE_K``),
    NOT from fitting each word to its own box — fitting per box would reproduce
    the ORIGIN word lengths (a short word in a wide origin slot would balloon, a
    long word in a narrow slot would shrink), destroying the uniform look. The
    only per-word adjustment is a downward clamp: a numbered line is right-
    anchored at its slot's right edge and flows LEFT, so a very long word could
    reach past the card's left edge; we shrink just that word to keep it inside
    the card cell. Empty/missing slots return ``None``.
    """
    import statistics
    heights = [s["y1"] - s["y0"] for s in slots]
    if not heights:
        return [None] * len(slots)
    uniform = statistics.median(heights) * _WORD_SIZE_K
    left_bound = cell[0] + (cell[2] - cell[0]) * 0.02 if cell else None
    out = []
    for wi, slot in enumerate(slots):
        word = words[wi] if wi < len(words) else ""
        if not word:
            out.append(None)
            continue
        wsize = uniform
        if left_bound is not None:
            line_w_ref = _line_width_at(font, ref, wi + 1, word)
            avail = slot["x1"] - left_bound
            if line_w_ref > 0 and avail > 0:
                wsize = min(wsize, avail * ref / line_w_ref)
        out.append(wsize)
    return out


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
    # size to fill the WIDTH, capped so the stacked lines still fit the box HEIGHT.
    # The height cap comes from the REAL font metrics, not a fixed per-line
    # fraction: some display title faces (e.g. the japanese/neon fonts) draw
    # glyphs far taller than their em, so the old ``bh/(0.80*n)`` heuristic let a
    # stacked title spill well past its calibrated box (title rendered ~2x too
    # tall). Measure the actual ink stack — the top line's ink above its baseline
    # + the 0.78*size baseline gaps + the bottom line's ink below its baseline —
    # and scale it to fill the box height exactly. Width-bound titles (script /
    # graffiti names that fill the box width first) are untouched: their width
    # term is the smaller of the two, so ``min`` still selects it.
    asc, _desc = f.getmetrics()
    ink_above = asc - f.getbbox(lines[0])[1]              # line0 ink above baseline
    ink_below = f.getbbox(lines[-1])[3] - asc            # last line ink below baseline
    stack = ink_above + 0.78 * ref * (n - 1) + ink_below  # full stacked ink at ref
    size_h = bh * ref / stack if stack > 0 else bh
    size = min(bw * 0.89 / max(ratios), size_h)
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
        # skip the word pass so the sizing below can't crash the whole page.
        if not card["words"]:
            continue
        wf_metrics, wf_ref = _word_metrics(word_font)
        sizes = _word_sizes(card["words"], words, wf_metrics, wf_ref,
                            cell=card.get("cell"))
        for wi, slot in enumerate(card["words"]):
            wsize = sizes[wi]
            if wsize is None:
                continue
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
                    "--disable-dev-shm-usage", "--disable-gpu", CHROME_FONT_WAIT,
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
