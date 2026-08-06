#!/usr/bin/env python3
"""Tests for generator/card_paper.py — the pawn card's paper follows the deck.

What these pin:

  * the paper is MEASURED off the rendered front card, not read out of the
    vector (grapefruit is the counter-example: its vector says #f4f1eb, the card
    a buyer holds is #fffdf1);
  * a front with no dominant colour — a photograph — yields NO measurement, and
    the pawn card then keeps the background it was drawn with rather than being
    repainted an arbitrary sampled pixel;
  * every failure (no Chrome, a broken render, unreadable artwork) degrades to
    "leave it alone", never to a broken or blank card;
  * repapering moves EVERY element in the card's own paper colour, which on
    grapefruit means the panel the pawns sit on and not only the hidden
    full-bleed base underneath the pattern;
  * the sticker halo stays white — its flood-color is not a fill and must not
    follow the paper.

Run: python3 -m pytest generator/test_card_paper.py
"""
import os
import re

import pytest

import card_paper
import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
GENERIC = os.path.join(REPO, "resources", "canva", "templates", "_shared",
                       "photo-card", "photo.svg")
GRAPEFRUIT = os.path.join(REPO, "resources", "canva", "templates", "grapefruit",
                          "clean", "photo.svg")

W, H = 223.92, 312.0


