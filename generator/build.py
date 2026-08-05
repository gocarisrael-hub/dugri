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
import sys
import re
from PIL import Image

import card_assets
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
    title_font = config.font_path(theme, cfg["title_font"])
    box = {k: (frac[k] * vb[2] if "x" in k else frac[k] * vb[3]) for k in frac}
    svg = board_svg
    style = ("<style>" + rp.GEOMETRIC_TEXT_STYLE
             + rp.font_face("TitleFont", title_font,
                              config.title_font_weight(cfg)) + "</style>")
    body = style + rp.title_block(box, title_lines, bd["fill"], bd["outline"],
                                  title_font, ts["outline_w"], ts["arch"], ts["shadow"],
                                  rtl=rp.title_is_rtl(cfg),
                                  fixed_size=ts.get("board_size"),
                                  align=ts.get("align", "center"),
                                  italic=ts.get("italic", False),
                                  bold=ts.get("bold", False),
                                  bold_w=ts.get("bold_w"),
                                  leading=rp.board_leading(ts))
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
    title_font = config.font_path(theme, cfg["title_font"])
    recipe = config.load_recipe(cfg["recipe"])
    svg = open(backs_clean, encoding="utf-8").read()
    body = ["<style>" + rp.GEOMETRIC_TEXT_STYLE
            + rp.font_face("TitleFont", title_font,
                             config.title_font_weight(cfg)) + "</style>"]
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
                                   leading=rp.back_leading(ts, bk)))
    return render_svg(svg.replace("</svg>", "".join(body) + "</svg>"), w, h, out_png)


def build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=None,
              extra_fields=None, word_font=None, workdir="/tmp/gen/build",
              progress=True, chasers=False, custom_title=None):
    """Assemble the full order PDF and return (out_pdf, page_count).

    ``extra_fields`` feeds the theme's title template (e.g. AGE/YEARS/NAME1);
    ``word_font`` optionally overrides the theme's card word font (a filename in
    the theme's ``fonts/`` dir). ``progress`` prints per-page lines (as the CLI
    did) so a caller can stream progress; pass False to stay quiet.
    ``custom_title`` (F7) optionally overrides the theme-derived title on every
    surface (fronts/backs/board); empty/absent keeps the theme default.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {}, custom_title=custom_title)
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
    title_font = config.font_path(theme, cfg["title_font"])
    doc.add_style(rp.GEOMETRIC_TEXT_STYLE
                  + deck_html.font_face("TitleFont", title_font,
                                        config.title_font_weight(cfg)))
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
                                 leading=rp.board_leading(ts))
    doc.add_page("board", overlay)
    vbs = " ".join(_fmt(v) for v in vb)
    return print_to_pdf(doc.html(vbs), out_pdf, workdir, tag="board")


def _fmt(v):
    """Render a viewBox number without a trailing ".0" (keeps the attr tidy)."""
    return f"{v:g}"


def deck_document(theme, csvp, title_lines, word_font=None, photos=None,
                  progress=False, workdir=None, press_geom=None):
    """Assemble the whole deck as a ``(DeckDocument, viewBox_string)`` pair.

    Split out from ``build_deck`` so the deck's STRUCTURE — page count, duplex
    ordering, front cycling, the photo card — can be asserted without spawning
    Chrome, which CI may not have.
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
    word_font_path = config.resolve_word_font(theme, word_font)
    title_font_path = config.font_path(theme, cfg["title_font"])
    doc.add_style(rp.GEOMETRIC_TEXT_STYLE
                  + deck_html.font_face("HebWord", word_font_path)
                  + deck_html.font_face("TitleFont", title_font_path,
                                       config.title_font_weight(cfg)))
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
        theme, photos,
        workdir=os.path.join(workdir, "photos") if workdir else None)
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
            doc.add_design("photo", rp.fill_photo_slots(
                card_assets.read_svg(config.photo_card_path(theme)), photo_paths))
            doc.add_page("photo")
        else:
            doc.add_page(f"front{front}",
                         rp.card_overlay(theme, recipe, card["words"], title_lines,
                                         front_index=front, word_font=word_font,
                                         card_vb=vb, card_svg=front_svgs[front]))
        if progress and n % 25 == 0:
            log(f"card {n}/{len(cards)}")

    return doc, " ".join(_fmt(v) for v in vb)


