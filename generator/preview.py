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

CLI (prints the produced PNG paths as JSON, plus any ``notes``):
  python3 generator/preview.py <theme> <name> <out_dir> \
          [--word-font FONT.ttf] [--field KEY=VALUE ...] [--no-board]
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
    return config.load_recipe(cfg["recipe"])


# Codes for ``notes`` (see _note). Stable strings — the admin UI keys its Hebrew
# wording off them, so they are part of the preview's contract, not debug text.
NOTE_NO_TITLE = "no_title"     # surface rendered, but with NO personalized name
NOTE_FAILED = "failed"         # surface could not be rendered at all
NOTE_FONT_GAPS = "font_gaps"   # the title face cannot draw this title's letters


def _note(notes, surface, code, detail):
    """Record something the owner MUST be told about this preview.

    A preview is the approval step before a deck is printed, so anything it
    quietly leaves out is a promise it cannot keep. Two things used to vanish
    here: a back that failed to render (swallowed whole, leaving a two-panel
    preview that looked complete) and a surface rendered with no title at all
    because nothing is calibrated for it (which looks exactly like a design
    that was never meant to carry a name). Both now come back with the images
    so the caller can say so out loud.

    Neither is fatal: a partial preview still beats no preview, and a title-less
    back is what the deck would genuinely print. They are reported, not raised.
    """
    notes.append({"surface": surface, "code": code, "detail": detail})


def _font_gap_note(cfg, theme, title_lines):
    """The one note a preview must never omit, or None.

    An order REFUSES a title its own face cannot draw (build.build_deck ->
    render_page.assert_title_drawable). A preview does not: this is the screen
    the owner is looking at when she notices something is wrong with her design,
    and a 500 with a traceback tells her less than the broken picture does. So
    she gets the picture AND the reason — which is the pair she needs, because
    the picture alone is exactly what fooled her: the title comes back set in a
    system fallback face with its first and last letter missing, and nothing on
    the card says so.

    Reported here rather than per-surface because it is a property of the theme
    and its title, not of any one render: every surface that carries the title
    is wrong in the same way.
    """
    font = config.font_path(theme, cfg.get("title_font") or "")
    if not cfg.get("title_font") or not os.path.exists(font):
        return None                     # a missing font is _assets' complaint
    gaps = rp.title_font_gaps(font, title_lines)
    if not gaps:
        return None
    return {"surface": "title", "code": NOTE_FONT_GAPS,
            "detail": (f"the title font {os.path.basename(font)!r} has no "
                       f"letters for {''.join(gaps)!r}, so the title above is "
                       f"NOT this design's typeface — the browser substituted a "
                       f"system font, and letters that overrun their line are "
                       f"dropped without a trace. An order in this state is "
                       f"refused; upload a title font that covers this design's "
                       f"language.")}


def _prepend_note(out, note):
    """Put ``note`` FIRST in a result's notes, creating the list if need be.

    First because the notes are a list the admin renders in order, and this one
    invalidates every other thing the preview shows: there is no point telling
    the owner her board carries no name while the name itself is being printed
    in the wrong typeface with letters missing.
    """
    if note:
        out["notes"] = [note] + list(out.get("notes") or [])
    return out


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


