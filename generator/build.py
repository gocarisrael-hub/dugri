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
import math
import os
import sys
import re
from PIL import Image

import card_assets
import card_paper
import chrome
import config
import deck_html
import pack
import render_page as rp
import svg_rings
import press

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
    # font_wait on: this is the production board/back render, so its title must
    # not fall back to a default face while the embedded @font-face loads.
    chrome.screenshot(p, out_png, w, h, scale=2, font_wait=True,
                      what=f"the board/back {os.path.basename(out_png)}")
    return out_png


def render_board(theme, board_clean, title_lines, out_png, chasers=False):
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    bd, ts = cfg.get("board"), cfg["title_style"]
    # Chasers (drinking-game) add-on: prefer the theme's chasers board variant when
    # it exists, else fall back to the clean board passed in (additive, never errors
    # for a theme with no chasers board).
    if chasers:
        variant = config.board_clean_path(theme, chasers=True)
        # For a TITLED board, the honoree name is positioned by fractions (bd["frac"])
        # calibrated against the PLAIN board's viewBox. A chasers board whose viewBox
        # differs would place the name off-position on the customer's print-ready PDF.
        # So only adopt the variant when it's the plain board (no chasers file), the
        # board carries no title, or its viewBox matches — else keep the plain board
        # rather than risk a misprinted name.
        plain = config.clean_path(theme, "board")
        if not bd or variant == plain or svg_dims(variant)[2] == svg_dims(plain)[2]:
            board_clean = variant
        else:
            board_clean = plain
    w, h, vb = svg_dims(board_clean)
    # Snap any mis-registered "sticker outline" red tile discs concentric to their
    # white tiles before rendering. Some Canva board exports offset (and double)
    # the red outline disc a couple of viewBox units off the white tile, which
    # renders as a red crescent / doubled ring ("ghosting") on every numbered
    # square. OPT-IN per theme (themes.json "fix_ring_discs": true) so it can only
    # ever touch the board it was verified against — never a future/other board
    # that happens to contain red circular art. align_ring_discs is additionally
    # a no-op on any SVG lacking the exact ring/tile signature (belt-and-braces).
    raw_board = open(board_clean, encoding="utf-8").read()
    board_svg = svg_rings.align_ring_discs(raw_board) if cfg.get("fix_ring_discs") else raw_board
    if not bd:  # theme has no personalized board title -> use the clean board as-is
        return render_svg(board_svg, w, h, out_png)
    frac = bd["frac"]
    title_font = rp.title_font_for(theme, title_lines, cfg)
    box = {k: (frac[k] * vb[2] if "x" in k else frac[k] * vb[3]) for k in frac}
    svg = board_svg
    style = ("<style>" + rp.GEOMETRIC_TEXT_STYLE
             + rp.title_faces(theme, cfg, lines=title_lines) + "</style>")
    body = style + rp.title_block(box, title_lines, bd["fill"], bd["outline"],
                                  title_font, ts["outline_w"], ts["arch"], ts["shadow"],
                                  rtl=rp.title_is_rtl(cfg),
                                  fixed_size=ts.get("board_size"),
                                  align=ts.get("align", "center"),
                                  italic=ts.get("italic", False),
                                  bold=ts.get("bold", False),
                                  bold_w=ts.get("bold_w"),
                                  leading=rp.board_leading(ts),
                                  one_block=bool(ts.get("one_block")))
    return render_svg(svg.replace("</svg>", body + "</svg>"), w, h, out_png)


def render_backs(theme, backs_clean, title_lines, out_png):
    """Overlay the centered title on each of the 8 clean backs."""
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    w, h, vb = svg_dims(backs_clean)
    bk, ts = cfg.get("back"), cfg["title_style"]
    if not bk:  # theme has no personalized back title -> use the clean backs as-is
        return render_svg(open(backs_clean, encoding="utf-8").read(), w, h, out_png)
    frac = bk["frac"]
    title_font = rp.title_font_for(theme, title_lines, cfg)
    recipe = config.load_recipe(cfg["recipe"])
    svg = open(backs_clean, encoding="utf-8").read()
    body = ["<style>" + rp.GEOMETRIC_TEXT_STYLE
            + rp.title_faces(theme, cfg, lines=title_lines) + "</style>"]
    for card in recipe["cards"]:
        if not card:
            continue
        cx0, cy0, cx1, cy1 = card["cell"]
        cw, ch = cx1 - cx0, cy1 - cy0
        box = {"x0": cx0 + frac["x0"] * cw, "x1": cx0 + frac["x1"] * cw,
               "y0": cy0 + frac["y0"] * ch, "y1": cy0 + frac["y1"] * ch}
        body.append(rp.title_block(box, title_lines, bk["fill"], bk["outline"],
                                   title_font, ts["outline_w"], ts["arch"], ts["shadow"],
                                   rtl=rp.title_is_rtl(cfg),
                                   fixed_size=ts.get("back_size") or ts.get("size"),
                                   align=ts.get("align", "center"),
                                   italic=ts.get("italic", False),
                                   bold=ts.get("bold", False),
                                   bold_w=ts.get("bold_w"),
                                   leading=rp.back_leading(ts, bk),
                                   one_block=bool(ts.get("one_block"))))
    return render_svg(svg.replace("</svg>", "".join(body) + "</svg>"), w, h, out_png)