def build_deck(theme, csvp, name, out_pdf, extra_fields=None, word_font=None,
               workdir="/tmp/gen/deck", progress=True, chasers=False,
               custom_title=None, photos=None, press_icc=None, press_bleed=None):
    """Assemble a v2 order: the card deck PDF + the board PDF.

    Returns ``(out_pdf, page_count, board_pdf)``. The deck is
    ``[back, card1, back, card2, ...]`` so it prints duplex, and the board is a
    separate file (see ``board_pdf_path``).

    ``photos`` are absolute paths to the customer's pawn photos for the final
    card; short/empty is topped up from the theme's generic fallback set.
    """
    cfg = config.theme(theme)
    config.ensure_calibrated(cfg)
    title_lines = config.title_lines(cfg, name, extra_fields or {},
                                     custom_title=custom_title)
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
    # marks — then converts to CMYK and flattens. The customer deck is unchanged
    # by any of this: press_icc is what turns it on.
    geom = None
    if press_icc is not None:
        vb = deck_html.view_box(card_assets.read_svg(
            config.card_path(theme, config.fronts(cfg)[0])))
        kw = {} if press_bleed is None else {"bleed_mm": press_bleed}
        geom = press.PressGeometry(vb[2], vb[3], **kw)
        if progress:
            print("press: " + geom.describe())
    doc, vbs = deck_document(theme, csvp, title_lines, word_font=word_font,
                             photos=photos, progress=progress, workdir=workdir,
                             press_geom=geom)
    print_to_pdf(doc.html(vbs), out_pdf, workdir, tag="deck")
    if geom is not None:
        # Ghostscript is minutes of work on a full deck, so this deliberately
        # runs AFTER the render rather than streaming: a failure here leaves the
        # rendered sheet behind for diagnosis instead of losing both.
        press.press_pdf(out_pdf, out_pdf, geom, icc=press_icc or None)
    if progress:
        print(f"deck: {doc.page_count} pages")
    board = build_board_pdf(theme, board_pdf_path(out_pdf), title_lines, workdir,
                            chasers=chasers)
    if progress:
        print(f"board: {board}")
    return out_pdf, doc.page_count, board


# Where a face sits in a portrait photo, as a fraction of the SPARE height. The
# slot crops a square out of the photo, and a phone photo of a person is tall —
# so the middle band is their torso and the crop beheads them. Anchoring near
# the top keeps the head, with a little headroom so it isn't flush against the
# edge. 0 = flush top, 0.5 = the centre crop that was cutting faces off.
# Where a person's head-and-shoulders sits in a portrait photo, as a fraction of
# its height. The crop is CENTRED on this point, not anchored to the top: the
# slot shows only the INSCRIBED CIRCLE, and docs/photo-card.md asks for the
# subject inside a centred disc of 0.46 x the side, so a subject pinned near the
# top edge gets its head clipped by the circle. 0.5 would be the plain centre
# crop that put the disc on people's torsos.
PHOTO_SUBJECT_Y = float(os.environ.get("DUGRI_PHOTO_SUBJECT_Y", "0.30"))

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


def square_photo(path, workdir, index=0):
    """A square copy of a customer photo, cropped to keep the person's head.

    The card's slots are square and crop with ``slice``, centred — fine for the
    shipped pawns, which are already square, and wrong for a customer's photo,
    which is usually portrait. Cropping here rather than changing the template's
    ``preserveAspectRatio`` keeps the disc, ring and clip exactly as designed.

    Also applies the EXIF orientation: a photo taken sideways carries its
    rotation as metadata, and the renderer does not honour it, so without this a
    phone photo can land on the card on its side.

    Best-effort by design — anything unreadable returns the ORIGINAL path, so a
    photo we cannot process still prints (centred) rather than failing an order.
    """
    try:
        from PIL import Image, ImageOps
        with Image.open(path) as im:
            im = ImageOps.exif_transpose(im)
            w, h = im.size
            if w <= 0 or h <= 0:
                return path
            side = min(w, h)
            if h > w:
                # Portrait: centre the square on the subject rather than on the
                # middle of the frame (their torso) or flush with the top (which
                # the slot's circle would then clip).
                top = int(round(PHOTO_SUBJECT_Y * h - side / 2))
                top = max(0, min(top, h - side))
                box = (0, top, side, top + side)
            else:
                # Landscape: people are usually centred left-to-right.
                left = (w - side) // 2
                box = (left, 0, left + side, side)
            # RGBA, not RGB: converting to RGB FLATTENS the alpha channel, so a
            # transparent cutout arrived opaque and — now that the white disc
            # behind it is gone (die-cut stickers) — printed as a white-edged
            # rectangle. The shipped fallbacks never pass through here, which is
            # why they looked right while real customer photos did not.
            square = im.convert("RGBA").crop(box)
            target = max(PHOTO_SLOT_MIN_PX, min(PHOTO_SLOT_PX, PHOTO_SLOT_MAX_PX))
            if square.width != target:
                # Normalise the size the card carries. Upscaling a small photo is
                # deliberate: below the floor it prints under 300 DPI, and the
                # slot would scale it anyway — doing it here keeps every card's
                # payload predictable.
                square = square.resize((target, target), Image.LANCZOS)
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
    except Exception:
        return path


def resolve_photos(theme, photos, workdir=None):
    """The four photo-card images: the customer's, topped up from the fallbacks.

    A customer who uploaded nothing gets the generic Dugri set; one who uploaded
    two gets those two plus two generics, so the card is never half-empty. Paths
    that do not exist are dropped rather than rendered as a broken image.
    """
    # Only the CUSTOMER's photos are squared; the shipped pawns are already
    # square sticker art and re-encoding them would only lose quality.
    given = [p for p in (photos or []) if p and os.path.isfile(p)]
    if workdir:
        given = [square_photo(p, workdir, i) for i, p in enumerate(given)]
    out = list(given)
    if len(out) >= 4:
        return out[:4]
    for path in config.photo_fallback_paths(theme):
        if len(out) >= 4:
            break
        out.append(path)
    return out[:4]


def main():
    theme, fronts, board, csvp, name, out_pdf = sys.argv[1:7]
    backs = sys.argv[7] if len(sys.argv) > 7 else None
    build_pdf(theme, fronts, board, csvp, name, out_pdf, backs=backs)


if __name__ == "__main__":
    main()
