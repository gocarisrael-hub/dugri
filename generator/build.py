#!/usr/bin/env python3
"""Assemble a full order into ONE print-ready PDF: front card pages (title +
words from the CSV) + the game board (title) — onto the clean text-free
backgrounds.

  python3 generator/build.py <theme> <fronts_clean.svg> <board_clean.svg> \
                             <csv> <NAME> <out.pdf> [<backs_clean.svg>]

<theme> is a key in generator/themes.json (e.g. "trip comeback"). Fonts,
colours, title lines and the board/back title slots all come from that config.
NAME is the honoree; the title is built from the theme's title_lines template
(e.g. trip comeback: OZ -> "OZ'S / WELCOME / PARTY").
"""
import os
import subprocess
import sys
import re
from PIL import Image

import config
import render_page as rp

CHROME = rp.CHROME
HERE = os.path.dirname(os.path.abspath(__file__))


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


def render_board(theme, board_clean, title_lines, out_png):
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    w, h, vb = svg_dims(board_clean)
    bd, ts = cfg.get("board"), cfg["title_style"]
    if not bd:  # theme has no personalized board title -> use the clean board as-is
        return render_svg(open(board_clean, encoding="utf-8").read(), w, h, out_png)
    frac = bd["frac"]
    title_font = config.font_path(theme, cfg["title_font"])
    box = {k: (frac[k] * vb[2] if "x" in k else frac[k] * vb[3]) for k in frac}
    svg = open(board_clean, encoding="utf-8").read()
    style = "<style>" + rp.font_face("TitleFont", title_font) + "</style>"
    body = style + rp.title_block(box, title_lines, bd["fill"], bd["outline"],
                                  title_font, ts["outline_w"], ts["arch"], ts["shadow"])
    return render_svg(svg.replace("</svg>", body + "</svg>"), w, h, out_png)


def render_backs(theme, backs_clean, title_lines, out_png):
    """Overlay the centered title on each of the 8 clean backs."""
    import json
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    w, h, vb = svg_dims(backs_clean)
    bk, ts = cfg.get("back"), cfg["title_style"]
    if not bk:  # theme has no personalized back title -> use the clean backs as-is
        return render_svg(open(backs_clean, encoding="utf-8").read(), w, h, out_png)
    frac = bk["frac"]
    title_font = config.font_path(theme, cfg["title_font"])
    recipe = json.load(open(os.path.join(HERE, "recipes", f"{cfg['recipe']}.json")))
    svg = open(backs_clean, encoding="utf-8").read()
    body = ["<style>" + rp.font_face("TitleFont", title_font) + "</style>"]
    for card in recipe["cards"]:
        if not card:
            continue
        cx0, cy0, cx1, cy1 = card["cell"]
        cw, ch = cx1 - cx0, cy1 - cy0
        box = {"x0": cx0 + frac["x0"] * cw, "x1": cx0 + frac["x1"] * cw,
               "y0": cy0 + frac["y0"] * ch, "y1": cy0 + frac["y1"] * ch}
        body.append(rp.title_block(box, title_lines, bk["fill"], bk["outline"],
                                   title_font, ts["outline_w"], ts["arch"], ts["shadow"]))
    return render_svg(svg.replace("</svg>", "".join(body) + "</svg>"), w, h, out_png)


def build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=None,
              extra_fields=None, word_font=None, workdir="/tmp/gen/build",
              progress=True):
    """Assemble the full order PDF and return (out_pdf, page_count).

    ``extra_fields`` feeds the theme's title template (e.g. AGE/YEARS/NAME1);
    ``word_font`` optionally overrides the theme's card word font (a filename in
    the theme's ``fonts/`` dir). ``progress`` prints per-page lines (as the CLI
    did) so a caller can stream progress; pass False to stay quiet.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {})
    os.makedirs(workdir, exist_ok=True)
    import csv as csvmod
    data = list(csvmod.DictReader(open(csvp, encoding="utf-8-sig")))

    def log(msg):
        if progress:
            print(msg)

    # one shared back page (identical for every front) when a backs bg is given
    back_png = None
    if backs:
        back_png = render_backs(theme, backs, title_lines, os.path.join(workdir, "back.png"))
        log("back")

    pages = []
    for i in range(len(data)):
        wbc = rp.load_csv_row(csvp, i)
        png = os.path.join(workdir, f"front_{i+1}.png")
        rp.render(theme, fronts, wbc, title_lines, png, word_font=word_font)
        pages.append(png)
        if back_png:                       # duplex order: front then its back
            pages.append(back_png)
        log(f"front page {i+1}/{len(data)}")
    board_png = render_board(theme, board, title_lines, os.path.join(workdir, "board.png"))
    pages.append(board_png)
    log("board")

    imgs = [Image.open(p).convert("RGB") for p in pages]
    imgs[0].save(out_pdf, save_all=True, append_images=imgs[1:], resolution=300)
    nback = len(data) if back_png else 0
    log(f"\nwrote {out_pdf}  ({len(pages)} pages: {len(data)} fronts "
        f"+ {nback} backs + board)")
    return out_pdf, len(pages)


def main():
    theme, fronts, board, csvp, name, out_pdf = sys.argv[1:7]
    backs = sys.argv[7] if len(sys.argv) > 7 else None
    build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=backs)


if __name__ == "__main__":
    main()
