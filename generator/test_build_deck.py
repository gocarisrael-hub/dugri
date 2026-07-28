#!/usr/bin/env python3
"""Tests for the v2 single-card deck: generator/build.py build_deck/deck_document.

The contract these pin (docs/deck-rendering.md):

  * a standard order is 104 cards = 208 pages, ordered (back, front) so it
    prints duplex;
  * the eight front styles are cycled evenly and each page uses the style
    pack.py assigned it;
  * card 104 is the photo card, and it is the LAST card;
  * the board is a SEPARATE file, not the deck's last page;
  * a v1 (8-up) theme is refused by the v2 path rather than half-rendered.

Structure is asserted WITHOUT Chrome by going through ``deck_document``. The one
test that produces a real PDF is skipped when Chrome is absent, so CI without a
browser still runs everything else.

Run: python3 generator/test_build_deck.py   (or via pytest)
"""
import base64
import json
import os
import re
import shutil
import tempfile

import build
import config
import pack

HERE = os.path.dirname(os.path.abspath(__file__))
FONT = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")
W, H = 223.92, 312.0
# Big enough that deck_html treats it as the shared background.
import deck_html as dh  # noqa: E402  (needed for BG_MIN_CHARS below)
BIG = base64.b64encode(b"z" * dh.BG_MIN_CHARS).decode("ascii")


def _card_svg(marker):
    """A stand-in card export: same viewBox as the real ones, one big image."""
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" '
        'xmlns:xlink="http://www.w3.org/1999/xlink" width="299" height="416" '
        f'viewBox="0 0 {W} {H}">'
        f'<defs><clipPath id="clip"><rect width="9" height="9"/></clipPath></defs>'
        f'<g clip-path="url(#clip)"><image x="0" y="0" width="2459" height="1844" '
        f'xlink:href="data:image/png;base64,{BIG}"/></g>'
        f'<desc>{marker}</desc></svg>'
    )


def make_store(tmp, card_layout="single"):
    """A throwaway owner template store with a v2 grapefruit-shaped theme."""
    root = os.path.join(tmp, "store")
    theme_dir = os.path.join(root, "templates", "demo")
    os.makedirs(os.path.join(theme_dir, "clean"))
    os.makedirs(os.path.join(theme_dir, "fonts"))
    os.makedirs(os.path.join(root, "templates", "recipes"))
    for i in range(1, 10):
        with open(os.path.join(theme_dir, "clean", f"{i}.svg"), "w", encoding="utf-8") as f:
            f.write(_card_svg(f"card{i}"))
    with open(os.path.join(theme_dir, "clean", "board.svg"), "w", encoding="utf-8") as f:
        f.write(_card_svg("board"))
    shutil.copy(FONT, os.path.join(theme_dir, "fonts", "Cafe Regular.ttf"))

    entry = {
        "slug": "demo", "dir": "resources/canva/templates/demo", "recipe": "demo",
        "display_he": "demo", "visibility": "private",
        "title_lines": ["{NAME}"], "language": "hebrew", "extra_fields": [],
        "title_font": "Cafe Regular.ttf", "word_font": "Cafe Regular.ttf",
        "title_style": {"fill": "#fff", "outline": "#000", "outline_w": 0.05,
                        "arch": 0.06, "shadow": True, "size": 18},
        "word_size": 9,
        "back": {"frac": {"x0": 0.1, "y0": 0.4, "x1": 0.9, "y1": 0.6},
                 "fill": "#fff", "outline": "#000"},
        "board": {"frac": {"x0": 0.02, "y0": 0.88, "x1": 0.14, "y1": 0.98},
                  "fill": "#fff", "outline": "#000"},
        "calibrated": True,
    }
    if card_layout:
        # The canonical themes.json shape (docs/card-structure-schema.md): the
        # deck's back and fronts live in a `cards` block.
        entry["cards"] = {"back": 1, "fronts": [2, 3, 4, 5, 6, 7, 8, 9]}
    with open(os.path.join(root, "templates", "themes.json"), "w", encoding="utf-8") as f:
        json.dump({"demo": entry}, f)

    # The canonical recipe shape (docs/card-structure-schema.md, "Recipe format
    # v2"): format 2, per-front titles keyed by front number INSIDE card.title.
    recipe = {
        "theme": "demo", "format": 2, "viewBox": [0, 0, W, H],
        "card": {"cell": [0, 0, W, H],
                 "words": [{"x0": 0.12 * W, "y0": (0.46 + i * 0.085) * H,
                            "x1": 0.88 * W, "y1": (0.51 + i * 0.085) * H,
                            "color": "#333"} for i in range(4)],
                 "title": {str(n): [{"x0": 0.1 * W, "y0": 0.26 * H,
                                     "x1": 0.9 * W, "y1": 0.38 * H,
                                     "color": "#800"}] for n in range(2, 10)}},
        "back": {"title": [{"x0": 0.15 * W, "y0": 0.4 * H,
                            "x1": 0.85 * W, "y1": 0.58 * H, "color": "#800"}]},
    }
    with open(os.path.join(root, "templates", "recipes", "demo.json"), "w",
              encoding="utf-8") as f:
        json.dump(recipe, f)
    return root