def _preview_single_card(theme, cfg, title_lines, workdir, word_font=None,
                         chasers=False, all_fronts=False, with_board=True):
    """The v2 preview: the front card(s), the back, and the board.

    A BUYER preview renders the theme's FIRST front only: the fronts differ by
    an icon, one image keeps the result stable as they retype the name, and it
    is one Chrome run instead of eight on a public endpoint.

    An OWNER calibration preview (``all_fronts``) renders EVERY front, because
    the title position is calibrated per front — showing only the first leaves
    fronts 2..9 being adjusted blind. They all come from ONE Chrome run (see
    ``rp.render_fronts_strip``), so it costs about what a single front does.
    """
    fronts = config.fronts(cfg)
    out = {}
    notes = []
    paths = []
    if all_fronts and len(fronts) > 1:
        # Showing every front is an ENHANCEMENT for calibration. It must never
        # cost the owner their preview: this render is heavier than a single
        # card (one page eight cards wide) and it fell over in production,
        # taking the whole calibration screen down with it — the preview died
        # entirely rather than degrading to the one card it has always shown.
        # So a failure here falls through to the single-card path below.
        try:
            paths = rp.render_fronts_strip(
                theme, fronts, list(PLACEHOLDER_WORDS), title_lines,
                os.path.join(workdir, "fronts"), word_font=word_font)
        except Exception as exc:  # noqa: BLE001 - any failure degrades, none propagates
            print(f"all-fronts preview failed, falling back to one card: {exc}",
                  file=sys.stderr)
            paths = []
            # Degrading is right; degrading SILENTLY is not. The owner asked to
            # see every front because she is adjusting a per-front value, so a
            # preview that quietly answers with one card leaves her editing
            # front 8 while looking at front 2 — the exact failure this strip
            # exists to prevent.
            _note(notes, "cards", NOTE_FAILED, str(exc))
    if paths:
        for path in paths:
            _downscale(path, CARD_MAX_W)
        # Keyed by front number so the admin UI can label each image with the
        # front it belongs to; "card" stays the first one so every existing
        # caller keeps working unchanged.
        out["cards"] = {str(front): path for front, path in zip(fronts, paths)}
        card_png = paths[0]
    else:
        front = fronts[0]
        card_png = rp.render_single_card(
            theme, config.card_path(theme, front), list(PLACEHOLDER_WORDS),
            title_lines, os.path.join(workdir, "card.png"), front_index=front,
            word_font=word_font)
        _downscale(card_png, CARD_MAX_W)
    out["card"] = card_png

    board_clean = config.board_clean_path(theme, chasers=chasers)
    if with_board and os.path.exists(board_clean):
        board_png = buildmod.render_board(
            theme, board_clean, title_lines, os.path.join(workdir, "board.png"),
            chasers=chasers)
        _downscale(board_png, BOARD_MAX_W)
        out["board"] = board_png
        # Same test build.render_board itself makes ("if not bd": no board slot
        # -> print the clean board untouched), so the note cannot claim a title
        # the board render did not draw.
        if not cfg.get("board"):
            _note(notes, "board", NOTE_NO_TITLE,
                  "no board title slot is calibrated for this design, so the "
                  "printed board will carry no name either")

    # Best-effort, exactly as the v1 path: a back that fails to render must never
    # cost the buyer their card+board preview. It must not vanish in SILENCE
    # either — see _note.
    try:
        # The FIRST back, which on a one-back deck is the only one. A paired
        # template has no shared back file at all, so asking for `back_path`
        # here would look for a `1.svg` it was never meant to ship.
        bi = config.back_indices(config.theme(theme))[0]
        back_path = config.card_path(theme, bi)
        back_png = rp.render_single_card(
            theme, back_path, [], title_lines,
            os.path.join(workdir, "back.png"), kind="back", word_font=word_font,
            back_index=bi)
        _downscale(back_png, CARD_MAX_W)
        out["back"] = back_png
        if not rp.back_draws_title(theme, back_path, back_index=bi):
            _note(notes, "back", NOTE_NO_TITLE,
                  "no back title slot is calibrated for this design, so the "
                  "printed backs will carry no name either")
    except Exception as exc:  # noqa: BLE001 - degrades to no back, never fatal
        _note(notes, "back", NOTE_FAILED, str(exc))
    if notes:
        out["notes"] = notes
    return out