def build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=None,
              extra_fields=None, word_font=None, workdir="/tmp/gen/build",
              progress=True, chasers=False, custom_title=None, gender=None):
    """Assemble the full order PDF and return (out_pdf, page_count).

    ``extra_fields`` feeds the theme's title template (e.g. AGE/YEARS/NAME1);
    ``word_font`` optionally overrides the theme's card word font (a filename in
    the theme's ``fonts/`` dir). ``progress`` prints per-page lines (as the CLI
    did) so a caller can stream progress; pass False to stay quiet.
    ``custom_title`` (F7) optionally overrides the theme-derived title on every
    surface (fronts/backs/board); empty/absent keeps the theme default.
    ``gender`` ('male'/'female'/None) resolves the title's {feminine|masculine}
    markers (config.resolve_gender_markers); a title without one is unaffected.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {}, custom_title=custom_title,
                                     gender=gender)
    # Before a single page is rendered: can this design's own title face draw
    # this title at all? See render_page.assert_title_drawable — a face without
    # the title's script is substituted by Chrome per glyph, and the letters
    # that overrun the path are then dropped in silence. That is the one failure
    # an order must never ship, so it is checked here, up front, for the same
    # reason build_deck checks its board artwork up front: a failed order costs
    # a re-upload, a plausible-looking one with the wrong name costs the print.
    rp.assert_title_drawable(rp.title_font_for(theme, title_lines, cfg),
                             title_lines, theme=theme)
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
    board_png = render_board(theme, board, title_lines, os.path.join(workdir, "board.png"),
                             chasers=chasers)
    pages.append(board_png)
    log("board")

    imgs = [Image.open(p).convert("RGB") for p in pages]
    imgs[0].save(out_pdf, save_all=True, append_images=imgs[1:], resolution=300)
    nback = len(data) if back_png else 0
    log(f"\nwrote {out_pdf}  ({len(pages)} pages: {len(data)} fronts "
        f"+ {nback} backs + board)")
    return out_pdf, len(pages)


# ---- v2: the single-card deck ---------------------------------------------
# The whole deck is ONE HTML document printed by ONE Chrome pass (see deck_html
# for why). Measured on the real grapefruit assets: 208 pages in ~3s at exactly
# 223.92 x 312 pt per page, ~9 MB, with Python peaking at ~149 MB. The v1
# approach — a Chrome run per page, stitched by Pillow — needed ~784 MB and
# minutes for the same deck.

# Chrome may sit on a print job if the page never settles; cap it so a stuck
# render surfaces as an error instead of hanging a paid order. Re-exported from
# the shared Chrome module so the deck's budget and the screenshot budget can
# never drift apart (same DUGRI_DECK_TIMEOUT_S env var as before).
DECK_TIMEOUT_S = chrome.PRINT_TIMEOUT_S


def print_to_pdf(html, out_pdf, workdir, tag="deck"):
    """Print one HTML document to ``out_pdf`` with headless Chrome."""
    os.makedirs(workdir, exist_ok=True)
    html_path = os.path.join(workdir, f"{tag}.html")
    with open(html_path, "w", encoding="utf-8") as f:
        f.write(html)
    chrome.print_pdf(html_path, out_pdf, what=tag)
    return out_pdf


def board_pdf_path(out_pdf):
    """Where the board file sits, given the deck path.

    Derived rather than passed so any caller that knows the deck path knows the
    board path too — the delivery layer needs both artifacts and should not have
    to round-trip for the second one.
    """
    base = out_pdf[:-4] if out_pdf.lower().endswith(".pdf") else out_pdf
    return base + ".board.pdf"


def build_board_pdf(theme, out_pdf, title_lines, workdir, chasers=False):
    """Render the game board to its OWN one-page PDF.

    In v2 the board is no longer the deck's last page: it is a separate delivered
    artifact, printed at the board artwork's own size rather than the card's.
    """
    cfg = config.theme(theme)
    board_clean = config.board_clean_path(theme, chasers=chasers)
    raw = card_assets.read_svg(board_clean)
    if cfg.get("fix_ring_discs"):
        raw = svg_rings.align_ring_discs(raw)
    vb = deck_html.view_box(raw)
    doc = deck_html.DeckDocument(vb[2], vb[3])
    title_font = rp.title_font_for(theme, title_lines, cfg)
    doc.add_style(rp.GEOMETRIC_TEXT_STYLE
                  + rp.title_faces(theme, cfg, emit=deck_html.font_face, lines=title_lines))
    doc.add_design("board", raw)
    bd, ts = cfg.get("board"), cfg["title_style"]
    overlay = ""
    if bd and title_lines:
        frac = bd["frac"]
        box = {"x0": frac["x0"] * vb[2], "x1": frac["x1"] * vb[2],
               "y0": frac["y0"] * vb[3], "y1": frac["y1"] * vb[3]}
        overlay = rp.title_block(box, title_lines, bd["fill"], bd["outline"],
                                 title_font, ts["outline_w"], ts["arch"], ts["shadow"],
                                 rtl=rp.title_is_rtl(cfg),
                                 fixed_size=ts.get("board_size"),
                                 align=ts.get("align", "center"),
                                 italic=ts.get("italic", False),
                                 bold=ts.get("bold", False),
                                 bold_w=ts.get("bold_w"),
                                 leading=rp.board_leading(ts),
                                 one_block=bool(ts.get("one_block")))
    doc.add_page("board", overlay)
    vbs = " ".join(_fmt(v) for v in vb)
    return print_to_pdf(doc.html(vbs), out_pdf, workdir, tag="board")


def _fmt(v):
    """Render a viewBox number without a trailing ".0" (keeps the attr tidy)."""
    return f"{v:g}"


def deck_document(theme, csvp, title_lines, word_font=None, photos=None,
                  progress=False, workdir=None, press_geom=None, paper=None,
                  photo_views=None):
    """Assemble the whole deck as a ``(DeckDocument, viewBox_string)`` pair.

    Split out from ``build_deck`` so the deck's STRUCTURE — page count, duplex
    ordering, front cycling, the photo card — can be asserted without spawning
    Chrome, which CI may not have.

    ``paper`` is the colour the PAWN card prints on, which ``build_deck``
    measures off the front artwork (``card_paper.front_paper``) and hands in.
    It is a parameter and not a lookup precisely to keep the promise above:
    measuring means rendering a card, and structure does not depend on colour.
    ``None`` leaves the pawn card on the background it was drawn with.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    if not config.is_single_card(cfg):
        raise RuntimeError(
            f"theme {theme!r} is not a single-card template — its themes.json "
            'entry has no "cards" block. Migrate its assets to clean/1..9.svg '
            "first; see docs/card-structure-schema.md."
        )
    recipe = config.recipe_or_empty(cfg)
    theme_dir = config.theme_dir(theme)
    fronts = config.fronts(cfg)
    # A PREVIEW may render a template with no geometry yet — that is the state
    # the calibration screen exists to fix, so it shows the bare card. An ORDER
    # may not: with neither a detected recipe nor saved card_slots there is
    # nowhere to put the words, and the deck would print 104 cards of blank
    # artwork. Fail here, naming the fix, rather than at the customer.
    cell = (recipe.get("card") or {}).get("cell") or rp._recipe_cell(
        recipe, deck_html.view_box(card_assets.read_svg(config.card_path(theme, fronts[0]))))
    if not config.card_word_boxes(cfg, recipe, cell):
        raise RuntimeError(
            f"theme {theme!r} has no word-slot geometry — neither a detected "
            f"recipe ({cfg.get('recipe')!r}) nor saved card_slots. Run detection "
            "for it (the 'זהה מחדש' button in the admin template list), or set "
            "the slots in the calibration form, before taking an order."
        )

    def log(msg):
        if progress:
            print(msg)

    cards = pack.load_cards(csvp)

    # Register each distinct design ONCE; the pages then reference them, so a
    # 208-page deck costs nine copies of the artwork rather than 208.
    # One back index per front, positionally paired (config.back_indices). A
    # one-back template yields the same index repeated, so there is no branch
    # here and no special case downstream — the shared-back deck is just the
    # degenerate pairing.
    backs = config.back_indices(cfg)
    back_by_front = dict(zip(fronts, backs))
    front_svgs = {i: card_assets.read_svg(config.card_path(theme, i))
                  for i in fronts}
    back_svgs = {i: card_assets.read_svg(config.card_path(theme, i))
                 for i in dict.fromkeys(backs)}
    vb = deck_html.view_box(front_svgs[fronts[0]])
    doc = deck_html.DeckDocument(vb[2], vb[3], press=press_geom)
    doc.add_style(rp.GEOMETRIC_TEXT_STYLE
                  + rp.word_faces(theme, word_font, emit=deck_html.font_face)
                  + rp.title_faces(theme, cfg, emit=deck_html.font_face, lines=title_lines))
    for i, svg in back_svgs.items():
        doc.add_design(f"back{i}", svg)
    for i in fronts:
        doc.add_design(f"front{i}", front_svgs[i])
    log(f"registered {len(fronts)} fronts + {len(back_svgs)} back(s)")

    # One overlay PER DISTINCT back, not one for the deck: each back of a paired
    # template is its own artwork and carries the title in its own place (or not
    # at all), so a single overlay would misprint seven cards in eight. Built
    # once per back rather than per card — a 208-card deck has at most eight.
    back_ov = {i: rp.back_overlay(theme, recipe, title_lines, card_vb=vb,
                                  back_index=i)
               for i in dict.fromkeys(backs)}
    photo_paths = resolve_photos(
        theme, photos, views=photo_views,
        workdir=os.path.join(workdir, "photos") if workdir else None)
    # ONE RHYTHM FOR THE DECK, AND THE DECK PICKS IT. The owner's rule is that
    # every gap between lines is the same, on every card — and the number that
    # rule was pinned to came from the origin design, whose entries were all one
    # short word. A deck carrying a long phrase has nowhere to put the extra line
    # at that spacing, so the card could only pay in type size: 9.1pt against the
    # 18pt its siblings set. Asked here instead, before a single card is drawn,
    # because only here is the whole order visible: every card says what spacing
    # it needs, the tightest answer wins, and every card is then printed at it.
    # Cards that need nothing return None and the design's own spacing stands.
    wants = []
    for card in cards:
        if card["kind"] == "photo":
            continue
        front = fronts[card["front"] % len(fronts)]
        need = rp.card_pitch_need(theme, recipe, card["words"], front_index=front,
                                  word_font=word_font, card_vb=vb,
                                  card_svg=front_svgs[front])
        if need:
            wants.append(need)
    deck_pitch = min(wants) if wants else None
    if progress and deck_pitch:
        log(f"deck rhythm: {deck_pitch:.2f} (tightest of {len(wants)} card(s) that wrap)")

    for n, card in enumerate(cards, 1):
        # Resolve this card's FRONT before emitting anything: with per-front backs
        # the back is chosen by the front, and the pages still have to come out in
        # duplex order (back, then front) or the deck prints mismatched.
        if card["kind"] == "photo":
            # The photo card is not one of the eight styles, so it has no paired
            # back of its own — it takes the first, which is also the only one on
            # a shared-back deck.
            front = None
            back = backs[0]
        else:
            front = fronts[card["front"] % len(fronts)]
            back = back_by_front[front]
        doc.add_page(f"back{back}", back_ov[back])         # duplex: back, then front
        if front is None:
            # The photo card's slots live in the artwork and are filled in place
            # (docs/photo-card.md), so the FILLED card is the design — there is
            # no text overlay to lay on top of it, and it needs no font.
            doc.add_design("photo", rp.photo_card_svg(theme, photo_paths,
                                                      paper=paper))
            doc.add_page("photo")
        else:
            doc.add_page(f"front{front}",
                         rp.card_overlay(theme, recipe, card["words"], title_lines,
                                         front_index=front, word_font=word_font,
                                         card_vb=vb, card_svg=front_svgs[front],
                                         deck_pitch=deck_pitch))
        if progress and n % 25 == 0:
            log(f"card {n}/{len(cards)}")

    return doc, " ".join(_fmt(v) for v in vb)


