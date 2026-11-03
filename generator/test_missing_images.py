#!/usr/bin/env python3
"""A render must never bake a missing image in silently.

The grapefruit board went out on the shop with Chrome's broken-image icon on
every logo square, and a stretched broken-image icon as its background: the
board is de-duplicated (its images live in ``<template>/assets/`` and the SVG
names them ``../assets/<sha>.png``), ``build.render_board`` read it with a plain
``open()`` and wrote it to the work dir, where those references point at
nothing. Chrome exits 0 on a missing image, so nothing failed.

Two fixes, two kinds of test: the board/backs reads go through
``card_assets.read_svg`` (the render now resolves), and ``chrome`` refuses any
source that names an image file that is not on disk (the next such mistake
fails loudly instead of printing an icon).
"""
import base64
import os
import struct
import subprocess
import zlib

import pytest

import build
import card_assets
import chrome
import config
import render_page as rp


def _png(rgb, size=8):
    """A tiny solid-colour PNG, built by hand so the test needs no Pillow write."""
    raw = b"".join(b"\x00" + bytes(rgb) * size for _ in range(size))

    def chunk(kind, data):
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


RED = (230, 20, 20)
BOARD = ('<svg xmlns="http://www.w3.org/2000/svg" '
         'xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="100" '
         'viewBox="0 0 100 100"><image x="0" y="0" width="100" height="100" '
         'preserveAspectRatio="none" xlink:href="../assets/{name}"/></svg>')


def _dedup_template(tmp_path):
    """A template laid out exactly like the migrated grapefruit: clean/board.svg
    naming a red PNG in the sibling assets/ dir."""
    name = "0123456789abcdef.png"
    (tmp_path / "assets").mkdir()
    (tmp_path / "assets" / name).write_bytes(_png(RED))
    (tmp_path / "clean").mkdir()
    board = tmp_path / "clean" / "board.svg"
    board.write_text(BOARD.format(name=name), encoding="utf-8")
    return str(board), name


@pytest.fixture
def plain_board_cfg(monkeypatch):
    """A theme with no board title, so render_board hands the clean board on as-is."""
    cfg = {"slug": "synthetic", "calibrated": True, "language": "hebrew",
           "title_style": {"fill": "#000", "outline": "#000", "outline_w": 0,
                           "arch": 0, "shadow": False}}
    monkeypatch.setattr(config, "theme", lambda name: cfg)
    monkeypatch.setattr(config, "ensure_calibrated", lambda c: None)
    return cfg


# ---- the checker ------------------------------------------------------------

def test_unresolved_images_names_only_local_files_that_are_absent(tmp_path):
    (tmp_path / "here.png").write_bytes(_png(RED))
    here = str(tmp_path / "here.png")
    svg = "".join([
        '<svg>',
        '<image xlink:href="data:image/png;base64,AAAA"/>',     # inline: fine
        '<image href="here.png"/>',                             # relative, present
        f'<image href="{here}"/>',                              # absolute, present
        f'<image href="file://{here}"/>',                       # file URL, present
        '<image href="https://example.com/x.png"/>',            # network: unchecked
        '<image xlink:href="../assets/gone.png"/>',             # relative, absent
        '<image xlink:href="../assets/gone.png"/>',             # reported once
        '<image href="/nowhere/at/all.png"/>',                  # absolute, absent
        '<img src="also-gone.png">',                            # HTML img, absent
        '<script>x = `<image href="${esc(href)}">`;</script>',  # code, not markup
        '</svg>',
    ])
    assert card_assets.unresolved_images(svg, str(tmp_path)) == [
        "../assets/gone.png", "/nowhere/at/all.png", "also-gone.png"]


def test_read_svg_output_has_nothing_unresolved_wherever_it_is_written(tmp_path):
    board, _ = _dedup_template(tmp_path)
    elsewhere = tmp_path / "jobs" / "work"  # where ../assets/ is NOT the template's
    elsewhere.mkdir(parents=True)
    raw = open(board, encoding="utf-8").read()
    # The bug, stated as data: the raw text written to a work dir is broken there...
    assert card_assets.unresolved_images(raw, str(elsewhere)) == [
        "../assets/0123456789abcdef.png"]
    # ...and read_svg's is not.
    assert card_assets.unresolved_images(card_assets.read_svg(board), str(elsewhere)) == []


# ---- the guard in front of Chrome ------------------------------------------

