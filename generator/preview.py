#!/usr/bin/env python3
"""Fast order PREVIEW: render ONE representative front card + the game board for
a theme, personalized with the honoree name, so a customer can see a real
rendered sample right after entering the name (before collecting any words).

Unlike ``order_to_pdf`` (which renders the whole deck), this renders just two
Chrome pages: one front sheet (cropped down to a single sample card filled with
placeholder words) and the board (with the personalized title). It reuses the
same config + render_page/build code paths as production, so the preview looks
exactly like the real output — including the chosen ``word_font``.

  from preview import preview
  imgs = preview("trip comeback", "OZ", {}, word_font="Fredoka-Medium.ttf")
  # -> {"card": "/tmp/.../card.png", "board": "/tmp/.../board.png"}

CLI (prints the two PNG paths as JSON):
  python3 generator/preview.py <theme> <name> <out_dir> \
          [--word-font FONT.ttf] [--field KEY=VALUE ...]
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

from PIL import Image

import config
import render_page as rp
import build as buildmod

HERE = os.path.dirname(os.path.abspath(__file__))

# Hebrew placeholder words shown on the sample card. The words in the real game
# are always Hebrew (the word_font is a Hebrew face), so these stand in purely to
# show the font/size/colour — the name in the title is the personalized part.
PLACEHOLDER_WORDS = ["מסיבה", "חברים", "ריקודים", "צחוקים"]

# Cap the returned PNG widths so the preview payload stays small and snappy (the
# render itself is full-res; we only down-sample the delivered image).
CARD_MAX_W = 700
BOARD_MAX_W = 1000


def _recipe(cfg):
    with open(os.path.join(HERE, "recipes", f"{cfg['recipe']}.json"), encoding="utf-8") as f:
        return json.load(f)


def _sample_card_index(recipe):
    """Index of a representative card: the first card that carries a title (so the
    personalized name shows), else the first non-empty card."""
    cards = recipe["cards"]
    for i, card in enumerate(cards):
        if card and card.get("title"):
            return i
    for i, card in enumerate(cards):
        if card:
            return i
    return 0


def _downscale(png_path, max_w):
    """Down-sample a PNG in place to at most ``max_w`` wide (keeps aspect)."""
    img = Image.open(png_path)
    if img.width > max_w:
        h = round(img.height * max_w / img.width)
        img.resize((max_w, h), Image.LANCZOS).save(png_path)


def _crop_card(full_png, cell, viewbox, out_png):
    """Crop the single sample card out of the full rendered front sheet. ``cell``
    is [x0,y0,x1,y1] in the recipe's viewBox units; scale to pixels via the
    rendered image size (robust to the SVG's device-scale factor)."""
    img = Image.open(full_png)
    _, _, vbw, vbh = viewbox
    sx, sy = img.width / vbw, img.height / vbh
    x0, y0, x1, y1 = cell
    box = (
        max(0, int(x0 * sx)),
        max(0, int(y0 * sy)),
        min(img.width, int(round(x1 * sx))),
        min(img.height, int(round(y1 * sy))),
    )
    img.crop(box).save(out_png)
    return out_png


def preview(theme, name, extra_fields=None, word_font=None, workdir=None):
    """Render a preview and return ``{"card": path, "board": path}``.

    theme         a key in generator/themes.json (must be calibrated)
    name          the honoree name (cased per the theme's name_form)
    extra_fields  dict feeding the title template (AGE/YEARS/NAME1/...)
    word_font     optional card word-font filename override (theme fonts/ or the
                  shared word-fonts/ pool)
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {})

    own_workdir = workdir is None
    if own_workdir:
        workdir = tempfile.mkdtemp(prefix="dugri-preview-")
    os.makedirs(workdir, exist_ok=True)

    try:
        recipe = _recipe(cfg)
        idx = _sample_card_index(recipe)

        # Fill only the sample card with placeholder words; the rest stay blank (we
        # crop away everything but this one card anyway).
        words_by_card = [[] for _ in recipe["cards"]]
        words_by_card[idx] = list(PLACEHOLDER_WORDS)

        fronts = config.clean_path(theme, "fronts")
        full_png = os.path.join(workdir, "front_full.png")
        rp.render(theme, fronts, words_by_card, title_lines, full_png, word_font=word_font)

        card_png = _crop_card(
            full_png, recipe["cards"][idx]["cell"], recipe["viewBox"],
            os.path.join(workdir, "card.png"),
        )
        _downscale(card_png, CARD_MAX_W)

        out = {"card": card_png}

        board_clean = config.clean_path(theme, "board")
        if os.path.exists(board_clean):
            board_png = buildmod.render_board(
                theme, board_clean, title_lines, os.path.join(workdir, "board.png")
            )
            _downscale(board_png, BOARD_MAX_W)
            out["board"] = board_png

        return out
    except BaseException:
        # The produced PNGs live INSIDE workdir, so we only clean up a workdir WE
        # created — and only on the error path (a caller passing its own workdir,
        # like the server, cleans it up itself after reading the images back).
        if own_workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        raise


def _parse_fields(pairs):
    out = {}
    for p in pairs or []:
        if "=" not in p:
            sys.exit(f"bad --field {p!r}; expected KEY=VALUE")
        k, v = p.split("=", 1)
        out[k.strip()] = v
    return out


def main():
    ap = argparse.ArgumentParser(description="Render a fast order preview")
    ap.add_argument("theme")
    ap.add_argument("name")
    ap.add_argument("out_dir")
    ap.add_argument("--word-font", default=None)
    ap.add_argument("--field", action="append", default=[], metavar="KEY=VALUE")
    args = ap.parse_args()

    imgs = preview(
        args.theme, args.name, _parse_fields(args.field),
        word_font=args.word_font, workdir=args.out_dir,
    )
    # The server parses this JSON line to locate the produced PNGs.
    print(json.dumps(imgs))


if __name__ == "__main__":
    main()
