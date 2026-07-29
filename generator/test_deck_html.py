#!/usr/bin/env python3
"""Tests for generator/deck_html.py — the one-document deck assembler.

A v2 deck is 208 pages built as ONE HTML document and printed by ONE Chrome
pass. Three properties make that safe, and all three are easy to break silently:

  1. ID NAMESPACING — the nine card SVGs are near-identical Canva exports that
     reuse clip-path ids. Dropped into one document unprefixed, they clip each
     other's artwork and cards render wrong (not blank, just subtly wrong, which
     is worse: it prints).
  2. PAYLOAD DEDUPE — each front embeds the same multi-MB background. Emitted
     once and referenced, a deck is ~9 MB; emitted per page it would be ~1 GB.
  3. PAGINATION — one card per page, and NO trailing blank page.

Run: python3 generator/test_deck_html.py   (or via pytest)
"""
import base64
import re

import deck_html as dh

# A payload big enough to clear BG_MIN_CHARS, so it is treated as the shared
# background rather than a small decorative image.
BIG = base64.b64encode(b"x" * (dh.BG_MIN_CHARS)).decode("ascii")
SMALL = base64.b64encode(b"y" * 64).decode("ascii")


def card_svg(clip_id="c1", payload=BIG, extra=""):
    """A stand-in for a Canva card export: a viewBox, a clip id, a big <image>."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" width="299" height="416" '
        'viewBox="0 0 223.92 312">'
        f'<defs><clipPath id="{clip_id}"><rect width="10" height="10"/></clipPath></defs>'
        f'<g clip-path="url(#{clip_id})">'
        f'<image x="0" y="0" width="2459" height="1844" '
        f'xlink:href="data:image/png;base64,{payload}"/>'
        f"</g>{extra}</svg>"
    )


# --- viewBox ----------------------------------------------------------------

def test_view_box_is_parsed_as_floats():
    assert dh.view_box(card_svg()) == [0.0, 0.0, 223.92, 312.0]


def test_view_box_rejects_a_card_with_no_viewbox():
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>'
    try:
        dh.view_box(svg)
    except ValueError:
        return
    raise AssertionError("a card with no viewBox must raise, not place text blind")


# --- 1. id namespacing ------------------------------------------------------

def test_namespace_ids_rewrites_definitions_and_references():
    out = dh.namespace_ids('<clipPath id="a"/><g clip-path="url(#a)"><use href="#a"/></g>', "d0_")
    assert 'id="d0_a"' in out
    assert "url(#d0_a)" in out
    assert 'href="#d0_a"' in out


def test_namespace_ids_leaves_external_references_alone():
    # A reference to something NOT defined in this fragment (the shared
    # background) must keep pointing outside it.
    out = dh.namespace_ids('<use xlink:href="#dugriSharedBg"/><g id="a"/>', "d0_")
    assert 'xlink:href="#dugriSharedBg"' in out
    assert 'id="d0_a"' in out


def test_two_cards_sharing_a_clip_id_do_not_collide():
    doc = dh.DeckDocument(223.92, 312)
    doc.add_design("front2", card_svg(clip_id="dup"))
    doc.add_design("front3", card_svg(clip_id="dup"))
    html = doc.html("0 0 223.92 312")
    ids = re.findall(r'<clipPath id="([^"]+)"', html)
    assert len(ids) == 2, "each design must keep its own clipPath"
    assert len(set(ids)) == 2, f"clip ids collided across designs: {ids}"


# --- 2. shared background ---------------------------------------------------

def test_background_is_emitted_once_and_referenced_by_every_card():
    doc = dh.DeckDocument(223.92, 312)
    for i in (2, 3, 4):
        doc.add_design(f"front{i}", card_svg(clip_id=f"c{i}"))
    for i in (2, 3, 4):
        doc.add_page(f"front{i}")
    html = doc.html("0 0 223.92 312")
    assert html.count(BIG) == 1, "the shared background must appear exactly once"
    assert html.count(f'#{dh.SHARED_BG_ID}"') == 3, "every card must reference it"
    assert f'id="{dh.SHARED_BG_ID}"' in html


def test_a_small_image_is_left_where_it_is():
    # Only the full-bleed background is worth hoisting; a small decorative image
    # costs more in indirection than it saves.
    markup, payload = dh.split_background(f'<image xlink:href="data:image/png;base64,{SMALL}"/>')
    assert payload is None
    assert SMALL in markup


def test_artwork_is_defined_once_however_many_pages_use_it():
    doc = dh.DeckDocument(223.92, 312)
    doc.add_design("front2", card_svg())
    for _ in range(50):
        doc.add_page("front2")
    html = doc.html("0 0 223.92 312")
    # 50 pages, but one <g id="card_front2"> definition.
    assert html.count('<g id="card_front2">') == 1
    assert html.count('xlink:href="#card_front2"') == 50


def test_registering_the_same_design_twice_is_a_no_op():
    doc = dh.DeckDocument(223.92, 312)
    doc.add_design("front2", card_svg())
    doc.add_design("front2", card_svg(clip_id="other"))
    assert doc.html("0 0 223.92 312").count('<g id="card_front2">') == 1


def test_a_page_for_an_unregistered_design_raises():
    doc = dh.DeckDocument(223.92, 312)
    try:
        doc.add_page("nope")
    except KeyError:
        return
    raise AssertionError("an unregistered design must raise, not print a blank page")


# --- 3. pagination ----------------------------------------------------------

def test_page_count_and_card_boxes():
    doc = dh.DeckDocument(223.92, 312)
    doc.add_design("back", card_svg())
    for _ in range(208):
        doc.add_page("back")
    html = doc.html("0 0 223.92 312")
    assert doc.page_count == 208
    assert html.count('<div class="card">') == 208


def test_page_size_is_the_card_size_in_points():
    # The PDF page must be the card's PHYSICAL size so "print at 100%" is honest.
    html = dh.DeckDocument(223.92, 312).html("0 0 223.92 312")
    assert "@page{size:223.92pt 312pt;margin:0}" in html


def test_the_last_card_does_not_force_a_trailing_blank_page():
    html = dh.DeckDocument(223.92, 312).html("0 0 223.92 312")
    assert ".card:last-child{break-after:auto;page-break-after:auto}" in html


def test_overlay_is_painted_after_the_artwork():
    # The text overlay must come AFTER the <use> of the design, or the artwork
    # paints over the customer's words.
    doc = dh.DeckDocument(223.92, 312)
    doc.add_design("front2", card_svg())
    doc.add_page("front2", "<text>WORD</text>")
    html = doc.html("0 0 223.92 312")
    assert html.index('xlink:href="#card_front2"') < html.index("<text>WORD</text>")


# --- fonts / images ---------------------------------------------------------

def test_font_face_embeds_the_file_as_base64(tmp_path=None):
    import os
    import tempfile
    d = tmp_path or tempfile.mkdtemp()
    path = os.path.join(str(d), "F.ttf")
    with open(path, "wb") as f:
        f.write(b"FONTDATA")
    css = dh.font_face("TitleFont", path)
    assert "font-family:'TitleFont'" in css
    assert base64.b64encode(b"FONTDATA").decode() in css


def test_image_data_url_maps_jpg_to_the_jpeg_media_type(tmp_path=None):
    import os
    import tempfile
    d = tmp_path or tempfile.mkdtemp()
    path = os.path.join(str(d), "p.jpg")
    with open(path, "wb") as f:
        f.write(b"JPEGDATA")
    assert dh.image_data_url(path).startswith("data:image/jpeg;base64,")


def test_styles_are_declared_once_for_the_whole_deck():
    # v1 re-embedded every @font-face into every page; at 208 pages the fonts
    # would dwarf the artwork.
    doc = dh.DeckDocument(223.92, 312)
    doc.add_style("@font-face{font-family:'X';src:url(data:font/ttf;base64,AAAA)}")
    doc.add_design("back", card_svg())
    for _ in range(20):
        doc.add_page("back")
    assert doc.html("0 0 223.92 312").count("base64,AAAA") == 1


if __name__ == "__main__":
    import tempfile

    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        if "tmp_path" in fn.__code__.co_varnames[:fn.__code__.co_argcount]:
            fn(tempfile.mkdtemp())
        else:
            fn()
    print(f"all {len(fns)} tests passed")


# --- a photo slot must never be hoisted into shared defs ---------------------
# Hoisting replaces the <image> with a <use>, which strips its id — and the photo
# card's sticker halo is bound to id="photo-slot-N", so the halo would be
# orphaned and the customer's photo would lose the artwork built around it.

def test_a_photo_slot_is_never_hoisted_however_large():
    slot = (f'<image id="photo-slot-1" x="0" y="0" width="66" height="66" '
            f'xlink:href="data:image/png;base64,{BIG}"/>')
    markup, payload = dh.split_background(slot)
    assert payload is None, "a photo slot must not become a shared def"
    assert 'id="photo-slot-1"' in markup, "the slot must keep its id"
    assert "<use" not in markup


def test_the_background_is_still_hoisted_when_a_photo_slot_is_present():
    both = (f'<image x="0" y="0" width="2459" height="1844" '
            f'xlink:href="data:image/png;base64,{BIG}"/>'
            f'<image id="photo-slot-2" xlink:href="data:image/png;base64,{BIG}"/>')
    markup, payload = dh.split_background(both)
    assert payload is not None, "the shared background must still be hoisted"
    assert 'id="photo-slot-2"' in markup
