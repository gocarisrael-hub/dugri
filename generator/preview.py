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


def _merge_calibration(cfg, blob):
    """Merge an owner-supplied, not-yet-persisted calibration blob into a cfg copy.

    Mirrors the real themes.json schema exactly (see build.py: title_style keys
    fill/outline/outline_w/arch/shadow[/size/board_size/back_size/align/offset/
    italic]; board/back = {frac:{x0,y0,x1,y1}, fill, outline}; word_size at theme
    level). ``board``/``back``/``word_size`` may be null/absent. Returns a NEW
    dict so the underlying themes mapping is never mutated; sets calibrated:true
    so the theme renders exactly as it will once the owner saves these knobs.
    """
    merged = dict(cfg)
    merged["title_style"] = blob["title_style"]
    merged["board"] = blob.get("board")
    merged["back"] = blob.get("back")
    if blob.get("word_size") is not None:
        merged["word_size"] = blob["word_size"]
    merged["calibrated"] = True
    return merged


def preview(theme, name, extra_fields=None, word_font=None, workdir=None,
            chasers=False, custom_title=None, calibration=None):
    """Render a preview and return ``{"card": path, "board": path, "back": path}``.

    ``board`` and ``back`` are included only when the theme has that artwork; the
    single run produces the front card, the game board AND the personalized card
    back together (one Chrome per product, no separate back process).

    theme         a key in generator/themes.json (must exist; may be uncalibrated
                  only when ``calibration`` is supplied)
    name          the honoree name (cased per the theme's name_form)
    extra_fields  dict feeding the title template (AGE/YEARS/NAME1/...)
    word_font     optional card word-font filename override (theme fonts/ or the
                  shared word-fonts/ pool)
    chasers       when True, show the theme's chasers board variant if it ships one
                  (clean/board-chasers.svg), else the normal board (additive)
    custom_title  optional free-form title (F7) overriding the theme-derived title
                  on the sample card + board; empty/absent keeps the theme default,
                  so the preview is WYSIWYG for what production renders
    calibration   optional owner-supplied calibration blob (dict; see
                  ``_merge_calibration``) for rendering an UNCALIBRATED template
                  from knobs not yet saved to themes.json. When given, it is
                  merged into the in-memory cfg (title_style/board/back/word_size)
                  and ``ensure_calibrated`` is skipped — WITHOUT writing any theme
                  file. When absent, behavior is unchanged: an uncalibrated theme
                  still errors.
    """
    cfg = config.theme(theme)  # theme must exist (KeyError otherwise), even uncalibrated
    override_installed = False
    if calibration is not None:
        cfg = _merge_calibration(cfg, calibration)
        # Every render path (build_page, render_board, render_backs) re-reads the
        # cfg via config.theme(theme); install the merged cfg as an in-memory
        # override so the knobs reach ALL of them for this one render. Cleared in
        # the finally below — nothing is ever written to themes.json.
        config.set_theme_override(theme, cfg)
        override_installed = True
    else:
        config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {}, custom_title=custom_title)

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
                theme, board_clean, title_lines, os.path.join(workdir, "board.png"),
                chasers=chasers,
            )
            _downscale(board_png, BOARD_MAX_W)
            out["board"] = board_png

        # The design's REAL personalized card BACK, produced in this SAME preview
        # run (no second Chrome process). Uses the production duplex path
        # (build.render_backs -> centered title on the clean back sheet), then
        # crops the SAME sample card cell used for the front so the back mirrors
        # the card exactly. Best-effort: a theme with no back art — or any failure
        # rendering it — omits "back" and never breaks the card+board result.
        backs_clean = config.clean_path(theme, "backs")
        if os.path.exists(backs_clean):
            try:
                back_full = os.path.join(workdir, "back_full.png")
                buildmod.render_backs(theme, backs_clean, title_lines, back_full)
                back_png = _crop_card(
                    back_full, recipe["cards"][idx]["cell"], recipe["viewBox"],
                    os.path.join(workdir, "back.png"),
                )
                _downscale(back_png, CARD_MAX_W)
                out["back"] = back_png
            except Exception:
                pass

        return out
    except BaseException:
        # The produced PNGs live INSIDE workdir, so we only clean up a workdir WE
        # created — and only on the error path (a caller passing its own workdir,
        # like the server, cleans it up itself after reading the images back).
        if own_workdir:
            shutil.rmtree(workdir, ignore_errors=True)
        raise
    finally:
        # The calibration override is in-memory for THIS render only; always clear
        # it so it can never leak into a later render (of this or another theme).
        if override_installed:
            config.set_theme_override(theme, None)


def _parse_fields(pairs):
    out = {}
    for p in pairs or []:
        if "=" not in p:
            sys.exit(f"bad --field {p!r}; expected KEY=VALUE")
        k, v = p.split("=", 1)
        out[k.strip()] = v
    return out


def _load_calibration(path):
    """Load + shape-check a ``--calibration`` JSON file, or return None.

    Bad JSON / missing file / wrong shape exits non-zero with a clear one-line
    stderr message (``sys.exit(str)`` — no traceback), so the server can classify
    the failure instead of choking on a Python stack trace.
    """
    if path is None:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            blob = json.load(f)
    except (OSError, ValueError) as e:
        sys.exit(f"bad --calibration file {path!r}: {e}")
    if not isinstance(blob, dict) or not isinstance(blob.get("title_style"), dict):
        sys.exit(
            f"bad --calibration file {path!r}: expected a JSON object with a "
            "'title_style' object"
        )
    return blob


def main():
    ap = argparse.ArgumentParser(description="Render a fast order preview")
    ap.add_argument("theme")
    ap.add_argument("name")
    ap.add_argument("out_dir")
    ap.add_argument("--word-font", default=None)
    ap.add_argument("--field", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--chasers", action="store_true",
                    help="show the theme's chasers board variant when available")
    ap.add_argument("--title", default=None,
                    help="optional custom title overriding the theme-derived title")
    ap.add_argument("--calibration", default=None, metavar="PATH",
                    help="path to a JSON file of owner-supplied, not-yet-saved "
                         "calibration knobs (title_style/board/back/word_size) to "
                         "render an UNCALIBRATED template; never writes themes.json")
    args = ap.parse_args()

    calibration = _load_calibration(args.calibration)
    try:
        imgs = preview(
            args.theme, args.name, _parse_fields(args.field),
            word_font=args.word_font, workdir=args.out_dir, chasers=args.chasers,
            custom_title=args.title, calibration=calibration,
        )
    except (RuntimeError, KeyError) as e:
        # Known, classifiable failures (uncalibrated theme / unknown theme) — emit
        # the message on stderr with a non-zero exit, NOT a traceback, so the
        # server's /not calibrated|unknown theme/i mapping can catch it.
        sys.exit(str(e))
    # The server parses this JSON line to locate the produced PNGs.
    print(json.dumps(imgs))


if __name__ == "__main__":
    main()