def _card(paper="#ffffff", extra=""):
    """A stand-in pawn card: a full-bleed rect and whatever else is asked for."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="223.92" height="312" '
        f'viewBox="0 0 {W} {H}">'
        f'<rect x="0" y="0" width="{W}" height="{H}" fill="{paper}"/>'
        f"{extra}</svg>"
    )


@pytest.fixture(autouse=True)
def _clear_cache():
    card_paper._cache.clear()
    yield
    card_paper._cache.clear()


def _fake_chrome(monkeypatch, colours):
    """Stub Chrome so it paints ``colours`` — [(rgb, count), ...] — into the PNG.

    Counts are pixel counts in a 100x100 image; whatever is left over is black.
    """
    from PIL import Image

    calls = []

    def screenshot(source, out_png, w, h, **kw):
        calls.append(source)
        im = Image.new("RGB", (100, 100), (0, 0, 0))
        px = im.load()
        i = 0
        for rgb, n in colours:
            for _ in range(n):
                px[i % 100, i // 100] = rgb
                i += 1
        im.save(out_png)
        return out_png

    monkeypatch.setattr(card_paper.chrome, "screenshot", screenshot)
    return calls


# --------------------------------------------------------------------------
# reading the paper off a rendered card
# --------------------------------------------------------------------------

def test_a_flat_front_reports_its_colour(tmp_path, monkeypatch):
    _fake_chrome(monkeypatch, [((244, 241, 235), 9000)])
    src = tmp_path / "front.svg"
    src.write_text(_card(), encoding="utf-8")
    assert card_paper.paper(str(src), workdir=str(tmp_path)) == "#f4f1eb"


def test_a_front_with_no_dominant_colour_reports_nothing(tmp_path, monkeypatch):
    """A photograph. The mode is then just the luckiest pixel, so refuse."""
    _fake_chrome(monkeypatch, [((i % 200, (i // 7) % 200, (i // 11) % 200), 1)
                               for i in range(10000)])
    src = tmp_path / "front.svg"
    src.write_text(_card(), encoding="utf-8")
    assert card_paper.paper(str(src), workdir=str(tmp_path)) is None


def test_the_floor_is_well_below_every_shipped_template():
    # Measured across the shipped templates the real answers sit at
    # 71.7%-92.8%. A floor anywhere near those would start refusing real cards.
    assert 0 < card_paper.PAPER_MIN_SHARE < 0.5


def test_a_chrome_failure_reports_nothing_rather_than_raising(tmp_path, monkeypatch,
                                                              capsys):
    def boom(*a, **kw):
        raise RuntimeError("no browser here")

    monkeypatch.setattr(card_paper.chrome, "screenshot", boom)
    src = tmp_path / "front.svg"
    src.write_text(_card(), encoding="utf-8")
    assert card_paper.paper(str(src), workdir=str(tmp_path)) is None
    # …and it SAYS why. A silent None reads exactly like "this front has no
    # paper", and the two want opposite responses.
    err = capsys.readouterr().err
    assert "could not render" in err and "no browser here" in err


def test_a_refusal_says_the_front_had_no_dominant_colour(tmp_path, monkeypatch,
                                                         capsys):
    _fake_chrome(monkeypatch, [((i % 200, (i // 7) % 200, (i // 11) % 200), 1)
                               for i in range(10000)])
    src = tmp_path / "front.svg"
    src.write_text(_card(), encoding="utf-8")
    assert card_paper.paper(str(src), workdir=str(tmp_path)) is None
    assert "no dominant colour" in capsys.readouterr().err


def test_a_missing_file_reports_nothing(tmp_path):
    assert card_paper.paper(str(tmp_path / "nope.svg")) is None


def test_the_same_artwork_is_only_rendered_once(tmp_path, monkeypatch):
    """Cached on CONTENT: one deck must not pay for the same card twice."""
    calls = _fake_chrome(monkeypatch, [((255, 255, 255), 9000)])
    a, b = tmp_path / "a.svg", tmp_path / "b.svg"
    a.write_text(_card(), encoding="utf-8")
    b.write_text(_card(), encoding="utf-8")       # same bytes, different path
    assert card_paper.paper(str(a), workdir=str(tmp_path)) == "#ffffff"
    assert card_paper.paper(str(b), workdir=str(tmp_path)) == "#ffffff"
    assert len(calls) == 1


def test_the_window_follows_the_svgs_own_size_not_its_viewbox(tmp_path, monkeypatch):
    """grapefruit's fronts are 299x416 over a 223.92x312 viewBox.

    Sizing the window from the viewBox crops three quarters of the card away and
    the mode then answers for a corner.
    """
    sizes = []

    def screenshot(source, out_png, w, h, **kw):
        from PIL import Image
        sizes.append((w, h))
        Image.new("RGB", (10, 10), (1, 2, 3)).save(out_png)
        return out_png

    monkeypatch.setattr(card_paper.chrome, "screenshot", screenshot)
    src = tmp_path / "front.svg"
    src.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="299" height="416" '
        'viewBox="0 0 223.92 312"><rect width="10" height="10"/></svg>',
        encoding="utf-8")
    card_paper.paper(str(src), workdir=str(tmp_path))
    assert sizes == [(299.0, 416.0)]


def test_a_viewbox_only_svg_still_measures(tmp_path, monkeypatch):
    sizes = []

    def screenshot(source, out_png, w, h, **kw):
        from PIL import Image
        sizes.append((w, h))
        Image.new("RGB", (10, 10), (9, 9, 9)).save(out_png)
        return out_png

    monkeypatch.setattr(card_paper.chrome, "screenshot", screenshot)
    src = tmp_path / "front.svg"
    # The child rect declares a width too: reading it instead of the root's
    # would size the window off a decoration.
    src.write_text('<svg xmlns="http://www.w3.org/2000/svg" '
                   'viewBox="0 0 100 200">'
                   '<rect x="0" y="0" width="7" height="9"/></svg>',
                   encoding="utf-8")
    assert card_paper.paper(str(src), workdir=str(tmp_path)) == "#090909"
    assert sizes == [(100.0, 200.0)]


# --------------------------------------------------------------------------
# reading a pawn card's OWN paper, from its markup
# --------------------------------------------------------------------------

def test_the_shipped_pawn_cards_declare_their_own_paper():
    with open(GENERIC, encoding="utf-8") as f:
        assert card_paper.own_paper(f.read()) == "#ffffff"
    with open(GRAPEFRUIT, encoding="utf-8") as f:
        assert card_paper.own_paper(f.read()) == "#fffdf1"


def test_a_card_with_no_full_bleed_rect_has_no_readable_paper():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 223.92 312">'
           '<rect x="10" y="10" width="50" height="50" fill="#123456"/></svg>')
    assert card_paper.own_paper(svg) is None


def test_a_full_bleed_rect_painted_with_a_gradient_is_not_a_paper_colour():
    svg = _card(paper="url(#grad)")
    assert card_paper.own_paper(svg) is None


# --------------------------------------------------------------------------
# repapering
# --------------------------------------------------------------------------

def test_repapering_moves_every_element_in_the_cards_own_paper():
    """grapefruit paints its paper twice — the base AND the panel over it.

    Repainting only the full-bleed base would change a colour that is covered by
    the stripes and the fruit, i.e. produce a diff that renders identically.
    """
    with open(GRAPEFRUIT, encoding="utf-8") as f:
        svg = f.read()
    assert svg.count('fill="#fffdf1"') >= 2
    out = card_paper.repaper(svg, "#123456")
    assert 'fill="#fffdf1"' not in out
    assert out.count('fill="#123456"') == svg.count('fill="#fffdf1"')


def test_repapering_leaves_the_sticker_halo_white():
    """The halo is #ffffff by contract, and on the generic card so is the paper."""
    with open(GENERIC, encoding="utf-8") as f:
        svg = f.read()
    out = card_paper.repaper(svg, "#f4f1eb")
    assert 'flood-color="#ffffff"' in out
    assert 'fill="#ffffff"' not in out