def test_chrome_refuses_a_source_with_a_missing_image_and_never_starts(tmp_path,
                                                                       monkeypatch, capsys):
    src = tmp_path / "board.svg"
    src.write_text(BOARD.format(name="missing.png"), encoding="utf-8")

    def no_chrome(*a, **k):
        raise AssertionError("Chrome must not be started for a source with a missing image")

    monkeypatch.setattr(subprocess, "run", no_chrome)
    with pytest.raises(chrome.MissingImage) as exc:
        chrome.screenshot(str(src), str(tmp_path / "out.png"), 100, 100, what="the board")
    assert "../assets/missing.png" in str(exc.value)
    assert "the board" in str(exc.value)
    # Named on stderr too, which is what the server's generator log keeps.
    assert "MISSING IMAGE" in capsys.readouterr().err
    # print_pdf goes through the same gate.
    with pytest.raises(chrome.MissingImage):
        chrome.print_pdf(str(src), str(tmp_path / "out.pdf"))
    # and a file:// source is read as the path it names.
    with pytest.raises(chrome.MissingImage):
        chrome.screenshot("file://" + str(src), str(tmp_path / "o.png"), 100, 100)


def test_chrome_gate_lets_a_resolvable_source_through(tmp_path, monkeypatch):
    board, _ = _dedup_template(tmp_path)  # relative ref, resolvable IN PLACE
    started = []

    def fake_run(argv, **kw):
        started.append(argv)
        out = next(a for a in argv if a.startswith("--screenshot="))
        open(out.split("=", 1)[1], "wb").close()
        return subprocess.CompletedProcess(argv, 0, "", "")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(chrome, "MAX_CONCURRENT", 0)
    chrome.screenshot(board, str(tmp_path / "out.png"), 100, 100, font_wait=False)
    assert started and started[-1][-1] == board


def test_emergency_switch_logs_but_renders(tmp_path, monkeypatch, capsys):
    src = tmp_path / "board.svg"
    src.write_text(BOARD.format(name="missing.png"), encoding="utf-8")
    monkeypatch.setattr(chrome, "ALLOW_MISSING_IMAGES", True)
    chrome.check_images(str(src), "the board")  # no raise
    assert "missing.png" in capsys.readouterr().err


# ---- the board itself -------------------------------------------------------

def test_render_board_hands_chrome_a_board_whose_images_resolve(tmp_path, monkeypatch,
                                                               plain_board_cfg):
    board, name = _dedup_template(tmp_path)
    work = tmp_path / "jobs" / "work"
    work.mkdir(parents=True)
    seen = {}

    def fake_screenshot(source, out_png, w, h, **kw):
        seen["text"] = open(source, encoding="utf-8").read()
        seen["dir"] = os.path.dirname(source)
        chrome.check_images(source, "the board")  # the real gate, minus Chrome
        return out_png

    monkeypatch.setattr(chrome, "screenshot", fake_screenshot)
    build.render_board("synthetic", board, ["x"], str(work / "board.png"))
    assert seen["dir"] == str(work)
    assert card_assets.unresolved_images(seen["text"], seen["dir"]) == []
    assert os.path.join(str(tmp_path), "assets", name) in seen["text"]


def test_render_backs_resolves_its_images_too(tmp_path, monkeypatch, plain_board_cfg):
    board, _ = _dedup_template(tmp_path)  # same shape stands in for a backs sheet
    work = tmp_path / "jobs" / "work"
    work.mkdir(parents=True)
    texts = []
    monkeypatch.setattr(chrome, "screenshot",
                        lambda source, out_png, w, h, **kw: texts.append(
                            (open(source, encoding="utf-8").read(), os.path.dirname(source))))
    build.render_backs("synthetic", board, ["x"], str(work / "back.png"))
    assert texts and card_assets.unresolved_images(*texts[0]) == []


def test_board_renders_its_asset_pixels_not_a_broken_icon(tmp_path, monkeypatch,
                                                         plain_board_cfg):
    """End to end through real Chrome: the centre of the board is the asset's red."""
    if not os.path.exists(rp.CHROME):
        pytest.skip("no Chrome here")
    from PIL import Image

    board, _ = _dedup_template(tmp_path)
    work = tmp_path / "jobs" / "work"
    work.mkdir(parents=True)
    out = build.render_board("synthetic", board, ["x"], str(work / "board.png"), scale=1)
    px = Image.open(out).convert("RGB").getpixel((50, 50))
    assert all(abs(a - b) <= 8 for a, b in zip(px, RED)), px


def test_repo_grapefruit_board_resolves_through_read_svg(tmp_path):
    """The shipped grapefruit board is the de-duplicated one that broke; its
    images must all be on disk once read the way the render reads it."""
    board = os.path.join(config.REPO, "resources", "canva", "templates", "grapefruit",
                         "clean", "board.svg")
    if not os.path.exists(board):
        pytest.skip("grapefruit artwork not in this checkout")
    raw = open(board, encoding="utf-8").read()
    assert card_assets.image_refs(raw), "expected the board to reference shared images"
    assert card_assets.unresolved_images(card_assets.read_svg(board), str(tmp_path)) == []


def test_png_helper_is_a_real_png():
    # Guard the fixture itself: a malformed PNG would make the Chrome test pass
    # or fail for the wrong reason.
    data = _png(RED)
    assert data.startswith(b"\x89PNG")
    assert base64.b64encode(data)
