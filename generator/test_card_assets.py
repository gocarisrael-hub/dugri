#!/usr/bin/env python3
"""Tests for generator/card_assets.py image de-duplication.

Run: python3 generator/test_card_assets.py   (or via pytest)
"""
import base64
import contextlib
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import card_assets  # noqa: E402

# A 1x1 PNG and a different 1x1 GIF, as raw bytes.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmM"
    "IQAAAABJRU5ErkJggg==")
GIF = base64.b64decode("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7")


@contextlib.contextmanager
def tmpdir():
    path = tempfile.mkdtemp(prefix="card-assets-")
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def _svg(*payloads):
    body = "".join(
        '<image xlink:href="data:image/%s;base64,%s" width="10" height="10"/>'
        % (mime, base64.b64encode(raw).decode())
        for mime, raw in payloads)
    return '<svg xmlns="http://www.w3.org/2000/svg">%s</svg>' % body


def test_extract_writes_one_file_and_rewrites_href():
    with tmpdir() as tmp:
        assets = os.path.join(tmp, "assets")
        new, written = card_assets.extract(_svg(("png", PNG)), assets)

        name = list(written)[0]
        assert new.count('href="../assets/%s"' % name) == 1
        assert "base64" not in new
        with open(os.path.join(assets, name), "rb") as f:
            assert f.read() == PNG


def test_identical_images_collapse_to_a_single_file():
    """The whole point: 8 fronts embedding the same PNG must yield ONE file."""
    with tmpdir() as tmp:
        assets = os.path.join(tmp, "assets")
        for _ in range(8):
            card_assets.extract(_svg(("png", PNG)), assets)

        assert len(os.listdir(assets)) == 1


def test_distinct_images_stay_distinct():
    with tmpdir() as tmp:
        assets = os.path.join(tmp, "assets")
        card_assets.extract(_svg(("png", PNG), ("gif", GIF)), assets)

        assert len(os.listdir(assets)) == 2


def test_bare_href_is_extracted_too():
    """Not every SVG uses the xlink: prefix; a missed one stays 5 MB fat."""
    with tmpdir() as tmp:
        svg = ('<svg><image href="data:image/png;base64,%s"/></svg>'
               % base64.b64encode(PNG).decode())
        new, written = card_assets.extract(svg, os.path.join(tmp, "assets"))

        assert len(written) == 1
        assert "base64" not in new


def test_absolutize_makes_the_reference_survive_a_move():
    """render() writes the composed SVG elsewhere; a relative href would break."""
    with tmpdir() as tmp:
        assets = os.path.join(tmp, "assets")
        new, written = card_assets.extract(_svg(("png", PNG)), assets)
        name = list(written)[0]

        resolved = card_assets.absolutize(new, os.path.join(tmp, "clean"))

        expected = os.path.join(assets, name)
        assert 'href="%s"' % expected in resolved
        assert os.path.exists(expected)


def test_read_svg_leaves_unmigrated_artwork_untouched():
    """Templates not yet migrated must keep rendering exactly as before."""
    with tmpdir() as tmp:
        clean = os.path.join(tmp, "clean")
        os.makedirs(clean)
        original = _svg(("png", PNG))
        with open(os.path.join(clean, "2.svg"), "w", encoding="utf-8") as f:
            f.write(original)

        assert card_assets.read_svg(os.path.join(clean, "2.svg")) == original


def test_read_svg_resolves_a_migrated_file():
    with tmpdir() as tmp:
        clean = os.path.join(tmp, "clean")
        os.makedirs(clean)
        card = os.path.join(clean, "2.svg")
        with open(card, "w", encoding="utf-8") as f:
            f.write(_svg(("png", PNG)))
        card_assets.migrate_file(card, card, os.path.join(tmp, "assets"))

        text = card_assets.read_svg(card)

        assert "../assets/" not in text
        assert os.path.join(tmp, "assets") in text


def test_migrate_template_collapses_every_copy():
    with tmpdir() as tmp:
        src = os.path.join(tmp, "src")
        for sub in ("clean", "filled"):
            os.makedirs(os.path.join(src, sub))
            for i in (1, 2, 3):
                with open(os.path.join(src, sub, "%d.svg" % i), "w",
                          encoding="utf-8") as f:
                    f.write(_svg(("png", PNG)))

        out = os.path.join(tmp, "out")
        stats = card_assets.migrate_template(src, out)

        assert stats["files"] == 6
        assert stats["svg_after"] < stats["svg_before"]
        # Six SVGs embedded the same PNG; exactly one copy survives.
        assert len(os.listdir(os.path.join(out, "assets"))) == 1


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