class Store:
    """Point config at a throwaway store for the duration of a test."""

    def __init__(self, card_layout="single"):
        self.card_layout = card_layout

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="dugri-deck-test-")
        self.prev = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = make_store(self.tmp, self.card_layout)
        config.clear_preview_overrides()
        return self.tmp

    def __exit__(self, *exc):
        if self.prev is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.prev
        shutil.rmtree(self.tmp, ignore_errors=True)


def _csv(tmp, n_words=412):
    path = os.path.join(tmp, "order.csv")
    pack.pack([f"מילה{i}" for i in range(1, n_words + 1)], path)
    return path


def _pages(doc):
    """The (design_key, overlay) pages of an assembled deck."""
    return doc._pages


# --- deck shape -------------------------------------------------------------

def test_a_standard_order_is_104_cards_and_208_pages():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        assert doc.page_count == 208, f"expected 208 pages, got {doc.page_count}"


def test_pages_alternate_back_then_front_for_duplex_printing():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        keys = [k for k, _ in _pages(doc)]
        assert keys[0::2] == ["back"] * 104, "every odd page must be the back"
        assert "back" not in keys[1::2], "no back may appear in a front slot"


def test_the_photo_card_is_the_last_card():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        keys = [k for k, _ in _pages(doc)]
        assert keys[-1] == "photo"
        assert keys.count("photo") == 1, "exactly one photo card per deck"


def test_the_eight_front_styles_are_spread_evenly():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        fronts = [k for k, _ in _pages(doc) if k.startswith("front")]
        counts = sorted(fronts.count(f"front{i}") for i in range(2, 10))
        # 103 word cards over 8 styles: seven get 13, one gets 12.
        assert counts == [12, 13, 13, 13, 13, 13, 13, 13], counts


def test_each_page_uses_the_front_style_pack_assigned_it():
    with Store() as tmp:
        csvp = _csv(tmp)
        doc, _ = build.deck_document("demo", csvp, ["שירה"])
        cards = [c for c in pack.load_cards(csvp) if c["kind"] == "word"]
        fronts = [k for k, _ in _pages(doc) if k.startswith("front")]
        expected = [f"front{config.DEFAULT_FRONTS[c['front'] % 8]}" for c in cards]
        assert fronts == expected


def test_word_cards_carry_their_words_and_the_photo_card_carries_none():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        pages = _pages(doc)
        # A word card's overlay has four numbered lines; the photo card has no text.
        first_front = pages[1][1]
        assert first_front.count("<text") >= 4, "each card needs its 4 word lines"
        assert "<text" not in pages[-1][1], "the photo card carries no text"


def test_a_short_word_list_yields_a_shorter_deck_not_blank_cards():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp, n_words=40), ["שירה"])
        # 40 words -> 10 word cards + the photo card = 11 cards = 22 pages.
        assert doc.page_count == 22


def test_an_oversized_word_list_grows_the_deck_so_no_word_is_dropped():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp, n_words=600), ["שירה"])
        # 600 words -> 150 word cards + photo = 151 cards = 302 pages.
        assert doc.page_count == 302


# --- the back's title is an answer, not a gap -------------------------------
# Grapefruit's card back is a full-bleed pattern with NO text slot: its clean and
# filled exports render pixel-identical. Treating that "no boxes" as "not
# calibrated yet" and falling through to the theme's back.frac would stamp the
# honoree's name across the artwork on all 104 backs of a paid order.

def _with_back(tmp, value, drop=False):
    """Re-render the back overlay with the recipe's `back` key set/removed."""
    import render_page as rp
    path = os.path.join(os.environ["DATA_DIR"], "templates", "recipes", "demo.json")
    with open(path, encoding="utf-8") as f:
        recipe = json.load(f)
    if drop:
        recipe.pop("back", None)
    else:
        recipe["back"] = value
    return rp.back_overlay("demo", recipe, ["שירה"])


