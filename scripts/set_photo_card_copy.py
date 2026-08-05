#!/usr/bin/env python3
"""Re-set the photo card's static copy from the words written in the artwork.

The pawn ("photo") cards carry their static copy as OUTLINED PATHS, not as
``<text>`` — deliberately: ``docs/photo-card.md`` makes "the card needs no
``@font-face`` injection" a contract, and both the deck path
(``generator/build.py``) and the single-card preview path
(``render_page.build_single_card_svg``) rely on it. Live text would mean
shipping a display font into the production image and embedding a third face in
every deck HTML, to render two lines that change about once a year.

The cost of outlines is that the words are not editable by hand. This script is
the answer: every copy path carries the sentence it draws in ``data-copy``,
plus how it is set, so **the SVG holds the words in plain text** and this
regenerates the outlines from them.

    <path data-copy="גזרו אותם לפי הקווים"
          data-font="site/assets/fonts/heebo-300-hebrew.*.woff2"
          data-size="7" data-track="0.3" data-baseline="70" data-cx="111.96"
          d="…" fill="#111111" fill-opacity="0.6"/>

To change a line: edit ``data-copy`` in the SVG, run this, commit. To check
nothing drifted: run it with ``--check``, which is what CI-adjacent callers want
— it rewrites nothing and exits non-zero if any ``d`` disagrees with its words.

Hebrew is laid out right-to-left by advance width with no shaping, which is all
these two lines need: no ligatures, no marks, no bidi runs. ``data-track`` is
extra letter-spacing in user units (the shipped cards were authored with some).
``data-cx`` centres the ADVANCE width, matching how the original was set.

Needs ``fonttools`` — a DEV dependency (``generator/requirements-dev.txt``); the
production image never runs this, it only prints the ``d`` this leaves behind.

    python3 scripts/set_photo_card_copy.py [--check] [FILE ...]
"""
import argparse
import glob
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# The photo cards that ship in the repo. An owner template's own photo.svg lives
# on the DATA_DIR volume and is not ours to rewrite.
DEFAULT_FILES = [
    "resources/canva/templates/_shared/photo-card/photo.svg",
    "resources/canva/templates/grapefruit/clean/photo.svg",
]

_COPY_PATH = re.compile(r"<path\b[^>]*\bdata-copy=\"([^\"]*)\"[^>]*/>")
_ATTR = re.compile(r"\b(data-[a-z]+)=\"([^\"]*)\"")
_D_ATTR = re.compile(r"\bd=\"[^\"]*\"")


def _font_file(pattern):
    """Resolve ``data-font`` — a repo-relative path, possibly a glob.

    A glob so a card can name a self-hosted web font whose filename carries a
    content hash (``heebo-300-hebrew.f1f7cfae.woff2``): the hash changes when the
    site re-fetches its fonts, and a frozen path would then silently resolve to
    nothing. Ambiguity is an error rather than a coin toss.
    """
    hits = sorted(glob.glob(os.path.join(REPO, pattern)))
    if not hits:
        raise SystemExit(f"no font matches {pattern!r} under {REPO}")
    if len(hits) > 1:
        raise SystemExit(f"{pattern!r} matches {len(hits)} files: {hits}")
    return hits[0]


def outline(text, font_path, size, cx, baseline, tracking=0.0):
    """``text`` set right-to-left in ``font_path`` as one SVG path's ``d``."""
    from fontTools.misc.transform import Transform
    from fontTools.pens.svgPathPen import SVGPathPen
    from fontTools.pens.transformPen import TransformPen
    from fontTools.ttLib import TTFont

    font = TTFont(font_path)
    upem = font["head"].unitsPerEm
    glyphs = font.getGlyphSet()
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]

    run = []
    for ch in text:
        name = cmap.get(ord(ch))
        if name is None and ch == " ":
            name = "space" if "space" in hmtx.metrics else None
        if name is None:
            raise SystemExit(
                f"{os.path.basename(font_path)} has no glyph for {ch!r} "
                f"(U+{ord(ch):04X}) — the card's copy cannot be set in it."
            )
        run.append([name if ch != " " else None, hmtx[name][0] * size / upem])
    # Tracking is space BETWEEN glyphs, so the last one gets none. Adding it to
    # every advance would widen the run by one extra step and, since the run is
    # centred, shift the whole line half a step off centre.
    for pair in run[:-1]:
        pair[1] += tracking

    width = sum(adv for _, adv in run)
    pen_x = cx - width / 2.0 + width          # RTL: first character is rightmost
    parts = []
    for name, adv in run:
        pen_x -= adv
        if name is None:
            continue
        spen = SVGPathPen(glyphs, ntos=lambda v: repr(round(v, 4)))
        glyphs[name].draw(TransformPen(
            spen, Transform(size / upem, 0, 0, -size / upem, pen_x, baseline)))
        d = spen.getCommands()
        if d:
            parts.append(d)
    return " ".join(parts)


def reset_copy(markup):
    """Every ``data-copy`` path in ``markup``, its ``d`` re-set from its words."""
    def one(m):
        el = m.group(0)
        attrs = dict(_ATTR.findall(el))
        missing = {"data-copy", "data-font", "data-size", "data-baseline",
                   "data-cx"} - set(attrs)
        if missing:
            raise SystemExit(f"copy path is missing {sorted(missing)}: {el[:120]}")
        d = outline(attrs["data-copy"], _font_file(attrs["data-font"]),
                    float(attrs["data-size"]), float(attrs["data-cx"]),
                    float(attrs["data-baseline"]), float(attrs.get("data-track", 0)))
        if _D_ATTR.search(el):
            return _D_ATTR.sub(lambda _: f'd="{d}"', el, count=1)
        return el.replace("<path", f'<path d="{d}"', 1)

    return _COPY_PATH.sub(one, markup)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("files", nargs="*", default=None, metavar="FILE")
    ap.add_argument("--check", action="store_true",
                    help="rewrite nothing; exit non-zero if any outline is stale")
    args = ap.parse_args(argv)

    files = args.files or DEFAULT_FILES
    stale = []
    for rel in files:
        path = rel if os.path.isabs(rel) else os.path.join(REPO, rel)
        with open(path, encoding="utf-8") as f:
            before = f.read()
        after = reset_copy(before)
        n = len(_COPY_PATH.findall(before))
        if after == before:
            print(f"ok       {rel} ({n} copy path(s))")
            continue
        if args.check:
            stale.append(rel)
            print(f"STALE    {rel} — its outlines do not match its data-copy")
            continue
        with open(path, "w", encoding="utf-8") as f:
            f.write(after)
        print(f"rewrote  {rel} ({n} copy path(s))")
    if stale:
        print("\nRun scripts/set_photo_card_copy.py to regenerate.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