def build_deck(theme, csvp, name, out_pdf, extra_fields=None, word_font=None,
               workdir="/tmp/gen/deck", progress=True, chasers=False,
               custom_title=None, photos=None, press_icc=None, press_bleed=None,
               press_cmyk=True, gender=None, photo_views=None):
    """Assemble a v2 order: the card deck PDF + the board PDF.

    Returns ``(out_pdf, page_count, board_pdf)``. The deck is
    ``[back, card1, back, card2, ...]`` so it prints duplex, and the board is a
    separate file (see ``board_pdf_path``).

    ``photos`` are absolute paths to the customer's pawn photos for the final
    card; short/empty is topped up from the theme's generic fallback set.
    ``photo_views`` optionally carries the framing the BUYER set for each of
    them, one entry per photo (see :func:`apply_photo_view`); ``None`` entries —
    and an absent list — leave the automatic framing in charge.
    ``gender`` ('male'/'female'/None) resolves the title's {feminine|masculine}
    markers (config.resolve_gender_markers); a title without one is unaffected.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {},
                                     custom_title=custom_title, gender=gender)
    # ...and whether the title face can draw that title, before anything is
    # rendered. Same reasoning as the board check just below: find out up front,
    # and never hand over an order whose cards carry a name the buyer did not
    # ask for (render_page.assert_title_drawable).
    rp.assert_title_drawable(rp.title_font_for(theme, title_lines, cfg),
                             title_lines, theme=theme)
    os.makedirs(workdir, exist_ok=True)
    # Check the board artwork BEFORE rendering the deck. An order owes the
    # customer BOTH artifacts, so a missing board is a failed order, not a deck
    # shipped quietly without its board — and finding out up front costs a
    # stat() instead of a full deck render, and leaves no half-finished PDF
    # behind for someone to mistake for a complete one.
    board_clean = config.board_clean_path(theme, chasers=chasers)
    if not os.path.exists(board_clean):
        raise RuntimeError(
            f"theme {theme!r} has no board artwork — looked for {board_clean}. "
            "The board is a separate delivered artifact in the single-card deck "
            "(docs/card-structure-schema.md 1), so it is not optional: a "
            "migrated template must keep its clean/board.svg alongside the "
            "numbered 1..9 cards."
        )
    # A PRESS run renders the same deck onto a bigger sheet — the card artwork
    # keeps its coordinates and the page grows around it to carry bleed and crop
    # marks — and then either converts it to CMYK or hands the RGB over as-is.
    # The customer deck is unchanged by any of this.
    #
    # EITHER argument turns a press run on, because they are two modes of it, not
    # a flag and its option: press_icc names the profile to separate against, and
    # press_cmyk=False says not to separate at all (press.press_pdf). Keying only
    # off press_icc would make pass-through unreachable without naming a profile
    # it is never going to use.
    geom = None
    if press_icc is not None or not press_cmyk:
        vb = deck_html.view_box(card_assets.read_svg(
            config.card_path(theme, config.fronts(cfg)[0])))
        kw = {} if press_bleed is None else {"bleed_mm": press_bleed}
        geom = press.PressGeometry(vb[2], vb[3], **kw)
        if progress:
            mode = "CMYK + flatten" if press_cmyk else "RGB pass-through"
            print(f"press: {geom.describe()} [{mode}]")
    # The pawn card prints on the FRONT card's own paper, so the sheet of pawns
    # matches the deck it ships in. One render, cached on the front's content
    # (docs/photo-card.md); an unmeasurable front leaves the card as shipped.
    doc, vbs = deck_document(theme, csvp, title_lines, word_font=word_font,
                             photos=photos, photo_views=photo_views,
                             progress=progress, workdir=workdir,
                             press_geom=geom,
                             paper=card_paper.front_paper(theme, workdir=workdir))
    print_to_pdf(doc.html(vbs), out_pdf, workdir, tag="deck")
    if geom is not None:
        # Ghostscript is minutes of work on a full deck, so this deliberately
        # runs AFTER the render rather than streaming: a failure here leaves the
        # rendered sheet behind for diagnosis instead of losing both. In
        # pass-through mode there is no Ghostscript and this is a box-write over
        # a copy — seconds, not minutes, which is the entire point of the mode.
        press.press_pdf(out_pdf, out_pdf, geom, icc=press_icc or None,
                        cmyk=press_cmyk)
    if progress:
        print(f"deck: {doc.page_count} pages")
    board = build_board_pdf(theme, board_pdf_path(out_pdf), title_lines, workdir,
                            chasers=chasers)
    if progress:
        print(f"board: {board}")
    return out_pdf, doc.page_count, board


# Where a face sits in a portrait photo, as a fraction of its height. THIS IS THE
# DEGRADED PATH ONLY. A photo that carries no usable alpha — an opaque phone
# photo, or a cutout that failed — gives us nothing to look at, so the only crop
# left is a guess, and this is the guess we shipped before subject-aware cropping
# existed. Every photo that DOES carry a cutout is framed from its alpha instead
# (``subject_box``) and never reads this value. 0.5 would be the plain centre
# crop that put the slot's circle on people's torsos.
#
# This is exactly where the guess still earns its keep: with no alpha there is no
# subject box to measure, and the square still has to be clipped to the disc
# (a photo NEVER prints as a rectangle — docs/photo-card.md point 1), so where
# the square sits decides which part of the person the circle keeps.
PHOTO_SUBJECT_Y = float(os.environ.get("DUGRI_PHOTO_SUBJECT_Y", "0.30"))

# --- subject-aware framing (docs/photo-card.md) ------------------------------
# A cutout tells us exactly where the person is, so nothing here is a guess. The
# square we hand the slot is built from the subject's own alpha:
#
#   1. the bounding box of the non-transparent pixels — of the blob nearest the
#      centre of the frame, if the cut left more than one;
#   2. scaled so the WHOLE subject fits inside the slot's visible disc, centred
#      on it;
#   3. clipped to that disc, so everything outside is cut away.
#
# THE OWNER'S RULE, in her words: "fit the whole photo in the circle". Step 2
# used to size the window on the subject's WIDTH, which framed the face at a
# consistent size but let a taller-than-wide cutout — which is most head-and-
# shoulders photos — run out of the bottom of the circle, where step 3 cut it.
# She has seen that printed on two pawns and does not want it: a subject that
# does not fit is made smaller, never trimmed.
#
# What that costs, stated out loud because it undoes half of an earlier fix: a
# cutout whose alpha ends in a ruler-straight line (the photo's own bottom edge,
# which is where the person ran out of frame) now shows that edge INSIDE the
# disc, and the sticker halo — dilated from the image's own alpha — traces it.
# Pushing that edge outside the circle is exactly what the old width-framing did,
# and it can only be done by cutting the subject. The two cannot both be had.

# An alpha at or above this counts as subject. Deliberately low: the soft edge of
# a hair matte runs from 0 to 255 over a few pixels and belongs to the subject.
PHOTO_ALPHA_MIN = 24

# Below this share of the frame there is nothing worth framing (a cut that
# collapsed), and above the second there is nothing transparent to frame BY (an
# ordinary opaque photo). Either way we fall back to the old square crop.
PHOTO_SUBJECT_MIN_COVER = 0.005
PHOTO_SUBJECT_MAX_COVER = 0.995

# A blob smaller than this share of the biggest one is a speck the segmenter left
# behind, never the subject — it is dropped before the nearest-to-centre choice
# so a stray 20-pixel scrap at dead centre cannot beat the person.
PHOTO_BLOB_MIN_SHARE = 0.08

# Long side of the mask the blob search runs on. Full resolution would be a
# million-pixel flood fill in pure Python (numpy is TEST-ONLY here — the
# production image ships py3-pillow and nothing else, see the Dockerfile).
PHOTO_BLOB_MASK_PX = 200

# How much of the square the visible disc takes. NOT 1.0 on purpose: the halo is
# dilated ~2.4 units outward from the image's alpha and the dashed cut-line sits
# at r=33 of a 66-unit slot, so a disc filling the whole square would put the
# white ring exactly ON the dashes — hiding the line you are meant to cut, and
# putting the ring outside the cut so it is trimmed off the finished pawn. At
# 0.90 the ring lands inside the dashes: outlined disc first, cut-line just
# outside it, which is also the right order for a real die-cut sticker.
PHOTO_DISC_FILL = float(os.environ.get("DUGRI_PHOTO_DISC_FILL", "0.90"))

# How far the REACH measurement may miss by, as a share of the coarse mask's own
# pixel. The reach is read off a downscaled mask (PHOTO_BLOB_MASK_PX), so a
# silhouette's outermost pixel can fall between samples; padding the answer by
# one mask pixel keeps the real edge inside the disc rather than a fraction of a
# source pixel outside it. Cheap insurance: one mask pixel is ~0.5% of the disc.
PHOTO_REACH_SLACK = 1.0

# The square we hand the slot, per docs/photo-card.md: 512 target, 220 floor
# (300 DPI over the slot's 18.57 mm), 1024 ceiling — every pixel above that is
# base64 that ships in the order's PDF four times over.
PHOTO_SLOT_PX = int(os.environ.get("DUGRI_PHOTO_SLOT_PX", "512"))
PHOTO_SLOT_MIN_PX = 220
PHOTO_SLOT_MAX_PX = 768
# deck_html hoists any <image> whose base64 payload exceeds BG_MIN_CHARS into
# shared defs and replaces the element with a <use> — which would strip the
# photo-slot id and orphan the sticker halo bound to it. A photo must therefore
# stay well under that threshold. 512x512 RGBA lands far below it; this is the
# belt-and-braces check, and deck_html additionally refuses to hoist a photo slot
# at all (see split_background) so neither guard alone has to be perfect.
PHOTO_MAX_B64_CHARS = 900_000


def _b64_chars(path):
    """Base64 length this file will occupy once inlined into the card."""
    return (os.path.getsize(path) + 2) // 3 * 4


def _blobs(mask):
    """Label the 8-connected blobs of a 0/255 mask.

    Returns ``[(pixels, (l, t, r, b), (cx, cy), seed), ...]``, biggest first —
    ``seed`` being one pixel known to belong to the blob, so a caller can walk it
    again without hunting for a way in. Pure Pillow + stdlib: an iterative flood
    fill, which is why the caller works on a small mask rather than the
    full-resolution alpha.
    """
    w, h = mask.size
    px = mask.load()
    seen = bytearray(w * h)
    out = []
    for y0 in range(h):
        row = y0 * w
        for x0 in range(w):
            if not px[x0, y0] or seen[row + x0]:
                continue
            seen[row + x0] = 1
            stack = [(x0, y0)]
            n = 0
            sx = sy = 0
            left = right = x0
            top = bottom = y0
            while stack:
                x, y = stack.pop()
                n += 1
                sx += x
                sy += y
                if x < left:
                    left = x
                elif x > right:
                    right = x
                if y < top:
                    top = y
                elif y > bottom:
                    bottom = y
                for ny in range(max(0, y - 1), min(h, y + 2)):
                    nrow = ny * w
                    for nx in range(max(0, x - 1), min(w, x + 2)):
                        if px[nx, ny] and not seen[nrow + nx]:
                            seen[nrow + nx] = 1
                            stack.append((nx, ny))
            out.append((n, (left, top, right + 1, bottom + 1), (sx / n, sy / n), (x0, y0)))
    out.sort(key=lambda b: -b[0])
    return out


def subject_box(im):
    """Where the subject is in an RGBA image: ``(box, alpha)`` or ``None``.

    ``box`` is the bounding rectangle of the cutout's non-transparent pixels;
    ``alpha`` is the image's alpha with every OTHER blob erased, so a bystander
    the segmenter kept in a corner does not come along for the ride.

    Which blob is the subject: **the one whose centre of mass is nearest the
    centre of the frame**. Not the biggest — a person standing behind the
    honoree can easily be the larger of the two, and the one being photographed
    is the one in the middle. Specks are dropped first (``PHOTO_BLOB_MIN_SHARE``)
    so nothing tiny can win on position alone.

    ``None`` means "no usable alpha" — an opaque photo, or a cut that collapsed
    to nothing. The caller falls back to the old square crop rather than failing.
    """
    from PIL import Image, ImageFilter
    if im.mode != "RGBA":
        return None
    w, h = im.size
    alpha = im.getchannel("A")
    lo, hi = alpha.getextrema()
    if hi < PHOTO_ALPHA_MIN or lo >= PHOTO_ALPHA_MIN:
        # Nothing opaque at all, or nothing transparent at all: either way the
        # alpha carries no silhouette to frame by.
        return None
    solid = alpha.point(lambda v: 255 if v >= PHOTO_ALPHA_MIN else 0)
    box = solid.getbbox()
    if not box:
        return None
    opaque = sum(i * c for i, c in enumerate(solid.histogram())) // 255
    cover = opaque / float(w * h)
    if not PHOTO_SUBJECT_MIN_COVER <= cover <= PHOTO_SUBJECT_MAX_COVER:
        return None

    # The blob search runs on a small copy; at full resolution this flood fill
    # would be a million iterations of Python.
    scale = PHOTO_BLOB_MASK_PX / float(max(w, h))
    if scale < 1:
        sw = max(1, int(round(w * scale)))
        sh = max(1, int(round(h * scale)))
        small = solid.resize((sw, sh), Image.BILINEAR).point(lambda v: 255 if v >= 128 else 0)
    else:
        sw, sh, small = w, h, solid
    found = _blobs(small)
    if not found:
        return None
    pick = found[0]
    if len(found) > 1:
        biggest = found[0][0]
        real = [b for b in found if b[0] >= PHOTO_BLOB_MIN_SHARE * biggest] or found[:1]
        cx, cy = sw / 2.0, sh / 2.0
        pick = min(real, key=lambda b: (b[2][0] - cx) ** 2 + (b[2][1] - cy) ** 2)

        # Erase the blobs we did not pick. The keep-mask is built small and blown
        # back up, so it is DILATED first: a mask that lands a pixel short would
        # shave the subject's own edge, while a pixel long only reaches into the
        # empty gap between blobs.
        keep = Image.new("L", (sw, sh), 0)
        kpx = keep.load()
        spx = small.load()
        # Re-walk the chosen blob only (cheap: one blob, small mask).
        stack = [pick[3]]
        seen = bytearray(sw * sh)
        while stack:
            x, y = stack.pop()
            if x < 0 or y < 0 or x >= sw or y >= sh or seen[y * sw + x] or not spx[x, y]:
                continue
            seen[y * sw + x] = 1
            kpx[x, y] = 255
            for ny in range(max(0, y - 1), min(sh, y + 2)):
                for nx in range(max(0, x - 1), min(sw, x + 2)):
                    if spx[nx, ny] and not seen[ny * sw + nx]:
                        stack.append((nx, ny))
        keep = keep.filter(ImageFilter.MaxFilter(5))
        if (sw, sh) != (w, h):
            keep = keep.resize((w, h), Image.BILINEAR).point(lambda v: 255 if v >= 96 else 0)
        alpha = alpha.copy()
        alpha.paste(0, (0, 0, w, h), keep.point(lambda v: 255 - v))
        solid = alpha.point(lambda v: 255 if v >= PHOTO_ALPHA_MIN else 0)

    # The blob's box is only as precise as the small mask, so re-measure the
    # full-resolution alpha inside a generous window around it.
    if scale < 1:
        pad = int(round(2 / scale))
        bl, bt, br, bb = pick[1]
        window = (max(0, int(bl / scale) - pad), max(0, int(bt / scale) - pad),
                  min(w, int(br / scale) + pad), min(h, int(bb / scale) + pad))
    else:
        window = pick[1]
    tight = solid.crop(window).getbbox()
    if tight:
        box = (window[0] + tight[0], window[1] + tight[1],
               window[0] + tight[2], window[1] + tight[3])
    if box[2] <= box[0] or box[3] <= box[1]:
        return None
    return box, alpha


def _disc_mask(size):
    """An anti-aliased disc of ``PHOTO_DISC_FILL`` x ``size``, centred."""
    from PIL import Image, ImageDraw
    ss = 4
    big = Image.new("L", (size * ss, size * ss), 0)
    r = size * ss * PHOTO_DISC_FILL / 2.0
    c = size * ss / 2.0
    ImageDraw.Draw(big).ellipse([c - r, c - r, c + r, c + r], fill=255)
    return big.resize((size, size), Image.LANCZOS)


def subject_reach(box, alpha=None):
    """How far the subject reaches from ``box``'s centre, in source pixels.

    The radius of the smallest circle centred there that holds the whole subject
    — which is what the disc has to be able to cover for nothing to be cut off.

    Measured off the SILHOUETTE when the alpha is available, not off the bounding
    box, because the two differ by a lot on exactly the shape this card is full
    of: a head's box has empty corners, so its corner radius over-states the
    reach by up to 40% and would shrink the face for room nobody occupies. With
    no alpha to read there is no silhouette either, so the box's own corner is
    the honest answer.

    The centre is the box's, not the centre of mass: a circle around the box
    centre is the one the window is built on, and re-centring to shave a few
    pixels off the radius would slide the person off the middle of the disc.
    """
    cx = (box[0] + box[2]) / 2.0
    cy = (box[1] + box[3]) / 2.0
    corner = math.hypot(box[2] - box[0], box[3] - box[1]) / 2.0
    if alpha is None:
        return corner
    from PIL import Image
    w, h = alpha.size
    scale = min(1.0, PHOTO_BLOB_MASK_PX / float(max(w, h) or 1))
    if scale < 1:
        small = alpha.resize((max(1, int(w * scale)), max(1, int(h * scale))),
                             Image.BILINEAR)
    else:
        small, scale = alpha, 1.0
    sw, sh = small.size
    px = small.load()
    best = 0.0
    for y in range(sh):
        # Only a row's OUTERMOST subject pixels can be its farthest from the
        # centre — distance grows with |x - cx| — so two scans per row answer it
        # without measuring the interior.
        first = last = None
        for x in range(sw):
            if px[x, y] >= PHOTO_ALPHA_MIN:
                if first is None:
                    first = x
                last = x
        if first is None:
            continue
        sy = (y + 0.5) / scale
        for x in (first, last):
            best = max(best, math.hypot((x + 0.5) / scale - cx, sy - cy))
    if best <= 0:
        return corner
    # The mask is coarse; keep the real edge inside. Never past the box corner,
    # which already contains every pixel by construction.
    return min(best + PHOTO_REACH_SLACK / scale, corner)


def subject_window(box, disc_fill=None, alpha=None):
    """The square region of the SOURCE that maps onto the output square.

    ``box`` is the subject's bounding rectangle; the returned window is in the
    same coordinates and may fall outside the photo — cropping past the edge
    pads with transparency, which is exactly what a sticker wants.

    Sized so the WHOLE subject lands inside the visible disc and centred on it:
    the disc is set to the subject's own reach (:func:`subject_reach`), so the
    outermost pixel of the silhouette touches the circle and nothing crosses it.
    A subject too big for the disc is therefore made smaller, never trimmed —
    the owner's rule, and the reason this no longer frames on width alone.
    """
    fill = PHOTO_DISC_FILL if disc_fill is None else disc_fill
    disc = 2.0 * subject_reach(box, alpha)
    side = disc / fill
    left = (box[0] + box[2]) / 2.0 - side / 2.0
    top = (box[1] + box[3]) / 2.0 - side / 2.0
    return (int(round(left)), int(round(top)),
            int(round(left + side)), int(round(top + side)))


def parse_photo_view(text):
    """``"zoom,dx,dy"`` from the CLI as a ``(zoom, dx, dy)`` tuple, or ``None``.

    Anything unparseable is ``None`` — the automatic framing then stands, which
    is the behaviour every order had before the buyer could move her photos.
    Bounds mirror site/js/pawn-frame.js (and the store's own clamp): the slider
    that produces these cannot leave them, and a hand-made value must not either.
    """
    if not text:
        return None
    parts = str(text).split(",")
    if len(parts) != 3:
        return None
    try:
        zoom, dx, dy = (float(p) for p in parts)
    except ValueError:
        return None
    zoom = min(2.5, max(0.5, zoom))
    dx = min(1.0, max(-1.0, dx))
    dy = min(1.0, max(-1.0, dy))
    if (zoom, dx, dy) == (1.0, 0.0, 0.0):
        return None
    return (zoom, dx, dy)


def apply_photo_view(crop, view):
    """``crop`` moved and scaled the way the BUYER placed this photo.

    The window is what moves, not the picture: ``zoom`` above 1 shrinks the
    window (closer in), and ``dx``/``dy`` slide it across the source in units of
    the window's OWN side, so the same numbers mean the same thing on a 900px
    photo and a 4000px one. site/js/pawn-frame.js applyView is the identical
    transform expressed in percent-of-slot, which is why what she lines up on her
    phone is what the printer cuts.

    Always square, because the slot is: the window's x-side wins, so a rounding
    difference between the two axes cannot stretch the face.
    """
    if not view:
        return crop
    zoom, dx, dy = view
    x0, y0, x1, y1 = crop
    side = float(x1 - x0)
    new = side / zoom
    cx = (x0 + x1) / 2.0 + dx * side
    cy = (y0 + y1) / 2.0 + dy * side
    return (int(round(cx - new / 2)), int(round(cy - new / 2)),
            int(round(cx + new / 2)), int(round(cy + new / 2)))


def square_photo(path, workdir, index=0, view=None):
    """A square copy of a customer photo, framed on the subject.

    With a cutout (the normal case — the wizard cuts the background out on the
    buyer's device) the frame comes from the alpha: the subject's own bounding
    box, scaled to span the slot's visible disc, centred on it and CLIPPED to it.
    The old fixed square guessed at the head and sliced the person along a
    straight line that the sticker halo then traced; see docs/photo-card.md.

    With no usable alpha — an opaque photo, or a cut that failed — there is no
    subject box to measure, so the head-anchored square crop (``PHOTO_SUBJECT_Y``)
    picks the square. It is then clipped to the disc like every other photo:
    **a photo never prints as a rectangle**, whatever happened upstream
    (docs/photo-card.md point 1). An uncut photo therefore comes out round with
    its background still inside the circle — less obviously a failure than the
    white-edged rectangle this used to print, which is why the failed cut is
    recorded on the collection (``pawn_cutouts[original] = null``) for the owner
    to fix by hand rather than advertised on the card.

    Also applies the EXIF orientation: a photo taken sideways carries its
    rotation as metadata, and the renderer does not honour it, so without this a
    phone photo can land on the card on its side.

    Best-effort by design — anything unreadable returns the ORIGINAL path, so a
    photo we cannot process still prints (centred) rather than failing an order.
    That degradation is deliberate but it is NOT free, and it is not silent: the
    original has never been through the disc clip, so it reaches the slot as a
    rectangle, which is the one thing docs/photo-card.md point 1 promises never
    happens. Every fall through here therefore says so on stderr, naming the file
    and the exception. It used to say nothing at all, and a card that quietly
    prints the wrong picture is indistinguishable from a card that is right —
    which is exactly how long a wrong one survives.
    """
    try:
        from PIL import Image, ImageChops, ImageOps
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            if w <= 0 or h <= 0:
                return path
            # RGBA, not RGB: converting to RGB FLATTENS the alpha channel, so a
            # transparent cutout arrived opaque and — now that the white disc
            # behind it is gone (die-cut stickers) — printed as a white-edged
            # rectangle. The shipped fallbacks never pass through here, which is
            # why they looked right while real customer photos did not.
            im = im.convert("RGBA")
            found = subject_box(im)
            if found:
                box, alpha = found
                im.putalpha(alpha)
                crop = subject_window(box, alpha=alpha)
            else:
                # No alpha to measure, so the square is a guess. The disc clip
                # below still runs — an opaque photo has no silhouette, so that
                # disc is the only alpha it will ever have, and it is the alpha
                # the sticker halo is dilated from. Skip it and the slot gets a
                # full square whose corners the halo traces: a white-edged
                # rectangle on the card, which is what this path used to print.
                side = min(w, h)
                if h > w:
                    # Portrait: centre the square on the subject rather than on
                    # the middle of the frame (their torso) or flush with the top
                    # (which the slot's circle would then clip).
                    top = int(round(PHOTO_SUBJECT_Y * h - side / 2))
                    top = max(0, min(top, h - side))
                    crop = (0, top, side, top + side)
                else:
                    # Landscape: people are usually centred left-to-right.
                    left = (w - side) // 2
                    crop = (left, 0, left + side, side)
            # …and then the buyer's own adjustment, if she made one. Applied to
            # whichever square the rules above chose, so "move it a bit left" is
            # relative to a frame she was already looking at rather than to the
            # raw photo. Everything downstream — the resize, the disc clip — runs
            # exactly as before, which is why she can push the subject past the
            # circle if she wants to and it comes out cropped rather than broken.
            crop = apply_photo_view(crop, view)
            # Cropping PAST the edge of the photo is intended when the subject
            # runs off it: Pillow pads with zeros, which on RGBA is transparent —
            # the sticker simply has empty space there.
            square = im.crop(crop)
            target = max(PHOTO_SLOT_MIN_PX, min(PHOTO_SLOT_PX, PHOTO_SLOT_MAX_PX))
            if square.width != target:
                # Normalise the size the card carries. Upscaling a small photo is
                # deliberate: below the floor it prints under 300 DPI, and the
                # slot would scale it anyway — doing it here keeps every card's
                # payload predictable.
                square = square.resize((target, target), Image.LANCZOS)
            # Clip to the slot's disc — ALWAYS, both paths. Everything outside is
            # cut away, so the sticker's edge is the circle and not wherever the
            # photo's own border happened to slice the person. On the degraded
            # path the disc is the whole of the alpha; on the framed path it is a
            # ceiling on how far the subject's own silhouette may reach.
            square.putalpha(ImageChops.multiply(square.getchannel("A"),
                                                _disc_mask(square.width)))
            out = os.path.join(workdir, f"photo-{index + 1}.png")
            os.makedirs(workdir, exist_ok=True)
            square.save(out)
            # A photo that still encodes too large would be hoisted out of the
            # card by the deck assembler; step the size down rather than let it
            # silently lose its slot id.
            side_px = target
            while _b64_chars(out) > PHOTO_MAX_B64_CHARS and side_px > PHOTO_SLOT_MIN_PX:
                side_px = max(PHOTO_SLOT_MIN_PX, int(side_px * 0.8))
                square.resize((side_px, side_px), Image.LANCZOS).save(out)
            return out
    except Exception as exc:
        print(
            "square_photo: could not frame %r (%s: %s) — it goes to the slot "
            "UNFRAMED and UNCLIPPED, i.e. it prints as a rectangle"
            % (path, type(exc).__name__, exc),
            file=sys.stderr,
        )
        return path


def fallback_photos(theme, filled):
    """The shipped Dugri pawns that fill the slots a buyer left empty.

    ``filled`` is how many of the four slots her own photos already take, so the
    answer is what goes in the rest — in the fallbacks' own order, which is what
    the deck prints. Pulled out of :func:`resolve_photos` so the LIVE pawn-card
    preview can render the same pawns into the same slots without going through
    the customer-photo path: the browser draws her photos onto that card itself,
    and a card rendered with four bare discs told her the empty ones print empty.
    They do not — an order with two photos prints two faces and two Dugri pawns.
    """
    out = []
    for path in config.photo_fallback_paths(theme):
        if filled + len(out) >= 4:
            break
        out.append(path)
    return out


def resolve_photos(theme, photos, workdir=None, views=None):
    """The four photo-card images: the customer's, topped up from the fallbacks.

    A customer who uploaded nothing gets the generic Dugri set; one who uploaded
    two gets those two plus two generics, so the card is never half-empty. Paths
    that do not exist are dropped rather than rendered as a broken image.

    ``views`` is the buyer's own framing, one entry per entry of ``photos`` (see
    :func:`apply_photo_view`); ``None`` anywhere in it means "frame this one
    automatically". A photo dropped for not existing takes its view with it, so
    the two lists cannot slide against each other and put one face's framing on
    another's.
    """
    # Only the CUSTOMER's photos are squared; the shipped pawns are already
    # square sticker art and re-encoding them would only lose quality.
    views = list(views or [])
    pairs = [(p, views[i] if i < len(views) else None)
             for i, p in enumerate(photos or []) if p and os.path.isfile(p)]
    given = [p for p, _ in pairs]
    if workdir:
        given = [square_photo(p, workdir, i, view=v)
                 for i, (p, v) in enumerate(pairs)]
    out = list(given)
    if len(out) >= 4:
        return out[:4]
    out.extend(fallback_photos(theme, len(out)))
    return out[:4]


def main():
    theme, fronts, board, csvp, name, out_pdf = sys.argv[1:7]
    backs = sys.argv[7] if len(sys.argv) > 7 else None
    build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=backs)


if __name__ == "__main__":
    main()