def test_detected_back_boxes_print_the_title():
    with Store() as tmp:
        assert _with_back(tmp, None, drop=False) is not None  # sanity
        import render_page as rp
        path = os.path.join(os.environ["DATA_DIR"], "templates", "recipes", "demo.json")
        with open(path, encoding="utf-8") as f:
            recipe = json.load(f)
        assert rp.back_overlay("demo", recipe, ["שירה"]), "detected boxes must print"


def test_an_explicit_null_back_prints_nothing():
    with Store() as tmp:
        assert _with_back(tmp, None) == "", (
            "an explicit null back means the artwork has no text slot; printing "
            "the name there would deface all 104 backs"
        )
        assert _with_back(tmp, {}) == ""


def test_an_absent_back_key_still_falls_back_to_the_theme_fractions():
    # No statement either way (a template predating back detection) keeps v1's
    # behaviour, so nothing that used to print a back title silently stops.
    with Store() as tmp:
        assert _with_back(tmp, None, drop=True) != ""


# --- the owner's saved calibration must actually be read --------------------
# Two things write a single-card template's geometry, to DIFFERENT files: the
# admin calibration form writes themes.json `card_slots` (fractions), while
# recipe_diff/calibrate write recipes/<t>.json `card` (viewBox units). The
# generator read only the recipe, so a template calibrated through the admin UI
# rendered with NO words and NO title — every measurement silently ignored, and
# the admin route will not even set calibrated:true without card_slots.

_FRAC_SLOTS = {
    "words": [{"x0": 0.12, "y0": 0.46 + i * 0.085,
               "x1": 0.88, "y1": 0.51 + i * 0.085} for i in range(4)],
    "titles": {str(n): {"x0": 0.10, "y0": 0.26, "x1": 0.90, "y1": 0.38}
               for n in range(2, 10)},
}
# What a template looks like when the owner calibrated by hand and detection was
# never run: format 2, a cell, and nothing else. This is grapefruit today.
_STUB_RECIPE = {"theme": "demo", "format": 2, "viewBox": [0, 0, W, H],
                "card": {"cell": [0, 0, W, H]}}


def _calibrate_by_hand(slots=_FRAC_SLOTS, recipe=None):
    """Save owner card_slots and (by default) blank out the detected recipe."""
    root = os.environ["DATA_DIR"]
    tp = os.path.join(root, "templates", "themes.json")
    with open(tp, encoding="utf-8") as f:
        themes = json.load(f)
    themes["demo"]["card_slots"] = slots
    with open(tp, "w", encoding="utf-8") as f:
        json.dump(themes, f)
    rp_path = os.path.join(root, "templates", "recipes", "demo.json")
    with open(rp_path, "w", encoding="utf-8") as f:
        json.dump(recipe if recipe is not None else _STUB_RECIPE, f)
    return recipe if recipe is not None else _STUB_RECIPE


def test_a_hand_calibrated_template_renders_its_words_and_title():
    import render_page as rp
    with Store():
        recipe = _calibrate_by_hand()
        out = rp.card_overlay("demo", recipe, ["א", "ב", "ג", "ד"], ["שירה"],
                              front_index=3)
        assert out.count("<text") >= 4, (
            "card_slots saved by the admin form must be rendered; reading only "
            "the recipe here prints a blank card"
        )


def test_hand_calibrated_slots_land_inside_the_card():
    # card_slots are FRACTIONS of the card; rendering them without converting to
    # viewBox units would put every word off-canvas.
    import re
    import render_page as rp
    with Store():
        recipe = _calibrate_by_hand()
        out = rp.card_overlay("demo", recipe, ["א", "ב", "ג", "ד"], ["שירה"],
                              front_index=3)
        xs = [float(v) for v in re.findall(r'<text x="([\d.]+)"', out)]
        assert xs and all(0 <= x <= W for x in xs), xs


def test_owner_calibration_wins_over_the_detected_recipe():
    with Store():
        recipe = _calibrate_by_hand(recipe=json.loads(json.dumps(_STUB_RECIPE)))
        recipe["card"]["words"] = [{"x0": 1, "y0": 1, "x1": 2, "y1": 2,
                                    "color": "#010101"} for _ in range(4)]
        cfg = config.theme("demo")
        boxes = config.card_word_boxes(cfg, recipe, [0, 0, W, H])
        # The owner's box spans 12%..88% of the card, not the recipe's 1..2 units.
        assert boxes[0]["x1"] > 100, boxes[0]
        # ...but the DETECTED ink colour is still used, since card_slots has none.
        assert boxes[0]["color"] == "#010101", boxes[0]