def test_repapering_touches_nothing_else():
    svg = _card(paper="#ffffff", extra='<rect x="1" y="1" width="2" height="2" '
                                       'fill="#111111"/>')
    out = card_paper.repaper(svg, "#abcdef")
    assert 'fill="#111111"' in out
    assert 'fill="#abcdef"' in out


def test_no_measurement_leaves_the_card_exactly_as_shipped():
    svg = _card(paper="#ffffff")
    assert card_paper.repaper(svg, None) is svg
    assert card_paper.repaper(svg, "not-a-colour") is svg


def test_a_card_already_on_the_right_paper_is_untouched():
    svg = _card(paper="#f4f1eb")
    assert card_paper.repaper(svg, "#f4f1eb") is svg
    assert card_paper.repaper(svg, "#F4F1EB") is svg


def test_an_unreadable_card_is_left_alone_rather_than_half_painted():
    svg = ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 223.92 312">'
           '<rect x="10" y="10" width="5" height="5" fill="#ffffff"/></svg>')
    assert card_paper.repaper(svg, "#123456") is svg


# --------------------------------------------------------------------------
# choosing which front to measure
# --------------------------------------------------------------------------

def test_a_v1_template_falls_back_to_its_8_up_sheet(monkeypatch, tmp_path):
    """Only grapefruit is migrated today; the rest still ship clean/fronts.svg.

    A half-migrated template must answer with its paper, not with "no paper".
    """
    seen = []

    def paper(path, workdir=None):
        seen.append(os.path.basename(path))
        return "#ffc6d7"

    monkeypatch.setattr(card_paper, "paper", paper)
    assert card_paper.front_paper("bachelorette") == "#ffc6d7"
    assert seen == ["fronts.svg"]


def test_a_v2_template_measures_a_numbered_front(monkeypatch):
    seen = []

    def paper(path, workdir=None):
        seen.append(os.path.basename(path))
        return "#fffdf1"

    monkeypatch.setattr(card_paper, "paper", paper)
    assert card_paper.front_paper("grapefruit") == "#fffdf1"
    assert seen and seen[0][0].isdigit()


# --------------------------------------------------------------------------
# end to end, through the composition helper
# --------------------------------------------------------------------------

def test_the_pawn_card_is_composed_on_the_measured_paper():
    svg = rp.photo_card_svg("grapefruit", [], paper="#ffc6d7")
    assert 'fill="#ffc6d7"' in svg
    assert 'fill="#fffdf1"' not in svg
    # …and it is still a photo card: four empty slots, halo intact.
    assert rp.photo_slot_count(svg) == 4
    assert 'flood-color="#ffffff"' in svg


