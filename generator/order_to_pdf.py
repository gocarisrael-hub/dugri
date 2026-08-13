#!/usr/bin/env python3
"""Turn one order into the full print-ready PDF.

Pipeline (reuses the existing generator modules):
  personal words --topup--> full deck --pack--> Canva CSV --build--> PDF

  from order_to_pdf import order_to_pdf
  pdf, pages = order_to_pdf("trip comeback", "OZ", {}, personal_words)

CLI:
  python3 generator/order_to_pdf.py <theme> <name> <words.txt> <out.pdf> \
          [--word-font FONT.ttf] [--field KEY=VALUE ...]

The theme's calibrated clean backgrounds (fronts/board/backs) come from
config.clean_path(theme, which). Only calibrated themes render; others raise.
"""
import argparse
import json
import os
import shutil
import sys
import tempfile

import config
import pack
import word_demand
import build as buildmod
import topup as topupmod
from topup import topup


def order_to_pdf(theme_key, name, extra_fields, personal_words, out_pdf=None,
                 word_font=None, workdir=None, progress=False, chasers=False,
                 custom_title=None, photos=None, press_icc=None,
                 press_bleed=None, press_cmyk=True, gender=None, wordlist=None,
                 order=pack.ORDER_RANDOM, personal_count=None):
    """Render an order and return ``(out_pdf, page_count, board_pdf)``.

    ``board_pdf`` is the separate board file a v2 (single-card) template
    produces, and None for a v1 template, whose board is still the last page of
    the single PDF.

    theme_key     a key in generator/themes.json (e.g. "trip comeback")
    name          the honoree name (cased per the theme's name_form)
    extra_fields  dict feeding the theme title template (AGE/YEARS/NAME1/...)
    personal_words the customer's own words (all are always included)
    out_pdf       output path; a temp file is used when omitted
    word_font     optional card-font filename override (in the theme fonts dir)
    chasers       when True, use the theme's chasers board variant if it ships one
                  (clean/board-chasers.svg), else the normal board (additive)
    custom_title  optional free-form title (F7) that overrides the theme-derived
                  title on the cards + board; empty/absent keeps the theme default
    photos        absolute paths to the customer's pawn photos for the final
                  photo card (v2 only); fewer than four are topped up from the
                  theme's generic Dugri fallback set
    press_cmyk    False builds the press copy WITHOUT the Ghostscript pass: no
                  CMYK conversion, no flattening, no outlining, and no
                  OutputIntent (nothing separated it, so nothing may claim to
                  have). The bleed, crop marks and TrimBox are still written —
                  that is where to cut, and it is not what was dropped. Turns a
                  press run on by itself, so no unused ICC path is required
    wordlist      optional seed-pool override for THIS order: the filler pool
                  used to top the deck up, replacing the theme's own. The
                  buyer's personal words still come first and generic-350 is
                  still the backstop, so an override can neither drop a word nor
                  leave the deck short
    personal_count
                  where the BUYER's own words end in ``personal_words`` — the
                  boundary 'personal-first' splits on. Normally None and measured
                  here, which is right when the caller hands over her raw list.
                  It is NOT right for an order with a frozen word bank: that
                  arrives as one flat list of 412 (hers, then filler), so the
                  measurement below would say "all 412 are hers" and the deck
                  would print blended with nothing to show it. The server knows
                  the real boundary and passes it.
    order         how the words are laid onto cards (see pack.ORDERS), chosen per
                  order by the owner: 'random' blends everything, 'personal-first'
                  opens the deck with HER words, 'by-script' keeps Hebrew cards and
                  Latin cards apart. Whichever is picked, the phrase balance is
                  unchanged — it applies inside every group.
    gender        the honoree's gender ('male' / 'female' / None), which resolves
                  the title's {feminine|masculine} markers — Hebrew is gendered,
                  so "{NAME} {בת|בן} {AGE}" prints בת for a girl and בן for a
                  boy. None takes the FIRST (feminine) form; a title carrying no
                  marker renders exactly as it always did.
    """
    cfg = config.theme(theme_key)
    config.ensure_calibrated(cfg)  # fail fast on an uncalibrated theme

    # A private scratch dir for the intermediate CSV + per-page PNGs.
    own_workdir = workdir is None
    if own_workdir:
        workdir = tempfile.mkdtemp(prefix="dugri-order-")
    os.makedirs(workdir, exist_ok=True)

    own_out = out_pdf is None
    if own_out:
        fd, out_pdf = tempfile.mkstemp(prefix="dugri-order-", suffix=".pdf")
        os.close(fd)

    try:
        # 1) Top up the personal words to a full deck.
        words = topup(personal_words, theme_key, wordlist=wordlist)
        # Where her own words end and the filler begins — the boundary the
        # 'personal-first' order splits on. It is a count because the deck is one
        # flat list; nothing marks a word as filler.
        #
        # An explicit count from the caller WINS. Measuring works only when what
        # we were handed is her raw list; a frozen word bank is her words with the
        # filler already behind them, and measuring that says "all of it".
        boundary = personal_count if personal_count else topupmod.personal_span(personal_words)

        # 2) Write the words to a temp file, then pack into the deck CSV (one row
        #    per card in v2, one row per 8-up sheet in v1). The front cycling is
        #    taken from the THEME's front count, not pack's default, so a template
        #    that ships other than eight fronts still gets an even spread.
        words_path = os.path.join(workdir, "words.txt")
        with open(words_path, "w", encoding="utf-8") as f:
            f.write("\n".join(words) + "\n")
        csv_path = os.path.join(workdir, "order.csv")
        # HOW HARD each entry is to print, measured against this template's own
        # slot and font (word_demand). The packer uses it to put the demanding
        # entries TOGETHER — one small card instead of four — and it is what
        # names the entries that would make a card small whatever we did.
        sizes = word_demand.measure(words, theme_key, word_font=word_font)
        if config.is_single_card(cfg):
            pack.pack(words, csv_path, fronts=len(config.fronts(cfg)),
                      order=order, personal_count=boundary, sizes=sizes)
        else:
            pack.pack(words, csv_path, order=order, personal_count=boundary,
                      sizes=sizes)
        # The cards that will print noticeably smaller than the rest, with the
        # entry responsible for each. Printed on its own line for the server to
        # pick up, the same way the board path is.
        small = word_demand.small_cards(
            [c["words"] for c in pack.load_cards(csv_path) if c["kind"] == "word"], sizes
        )
        if small:
            print("smallcards " + json.dumps(small, ensure_ascii=False))

        # 3) Render. A v2 (single-card) template produces TWO artifacts — the
        #    208-page card deck and a separate board file; a v1 template still
        #    produces the one combined PDF with the board as its last page, so
        #    the un-migrated themes keep working. board is None for v1.
        if config.is_single_card(cfg):
            return buildmod.build_deck(
                theme_key, csv_path, name, out_pdf,
                extra_fields=extra_fields or {}, word_font=word_font,
                workdir=os.path.join(workdir, "build"), progress=progress,
                chasers=chasers, custom_title=custom_title, photos=photos,
                press_icc=press_icc, press_bleed=press_bleed,
                press_cmyk=press_cmyk, gender=gender,
            )

        fronts = config.clean_path(theme_key, "fronts")
        board = config.board_clean_path(theme_key, chasers=chasers)
        backs_path = config.clean_path(theme_key, "backs")
        backs = backs_path if os.path.exists(backs_path) else None

        pdf, pages = buildmod.build_pdf(
            theme_key, fronts, board, csv_path, name, out_pdf,
            backs=backs, extra_fields=extra_fields or {}, word_font=word_font,
            workdir=os.path.join(workdir, "build"), progress=progress,
            chasers=chasers, custom_title=custom_title, gender=gender,
        )
        return pdf, pages, None
    except BaseException:
        # On failure, drop a half-written PDF we created (a partial file is
        # useless). A caller-supplied out_pdf is left untouched.
        if own_out:
            try:
                os.remove(out_pdf)
            except OSError:
                pass
        raise
    finally:
        # The scratch dir (intermediate CSV + per-page PNGs) is never part of the
        # result — remove it when we created it, on both success and failure, so a
        # failed render can't leak a temp dir. The finished out_pdf is separate.
        if own_workdir:
            shutil.rmtree(workdir, ignore_errors=True)


