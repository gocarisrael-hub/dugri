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
import os
import shutil
import sys
import tempfile

import config
import pack
import build as buildmod
from topup import topup


def order_to_pdf(theme_key, name, extra_fields, personal_words, out_pdf=None,
                 word_font=None, workdir=None, progress=False, chasers=False):
    """Render an order to a PDF and return (out_pdf, page_count).

    theme_key     a key in generator/themes.json (e.g. "trip comeback")
    name          the honoree name (cased per the theme's name_form)
    extra_fields  dict feeding the theme title template (AGE/YEARS/NAME1/...)
    personal_words the customer's own words (all are always included)
    out_pdf       output path; a temp file is used when omitted
    word_font     optional card-font filename override (in the theme fonts dir)
    chasers       when True, use the theme's chasers board variant if it ships one
                  (clean/board-chasers.svg), else the normal board (additive)
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
        words = topup(personal_words, theme_key)

        # 2) Write the words to a temp file, then pack into the 32-col Canva CSV.
        words_path = os.path.join(workdir, "words.txt")
        with open(words_path, "w", encoding="utf-8") as f:
            f.write("\n".join(words) + "\n")
        csv_path = os.path.join(workdir, "order.csv")
        pack.pack(words, csv_path)

        # 3) Render the full PDF onto the theme's clean backgrounds.
        fronts = config.clean_path(theme_key, "fronts")
        board = config.board_clean_path(theme_key, chasers=chasers)
        backs_path = config.clean_path(theme_key, "backs")
        backs = backs_path if os.path.exists(backs_path) else None

        return buildmod.build_pdf(
            theme_key, fronts, board, csv_path, name, out_pdf,
            backs=backs, extra_fields=extra_fields or {}, word_font=word_font,
            workdir=os.path.join(workdir, "build"), progress=progress,
            chasers=chasers,
        )
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
    args = ap.parse_args()

    personal = open(args.words, encoding="utf-8-sig").read().splitlines()
    pdf, pages = order_to_pdf(
        args.theme, args.name, _parse_fields(args.field), personal,
        out_pdf=args.out_pdf, word_font=args.word_font, progress=True,
        chasers=args.chasers,
    )
    print(f"\nwrote {pdf} ({pages} pages)")


if __name__ == "__main__":
    main()