def test_an_unmeasurable_front_leaves_the_pawn_card_as_shipped():
    svg = rp.photo_card_svg("grapefruit", [], paper=None)
    with open(GRAPEFRUIT, encoding="utf-8") as f:
        assert svg == f.read()


def test_assembling_the_deck_does_not_measure_anything_itself(monkeypatch, tmp_path):
    """``deck_document`` is contractually Chrome-free — colour must not change that.

    The paper is measured by ``build_deck`` and handed in. If the composition
    helper ever reaches for it itself, every structural test starts spawning a
    browser and CI without one silently renders a different card.
    """
    def boom(*a, **kw):
        raise AssertionError("photo_card_svg measured the paper itself")

    monkeypatch.setattr(card_paper, "front_paper", boom)
    rp.photo_card_svg("grapefruit", [], paper="#ffc6d7")


def test_the_deck_prints_the_pawn_card_on_the_paper_it_is_given(tmp_path):
    """End to end through the deck assembler, still without a browser."""
    import build
    import pack

    csvp = str(tmp_path / "deck.csv")
    pack.pack(["מילה%d" % i for i in range(40)], csvp, photo_card=True)
    doc, _vb = build.deck_document(
        "grapefruit", csvp, ["בדיקה"], workdir=str(tmp_path), paper="#ffc6d7")
    photo = doc._designs["photo"]
    assert 'fill="#ffc6d7"' in photo
    assert 'fill="#fffdf1"' not in photo


def test_build_deck_measures_the_front_and_hands_the_colour_down(monkeypatch,
                                                                 tmp_path):
    """The wiring: an order's deck really does print the pawn card repapered."""
    import build
    import pack

    monkeypatch.setattr(card_paper, "front_paper",
                        lambda theme, workdir=None: "#ffc6d7")
    rendered = {}
    monkeypatch.setattr(build, "print_to_pdf",
                        lambda html, out, wd, tag=None: rendered.setdefault(tag, html))
    monkeypatch.setattr(build, "build_board_pdf",
                        lambda *a, **kw: str(tmp_path / "board.pdf"))

    csvp = str(tmp_path / "deck.csv")
    pack.pack(["מילה%d" % i for i in range(40)], csvp, photo_card=True)
    build.build_deck("grapefruit", csvp, "בדיקה", str(tmp_path / "deck.pdf"),
                     workdir=str(tmp_path), progress=False)
    assert 'fill="#ffc6d7"' in rendered["deck"]


# --------------------------------------------------------------------------
# the real thing, with a real browser
# --------------------------------------------------------------------------

def _has_chrome():
    import shutil
    exe = card_paper.chrome.binary()
    return os.path.exists(exe) or shutil.which(os.path.basename(exe))


needs_chrome = pytest.mark.skipif(not _has_chrome(), reason="no Chrome")


@needs_chrome
def test_grapefruits_front_really_measures_its_panel_not_its_underlay():
    """The whole reason this is measured and not read out of the vector.

    ``clean/2.svg`` opens with two full-bleed paths, #ffffff then #f4f1eb.
    Neither is the paper: a rounded panel covers ~78% of the card in #fffdf1.
    """
    front = config.card_path("grapefruit", config.fronts(config.theme("grapefruit"))[0])
    with open(front, encoding="utf-8") as f:
        markup = f.read()
    assert '#f4f1eb' in markup, "the underlay this test is about has moved"
    assert card_paper.front_paper("grapefruit") == "#fffdf1"


@needs_chrome
def test_every_shipped_template_has_a_measurable_front_paper():
    """Sanity across the whole store, patterned and photographic ones included."""
    answers = {t: card_paper.front_paper(t) for t in config.load_themes()}
    unmeasured = [t for t, c in answers.items() if c is None]
    assert not unmeasured, f"no paper measured for {unmeasured}"
    for theme, colour in answers.items():
        assert re.match(r"^#[0-9a-f]{6}$", colour), (theme, colour)