def preview(theme, name, extra_fields=None, word_font=None, workdir=None,
            chasers=False, custom_title=None, calibration=None, with_board=True,
            gender=None):
    """Render a preview and return ``{"card": path, "board": path, "back": path}``.

    ``board`` and ``back`` are included only when the theme has that artwork; the
    single run produces the front card, the game board AND the personalized card
    back together (one Chrome per product, no separate back process).

    A ``notes`` key is added (and only added) when something about this preview
    has to be said out loud rather than left for the owner to spot: a surface
    rendered with NO personalized name on it, or a back that could not be
    rendered at all. See :func:`_note`. The images are still returned in both
    cases — a note is information, not an error.

    theme         a key in generator/themes.json (must be calibrated, UNLESS
                  ``calibration`` supplies the missing style — see below)
    name          the honoree name (cased per the theme's name_form)
    extra_fields  dict feeding the title template (AGE/YEARS/NAME1/...)
    word_font     optional card word-font filename override (theme fonts/ or the
                  shared word-fonts/ pool)
    chasers       when True, show the theme's chasers board variant if it ships one
                  (clean/board-chasers.svg), else the normal board (additive)
    custom_title  optional free-form title (F7) overriding the theme-derived title
                  on the sample card + board; empty/absent keeps the theme default,
                  so the preview is WYSIWYG for what production renders
    calibration   optional UNSAVED calibration knobs from the owner's calibration
                  form — ``{title_style, board, back, word_size}``. Merged over the
                  theme in memory (themes.json is never written) so an
                  uncalibrated template can be previewed and tuned before it is
                  saved. The blob is the full source of truth for the look, so an
                  explicit ``board``/``back`` of null previews as "no title on that
                  surface". Production never passes this, so a real print-ready
                  PDF still requires ``calibrated: true``.
    with_board    render the game board at all. The buyer's name preview shows
                  the card and its back only, and the board is by far the most
                  expensive image in the response — a full landscape artboard,
                  roughly eight times the card's bytes and its own Chrome page.
                  A caller that will not show it must not pay to make it, so
                  this SKIPS THE RENDER rather than dropping the result: hiding
                  it client-side would keep every bit of the cost and none of
                  the benefit. The owner's calibration screen leaves it on.
    gender        the honoree's gender ('male'/'female'/None), resolving the
                  title's {feminine|masculine} markers. The preview is the
                  approval step before a deck is printed, so it takes the same
                  argument production does — a girl's preview must show בת for
                  the same reason her printed cards must.
    """
    # Install BEFORE the first config.theme() read: render_page/build re-read the
    # config themselves, and they must all see the same overridden values.
    config.set_preview_overrides(theme, calibration)
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {}, custom_title=custom_title,
                                     gender=gender)
    gap_note = _font_gap_note(cfg, theme, title_lines)

    own_workdir = workdir is None
    if own_workdir:
        workdir = tempfile.mkdtemp(prefix="dugri-preview-")
    os.makedirs(workdir, exist_ok=True)

    try:
        # A v2 (single-card) theme needs no sheet render + crop: the page IS the
        # card, so one screenshot per surface. Same overlays as the deck, so the
        # preview stays WYSIWYG for what production prints.
        if config.is_single_card(cfg):
            # A calibration blob means the OWNER is tuning this template, and
            # the title position is per front — so show them every front. A
            # buyer preview (no blob) stays a single card: one Chrome run on a
            # public endpoint, and a stable image as they retype the name.
            return _prepend_note(
                _preview_single_card(theme, cfg, title_lines, workdir,
                                     word_font=word_font, chasers=chasers,
                                     all_fronts=bool(calibration),
                                     with_board=with_board), gap_note)

        recipe = _recipe(cfg)
        # BELT AND BRACES. The theme config said "legacy sheet", but the recipe
        # describes ONE card — so the two disagree about what this template is.
        # Trust the recipe: it is what the sheet path below is about to index, and
        # a v2 recipe has no ``cards`` list for it to index, so continuing here is
        # a guaranteed KeyError rather than a wrong-looking render.
        #
        # This is reachable whenever a marker is missing from the entry (see
        # config.is_single_card for the three of them). Rendering the card is a far
        # better answer than crashing the owner's preview with a traceback.
        if config.is_single_card_recipe(recipe):
            return _prepend_note(
                _preview_single_card(theme, cfg, title_lines, workdir,
                                     word_font=word_font, chasers=chasers,
                                     all_fronts=bool(calibration),
                                     with_board=with_board), gap_note)

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
        notes = []

        board_clean = config.clean_path(theme, "board")
        if with_board and os.path.exists(board_clean):
            board_png = buildmod.render_board(
                theme, board_clean, title_lines, os.path.join(workdir, "board.png"),
                chasers=chasers,
            )
            _downscale(board_png, BOARD_MAX_W)
            out["board"] = board_png
            if not cfg.get("board"):
                _note(notes, "board", NOTE_NO_TITLE,
                      "no board title slot is calibrated for this design, so the "
                      "printed board will carry no name either")

        # The design's REAL personalized card BACK, produced in this SAME preview
        # run (no second Chrome process). Uses the production duplex path
        # (build.render_backs -> centered title on the clean back sheet), then
        # crops the SAME sample card cell used for the front so the back mirrors
        # the card exactly. Best-effort: a theme with no back art — or any failure
        # rendering it — omits "back" and never breaks the card+board result. The
        # failure is REPORTED rather than swallowed (see _note).
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
                # Same test build.render_backs itself makes ("if not bk": no back
                # slot -> print the clean backs untouched).
                if not cfg.get("back"):
                    _note(notes, "back", NOTE_NO_TITLE,
                          "no back title slot is calibrated for this design, so "
                          "the printed backs will carry no name either")
            except Exception as exc:  # noqa: BLE001 - degrades, never fatal
                _note(notes, "back", NOTE_FAILED, str(exc))

        if notes:
            out["notes"] = notes
        return _prepend_note(out, gap_note)
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
    ap.add_argument("--chasers", action="store_true",
                    help="show the theme's chasers board variant when available")
    ap.add_argument("--title", default=None,
                    help="optional custom title overriding the theme-derived title")
    ap.add_argument("--gender", default=None, choices=["male", "female"],
                    help="the honoree's gender, resolving the title's "
                         "{feminine|masculine} markers (e.g. {בת|בן}). Omitted "
                         "takes the first (feminine) form")
    ap.add_argument("--calibration", default=None, metavar="FILE",
                    help="path to a JSON file of UNSAVED calibration knobs "
                         "(title_style/board/back/word_size) to render with, so an "
                         "uncalibrated template can be previewed before saving")
    ap.add_argument("--no-board", action="store_true",
                    help="skip the game board entirely (card + back only). The "
                         "board is the most expensive image in a preview, so a "
                         "caller that will not show it should not pay to render it")
    args = ap.parse_args()

    calibration = None
    if args.calibration:
        with open(args.calibration, encoding="utf-8") as f:
            calibration = json.load(f)

    imgs = preview(
        args.theme, args.name, _parse_fields(args.field),
        word_font=args.word_font, workdir=args.out_dir, chasers=args.chasers,
        custom_title=args.title, calibration=calibration,
        with_board=not args.no_board, gender=args.gender,
    )
    # The server parses this JSON line to locate the produced PNGs.
    print(json.dumps(imgs))


if __name__ == "__main__":
    main()