def _parse_fields(pairs):
    """Parse ['AGE=30', 'NAME1=Michal'] into {'AGE': '30', 'NAME1': 'Michal'}."""
    out = {}
    for p in pairs or []:
        if "=" not in p:
            sys.exit(f"bad --field {p!r}; expected KEY=VALUE")
        k, v = p.split("=", 1)
        out[k.strip()] = v
    return out


def main():
    ap = argparse.ArgumentParser(description="Render an order to a print-ready PDF")
    ap.add_argument("theme")
    ap.add_argument("name")
    ap.add_argument("words", help="path to the personal words (one per line)")
    ap.add_argument("out_pdf")
    ap.add_argument("--word-font", default=None)
    ap.add_argument("--field", action="append", default=[], metavar="KEY=VALUE")
    ap.add_argument("--chasers", action="store_true",
                    help="use the theme's chasers board variant when available")
    # The two press modes. Mutually exclusive because they are alternatives, not
    # a switch and its option — and because "--press <icc> --press-passthrough"
    # would read as "separate against this profile, but don't", which has no
    # honest meaning.
    press_mode = ap.add_mutually_exclusive_group()
    press_mode.add_argument("--press", metavar="ICC", default=None,
                            help="build the PRINT SHOP copy instead: CMYK against this "
                                 "ICC profile, transparency flattened, text outlined, "
                                 "and the sheet grown to carry bleed + crop marks")
    press_mode.add_argument("--press-passthrough", action="store_true",
                            help="build the PRINT SHOP copy WITHOUT the colour pass: "
                                 "the sheet still grows to carry bleed + crop marks and "
                                 "still gets its TrimBox, but the deck is handed over in "
                                 "Chrome's RGB for the shop to separate itself. No "
                                 "Ghostscript, so seconds instead of minutes")
    ap.add_argument("--bleed", type=float, default=None, metavar="MM",
                    help="bleed depth in mm for --press (default: the agreed 3)")
    ap.add_argument("--title", default=None,
                    help="optional custom title overriding the theme-derived title")
    ap.add_argument("--wordlist", default=None, metavar="NAME",
                    help="seed pool that tops this deck up, replacing the "
                         "theme's own (personal words and generic-350 are "
                         "unaffected)")
    ap.add_argument("--gender", default=None, choices=["male", "female"],
                    help="the honoree's gender, resolving the title's "
                         "{feminine|masculine} markers (e.g. {בת|בן}). Omitted "
                         "takes the first (feminine) form")
    ap.add_argument("--order", default=pack.ORDER_RANDOM, choices=list(pack.ORDERS),
                    help="how the words are laid onto cards: random blends them, "
                         "personal-first opens with the buyer's own words, by-script "
                         "keeps Hebrew and Latin cards apart")
    ap.add_argument("--personal-count", type=int, default=None, metavar="N",
                    help="how many of the leading words are the buyer's own — the "
                         "boundary --order=personal-first splits on. Pass it when "
                         "the word list is a frozen bank (hers + filler already "
                         "joined); omit it when the list IS her own words")
    ap.add_argument("--photo", action="append", default=[], metavar="PATH",
                    help="a customer pawn photo for the photo card (repeatable, up to 4)")
    args = ap.parse_args()

    personal = open(args.words, encoding="utf-8-sig").read().splitlines()
    pdf, pages, board = order_to_pdf(
        args.theme, args.name, _parse_fields(args.field), personal,
        out_pdf=args.out_pdf, word_font=args.word_font, progress=True,
        chasers=args.chasers, custom_title=args.title, photos=args.photo,
        press_icc=args.press, press_bleed=args.bleed,
        press_cmyk=not args.press_passthrough, gender=args.gender,
        wordlist=args.wordlist, order=args.order,
        personal_count=args.personal_count,
    )
    print(f"\nwrote {pdf} ({pages} pages)")
    # Printed on its own line so the server can pick the board artifact out of
    # stdout the same way it already picks up the page count.
    if board:
        print(f"board {board}")


if __name__ == "__main__":
    main()