def test_detection_still_works_when_the_owner_saved_nothing():
    # The mirror of the bug: preferring card_slots must not orphan the
    # auto-detected recipe on a template the owner never hand-calibrated.
    with Store() as tmp:
        path = os.path.join(os.environ["DATA_DIR"], "templates", "recipes", "demo.json")
        with open(path, encoding="utf-8") as f:
            recipe = json.load(f)
        cfg = config.theme("demo")
        assert config.card_slots(cfg) is None
        assert len(config.card_word_boxes(cfg, recipe, [0, 0, W, H])) == 4
        assert len(config.card_title_boxes(cfg, recipe, 3, [0, 0, W, H])) == 1


# --- the board is a separate artifact ---------------------------------------

def test_board_path_is_derived_from_the_deck_path():
    assert build.board_pdf_path("/x/order.pdf") == "/x/order.board.pdf"
    assert build.board_pdf_path("/x/order") == "/x/order.board.pdf"
    assert build.board_pdf_path("/x/ORDER.PDF") == "/x/ORDER.board.pdf"


def test_no_board_page_is_inside_the_deck():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        assert "board" not in [k for k, _ in _pages(doc)]


# --- guards -----------------------------------------------------------------

def test_a_v1_theme_is_refused_by_the_v2_path():
    with Store(card_layout=None) as tmp:
        try:
            build.deck_document("demo", _csv(tmp), ["שירה"])
        except RuntimeError as e:
            assert "cards" in str(e), e
            return
        raise AssertionError("a v1 theme must be refused, not half-rendered")


def test_photos_are_topped_up_from_the_fallback_set():
    with Store() as tmp:
        real = os.path.join(tmp, "a.png")
        with open(real, "wb") as f:
            f.write(b"\x89PNG")
        fallbacks = []
        for i in range(4):
            p = os.path.join(tmp, f"fb{i}.png")
            with open(p, "wb") as f:
                f.write(b"\x89PNG")
            fallbacks.append(p)
        themes_path = os.path.join(os.environ["DATA_DIR"], "templates", "themes.json")
        with open(themes_path, encoding="utf-8") as f:
            themes = json.load(f)
        themes["demo"]["photo_card"] = {"fallback": fallbacks}
        with open(themes_path, "w", encoding="utf-8") as f:
            json.dump(themes, f)

        assert build.resolve_photos("demo", [real]) == [real] + fallbacks[:3]
        assert build.resolve_photos("demo", []) == fallbacks
        # A path that does not exist is dropped, never rendered as a broken image.
        assert build.resolve_photos("demo", ["/no/such.png"]) == fallbacks


# --- end to end (needs Chrome) ----------------------------------------------

def _chrome():
    return shutil.which(os.environ.get("CHROME", "")) or (
        os.path.exists(os.environ.get("CHROME", "")) and os.environ["CHROME"]) or \
        shutil.which("google-chrome") or shutil.which("chromium") or \
        shutil.which("chromium-browser")


def test_end_to_end_produces_a_208_page_deck_and_a_1_page_board():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    with Store() as tmp:
        out = os.path.join(tmp, "deck.pdf")
        pdf, pages, board = build.build_deck(
            "demo", _csv(tmp), "שירה", out, workdir=os.path.join(tmp, "wd"),
            progress=False)
        assert pages == 208
        assert os.path.exists(pdf) and os.path.exists(board)
        assert _pdf_page_count(pdf) == 208, _pdf_page_count(pdf)
        assert _pdf_page_count(board) == 1
        # The page box must be the card's physical size, so "print at 100%" is
        # honest: 223.92 x 312 points.
        assert _pdf_media_box(pdf)[:2] == [223.92, 312.0], _pdf_media_box(pdf)


def _pdf_page_count(path):
    with open(path, "rb") as f:
        data = f.read()
    counts = [int(c) for c in re.findall(rb"/Count\s+(\d+)", data)]
    return max(counts) if counts else 0


def _pdf_media_box(path):
    with open(path, "rb") as f:
        data = f.read()
    m = re.search(rb"/MediaBox\s*\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)", data)
    if not m:
        return []
    x0, y0, x1, y1 = (float(v) for v in m.groups())
    return [round(x1 - x0, 2), round(y1 - y0, 2)]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  {fn.__name__}")
    print(f"all {len(fns)} tests passed")
