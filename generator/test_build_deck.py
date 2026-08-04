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


def make_store(tmp, card_layout="single", fronts=(2, 3, 4, 5, 6, 7, 8, 9), backs=None):
    """A throwaway owner template store with a v2 grapefruit-shaped theme.

    ``fronts`` is the deck's front list. A ONE-FRONT template passes ``(2,)``
    and ships only ``clean/1.svg`` + ``clean/2.svg`` — the deck is meant to work
    off a single design, NOT off eight copies of it, so the other seven files are
    deliberately absent here and their absence is part of what is being tested.
    """
    fronts = list(fronts)
    backs = list(backs) if backs else []
    root = os.path.join(tmp, "store")
    theme_dir = os.path.join(root, "templates", "demo")
    os.makedirs(os.path.join(theme_dir, "clean"))
    os.makedirs(os.path.join(theme_dir, "fonts"))
    os.makedirs(os.path.join(root, "templates", "recipes"))
    for i in [1] + fronts + backs:
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
        entry["cards"] = {"back": 1, "fronts": fronts}
        # A template whose eight styles each have their OWN back records the list
        # positionally: backs[i] prints on the reverse of fronts[i].
        if backs:
            entry["cards"]["backs"] = backs
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
                                     "color": "#800"}] for n in fronts}},
        "back": {"title": [{"x0": 0.15 * W, "y0": 0.4 * H,
                            "x1": 0.85 * W, "y1": 0.58 * H, "color": "#800"}]},
    }
    with open(os.path.join(root, "templates", "recipes", "demo.json"), "w",
              encoding="utf-8") as f:
        json.dump(recipe, f)
    return root


class Store:
    """Point config at a throwaway store for the duration of a test."""

    def __init__(self, card_layout="single", fronts=(2, 3, 4, 5, 6, 7, 8, 9), backs=None):
        self.card_layout = card_layout
        self.fronts = fronts
        self.backs = backs

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="dugri-deck-test-")
        self.prev = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = make_store(self.tmp, self.card_layout, self.fronts,
                                            self.backs)
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
        # The design id carries the back's CARD INDEX now that a deck can
        # register more than one (a template whose eight styles each have their
        # own back). A shared-back deck registers exactly one, "back1".
        assert keys[0::2] == ["back1"] * 104, "every odd page must be the back"
        assert not any(k.startswith("back") for k in keys[1::2]), \
            "no back may appear in a front slot"


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


# --- one front for the whole deck -------------------------------------------
# The admin's "אותו עיצוב לכל הקלפים" upload registers a deck whose front list
# holds ONE index. Nothing duplicates that design to nine filenames: the cycle
# `fronts[card["front"] % len(fronts)]` already lands every card on it, and a
# store built for these tests ships only clean/1.svg + clean/2.svg to prove the
# other seven files are genuinely never read.

ONE = (2,)


def test_a_one_front_deck_is_still_104_cards_and_208_pages():
    with Store(fronts=ONE) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        assert doc.page_count == 208, f"expected 208 pages, got {doc.page_count}"


def test_every_word_card_of_a_one_front_deck_uses_that_one_front():
    with Store(fronts=ONE) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        fronts = [k for k, _ in _pages(doc) if k.startswith("front")]
        assert set(fronts) == {"front2"}, sorted(set(fronts))
        assert len(fronts) == 103, len(fronts)


def test_the_back_is_applied_to_every_card_of_a_one_front_deck():
    with Store(fronts=ONE) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        keys = [k for k, _ in _pages(doc)]
        # The design id carries the back's CARD INDEX now that a deck can
        # register more than one (a template whose eight styles each have their
        # own back). A shared-back deck registers exactly one, "back1".
        assert keys[0::2] == ["back1"] * 104, "every odd page must be the back"
        assert not any(k.startswith("back") for k in keys[1::2]), \
            "no back may appear in a front slot"
        # ...and the photo card is still the last card, as on any other deck.
        assert keys[-1] == "photo"


def test_a_one_front_deck_registers_one_design_not_nine_copies():
    with Store(fronts=ONE) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        # back + the single front + the photo card. Nine near-identical designs
        # would be nine copies of the same artwork in every render.
        assert sorted(doc._designs) == ["back1", "front2", "photo"], sorted(doc._designs)
        cfg = config.theme("demo")
        assert config.fronts(cfg) == [2]
        assert [os.path.basename(p) for p in config.front_paths("demo")] == ["2.svg"]
        assert os.path.basename(config.back_path("demo")) == "1.svg"


def test_words_and_title_still_land_on_a_one_front_card():
    with Store(fronts=ONE) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        first_front = _pages(doc)[1][1]
        assert first_front.count("<text") >= 4, "each card needs its 4 word lines"


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


# --- a customer photo is framed on the subject, not on a fixed square --------
# docs/photo-card.md. A cutout's alpha says exactly where the person is, so
# square_photo frames on THAT: subject bbox -> scaled onto the slot's disc ->
# clipped to it. The fixed square it replaced sliced through arms and legs, and
# because the sticker halo is dilated from the image's own alpha it then traced
# that ruler-straight cut instead of the subject.
#
# The head-anchored square survives for one case only — a photo with no usable
# alpha, where there is nothing to look at and the old guess is still the best
# available. Those tests are grouped at the end of this block.

def _portrait(path, w=900, h=1600):
    """A stand-in person: head in the upper part of the frame, body below.

    Shapes are sized RELATIVE to the frame so the same helper works for a tiny
    photo and a huge one — the contract test feeds it both.
    """
    from PIL import Image, ImageDraw
    im = Image.new("RGB", (w, h), (40, 90, 160))
    d = ImageDraw.Draw(im)
    hr = w * 0.17                                   # head radius
    hy = h * 0.17                                   # head centre, upper part
    d.ellipse([w / 2 - hr, hy - hr, w / 2 + hr, hy + hr], fill=(250, 220, 190))
    d.rectangle([w / 2 - w * 0.22, hy + hr, w / 2 + w * 0.22, h], fill=(220, 60, 60))
    im.save(path)
    return path


def _head_fraction(img):
    from PIL import Image
    px = list(img.convert("RGB").getdata())
    hits = sum(1 for r, g, b in px
               if abs(r - 250) < 25 and abs(g - 220) < 25 and abs(b - 190) < 25)
    return hits / len(px)


# --- cutout helpers ----------------------------------------------------------
# A cutout is what the wizard actually hands the generator: the subject opaque,
# everything else alpha 0. `_cutout` draws a stand-in person — head on top of a
# body — anywhere in the frame, and by default runs the body off the BOTTOM
# edge, which is where real photos get their ruler-straight cut.

HEAD = (250, 220, 190, 255)
BODY = (220, 60, 60, 255)


def _cutout(path, w=900, h=1600, box=None, run_off_bottom=True, extra=None):
    """A transparent PNG with one opaque person in it.

    ``box`` is where the person goes, in pixels (l, t, r, b); it defaults to a
    plausible off-centre portrait. ``extra`` is a list of extra opaque blobs
    ``(l, t, r, b, colour)`` — a bystander, or a speck the segmenter left.
    """
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if box is None:
        box = (int(w * 0.2), int(h * 0.12), int(w * 0.8), h if run_off_bottom else int(h * 0.75))
    left, top, right, bottom = box
    # The head has to fit the box in BOTH directions — a wide subject (a dog)
    # gets a small head on a long body, not an ellipse taller than the frame.
    hr = min((right - left) * 0.30, (bottom - top) * 0.30)
    hx = (left + right) / 2.0
    hy = top + hr
    d.ellipse([hx - hr, hy - hr, hx + hr, hy + hr], fill=HEAD)
    d.rectangle([left, min(hy + hr * 0.6, bottom - 1), right, bottom], fill=BODY)
    for bl, bt, br, bb, colour in (extra or []):
        d.rectangle([bl, bt, br, bb], fill=colour)
    im.save(path)
    return path


def _alpha_runs(img, thresh=24):
    """Per row, the widest run of opaque pixels. Empty rows are 0."""
    a = img.getchannel("A")
    w, h = a.size
    px = a.load()
    out = []
    for y in range(h):
        best = run = 0
        for x in range(w):
            run = run + 1 if px[x, y] >= thresh else 0
            if run > best:
                best = run
        out.append(best)
    return out


def _opaque_outside_disc(img, fill=None, slack=2):
    """Opaque pixels beyond the clip disc — must be none."""
    import math
    fill = build.PHOTO_DISC_FILL if fill is None else fill
    a = img.getchannel("A")
    side = a.size[0]
    px = a.load()
    c = side / 2.0
    r = side * fill / 2.0 + slack
    return sum(1 for y in range(side) for x in range(side)
               if px[x, y] >= 24 and math.hypot(x - c, y - c) > r)


def test_a_portrait_photo_is_squared_keeping_the_head():
    from PIL import Image
    with Store() as tmp:
        src = _portrait(os.path.join(tmp, "p.png"))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        assert out != src
        with Image.open(out) as sq:
            assert sq.size[0] == sq.size[1], sq.size
            kept = _head_fraction(sq)
        with Image.open(src) as im:
            side = min(im.size)
            top = (im.size[1] - side) // 2
            centred = _head_fraction(im.crop((0, top, side, top + side)))
        assert kept > centred * 2, (kept, centred)


def test_a_landscape_photo_is_centred_horizontally():
    from PIL import Image
    with Store() as tmp:
        src = _portrait(os.path.join(tmp, "l.png"), w=1600, h=900)
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            assert sq.size[0] == sq.size[1], sq.size


def test_the_square_matches_the_photo_card_contract_size():
    # docs/photo-card.md: 512 target, 220 floor (300 DPI over the slot), 1024
    # ceiling — anything larger is base64 shipped four times over in the PDF.
    from PIL import Image
    with Store() as tmp:
        for w, h in ((900, 1600), (120, 200), (4000, 6000)):
            src = _portrait(os.path.join(tmp, f"p{w}.png"), w=w, h=h)
            out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
            with Image.open(out) as sq:
                assert sq.size == (build.PHOTO_SLOT_PX, build.PHOTO_SLOT_PX), (w, h, sq.size)
                assert build.PHOTO_SLOT_MIN_PX <= sq.size[0] <= build.PHOTO_SLOT_MAX_PX


def test_the_subject_lands_inside_the_slot_s_visible_disc():
    # DEGRADED PATH — an opaque photo, so the head-anchored square is all we
    # have. The slot's cut-line is the square's inscribed circle, so a subject
    # pinned near the top edge would be cut in half by it. Nothing clips this
    # crop (docs/photo-card.md wants an uncut photo to look obviously wrong),
    # which is exactly why the head has to land near the middle by itself.
    import math
    from PIL import Image
    with Store() as tmp:
        src = _portrait(os.path.join(tmp, "p.png"))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            px = sq.convert("RGB").load()
            side = sq.size[0]
            cx = cy = side / 2.0
            inside = outside = 0
            for y in range(0, side, 4):
                for x in range(0, side, 4):
                    r, g, b = px[x, y]
                    if abs(r - 250) < 25 and abs(g - 220) < 25 and abs(b - 190) < 25:
                        if math.hypot(x - cx, y - cy) <= side / 2.0:
                            inside += 1
                        else:
                            outside += 1
        assert inside > 0, "the test photo's head should be in the crop at all"
        assert outside == 0, f"{outside} head pixels fall outside the visible disc"


def test_an_unreadable_photo_falls_back_to_the_original():
    # Never fail an order over a photo we cannot process — print it as-is.
    with Store() as tmp:
        bad = os.path.join(tmp, "bad.png")
        with open(bad, "wb") as f:
            f.write(b"not an image")
        assert build.square_photo(bad, os.path.join(tmp, "sq"), 0) == bad


def test_only_customer_photos_are_squared_not_the_shipped_pawns():
    # The shipped pawns are already square sticker art; re-encoding them would
    # only lose quality.
    with Store() as tmp:
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
        src = _portrait(os.path.join(tmp, "one.png"))
        got = build.resolve_photos("demo", [src], workdir=os.path.join(tmp, "sq"))
        assert got[0] != src, "the customer photo should be squared"
        assert got[1:] == fallbacks[:3], "shipped pawns must pass through untouched"


def test_a_transparent_photo_keeps_its_alpha():
    # convert("RGB") FLATTENED the alpha, so a cutout arrived opaque — and with
    # the white disc gone (die-cut stickers) it printed as a white-edged
    # rectangle. The shipped fallbacks never pass through here, which is why
    # they looked right while real customer photos did not.
    from PIL import Image
    with Store() as tmp:
        src = _cutout(os.path.join(tmp, "cut.png"))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            assert sq.mode == "RGBA", sq.mode
            lo, hi = sq.getchannel("A").getextrema()
            assert lo == 0, "fully transparent pixels must survive"
            assert hi == 255, "the subject must still be fully opaque"


def test_a_photo_stays_under_the_deck_hoist_threshold():
    # deck_html hoists any <image> past BG_MIN_CHARS into shared defs, which
    # would strip the photo-slot id and orphan the sticker halo. Both paths: a
    # cutout is the normal case and an opaque photo the degraded one, and the
    # opaque one is the heavier of the two (no transparency to compress).
    import deck_html
    with Store() as tmp:
        for name, src in (("cut", _cutout(os.path.join(tmp, "big-cut.png"), 3000, 4000)),
                          ("opaque", _portrait(os.path.join(tmp, "huge.png"), 3000, 4000))):
            out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
            chars = build._b64_chars(out)
            assert chars <= build.PHOTO_MAX_B64_CHARS, (name, chars)
            assert chars < deck_html.BG_MIN_CHARS, (name, chars, deck_html.BG_MIN_CHARS)


# --- the subject-aware crop --------------------------------------------------

def test_the_crop_is_framed_on_the_subject_not_on_the_frame():
    # The whole point: a subject sitting off to one side of the photo comes out
    # CENTRED on the slot's disc. The old fixed square took the same rectangle
    # out of every photo no matter where the person stood.
    from PIL import Image
    with Store() as tmp:
        # Far left, and well down the frame — the old crop would have shown mostly
        # empty background and sliced her at the square's edge.
        src = _cutout(os.path.join(tmp, "c.png"), 1200, 1600,
                      box=(60, 700, 460, 1600))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            side = sq.size[0]
            a = sq.getchannel("A")
            px = a.load()
            n = sx = sy = 0
            for y in range(0, side, 2):
                for x in range(0, side, 2):
                    if px[x, y] >= 24:
                        n += 1
                        sx += x
                        sy += y
        assert n > 0, "the subject vanished"
        # Centre of mass within a fifth of the square of the middle. Not dead
        # centre: a person is bottom-heavy, and the top of them is anchored, not
        # their middle.
        assert abs(sx / n - side / 2) < side * 0.2, sx / n
        assert abs(sy / n - side / 2) < side * 0.2, sy / n


def test_the_photo_is_clipped_to_the_slot_s_disc():
    # docs/photo-card.md point 5. Everything outside the disc is cut away, so the
    # halo dilated from this alpha can only ever be a round edge.
    from PIL import Image
    with Store() as tmp:
        src = _cutout(os.path.join(tmp, "c.png"))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            stray = _opaque_outside_disc(sq)
            side = sq.size[0]
            a = sq.getchannel("A").load()
            corners = [a[0, 0], a[side - 1, 0], a[0, side - 1], a[side - 1, side - 1]]
        assert stray == 0, f"{stray} opaque pixels outside the clip disc"
        assert corners == [0, 0, 0, 0], corners


def test_the_disc_stops_short_of_the_dashed_cut_line():
    # The halo dilates ~2.4 units outward and the cut-line sits at r=33 of a
    # 66-unit slot. A disc filling the whole square would put the white ring ON
    # the dashes — hiding the line you are meant to cut and leaving the ring
    # outside the cut, where it is trimmed off the finished pawn.
    halo_share = 2.4 / 33.0
    assert build.PHOTO_DISC_FILL <= 1 - halo_share, build.PHOTO_DISC_FILL
    # …and not so small that the pawn rattles around inside its cut-line.
    assert build.PHOTO_DISC_FILL >= 0.85, build.PHOTO_DISC_FILL


def test_the_photo_s_own_edge_no_longer_cuts_the_sticker_in_a_straight_line():
    # THE BUG. Real photos run the person off the bottom of the frame, so the
    # cutout's alpha ends in a ruler-straight line — and the halo traced it. The
    # subject is now scaled and placed so that edge falls OUTSIDE the disc, which
    # leaves the bottom of the sticker as a short circular chord instead of a
    # full-width straight run.
    from PIL import Image
    with Store() as tmp:
        src = _cutout(os.path.join(tmp, "c.png"), run_off_bottom=True)
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            side = sq.size[0]
            runs = _alpha_runs(sq)
        opaque_rows = [y for y, r in enumerate(runs) if r > 0]
        assert opaque_rows, "nothing opaque at all"
        last = opaque_rows[-1]
        assert runs[last] < side * 0.35, (
            f"the bottom row of the sticker is {runs[last]}px of {side} wide — "
            "that is the photo's own straight edge, not a circular chord")


def test_the_blob_nearest_the_centre_wins_and_the_others_are_erased():
    # A segmenter happily keeps a bystander. Nearest-to-centre, not biggest: the
    # person standing behind the honoree is easily the larger of the two, and the
    # one being photographed is the one in the middle.
    from PIL import Image
    with Store() as tmp:
        src = _cutout(
            os.path.join(tmp, "c.png"), 1400, 1400,
            box=(560, 480, 840, 900),                       # the subject, centred
            run_off_bottom=False,
            extra=[(0, 100, 380, 1300, (0, 200, 0, 255))])  # a BIGGER bystander
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            px = sq.convert("RGBA").load()
            side = sq.size[0]
            green = subject = 0
            for y in range(0, side, 2):
                for x in range(0, side, 2):
                    r, g, b, alpha = px[x, y]
                    if alpha < 24:
                        continue
                    if g > 150 and r < 80 and b < 80:
                        green += 1
                    else:
                        subject += 1
        assert subject > 0, "the subject was erased"
        assert green == 0, f"{green} bystander pixels came along for the ride"


def test_a_speck_at_dead_centre_cannot_beat_the_subject():
    # Nearest-to-centre on its own would let a 20-pixel scrap of background win.
    # Anything under PHOTO_BLOB_MIN_SHARE of the biggest blob is dropped first.
    from PIL import Image
    with Store() as tmp:
        src = _cutout(
            os.path.join(tmp, "c.png"), 1200, 1200,
            box=(120, 150, 560, 1000), run_off_bottom=False,
            extra=[(596, 596, 604, 604, (0, 200, 0, 255))])  # 8px speck, dead centre
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            assert _head_fraction(sq) > 0.01, "the person was dropped for a speck"


def test_a_tall_subject_keeps_its_head_rather_than_its_torso():
    # A standing person is much taller than the disc, so something has to go.
    # The alpha tells us where the TOP of them is, so the bottom goes.
    from PIL import Image
    with Store() as tmp:
        # Standing, and low in a tall frame: the head is nowhere near the old
        # 0.30-of-the-height guess, so only the alpha can find it.
        src = _cutout(os.path.join(tmp, "c.png"), 1000, 2400,
                      box=(380, 1400, 620, 2400))
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            side = sq.size[0]
            px = sq.convert("RGBA").load()
            head_ys = [y for y in range(0, side, 2) for x in range(0, side, 2)
                       if px[x, y][3] >= 24 and abs(px[x, y][0] - 250) < 25
                       and abs(px[x, y][1] - 220) < 25 and abs(px[x, y][2] - 190) < 25]
        assert head_ys, "the head was cropped out of a standing figure"
        assert min(head_ys) > 0, "the head is flush with the top — no headroom"
        assert sum(head_ys) / len(head_ys) < side * 0.5, "the head sank below the middle"


def test_a_wide_subject_is_not_cropped_left_or_right():
    # We know where the top of a person is; we have no handle on which SIDE of a
    # wide subject matters — a dog's head can be at either end — so the window is
    # sized on the subject's width and both ends survive.
    from PIL import Image
    with Store() as tmp:
        # Both ends of the subject are tagged, and both have to survive. The old
        # centre square took 1000px out of a 1600px frame and lost both.
        left_mark, right_mark = (0, 0, 255, 255), (255, 0, 255, 255)
        src = _cutout(os.path.join(tmp, "c.png"), 1600, 1000,
                      box=(200, 300, 1400, 1000), run_off_bottom=False,
                      extra=[(200, 500, 280, 700, left_mark),
                             (1320, 500, 1400, 700, right_mark)])
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            side = sq.size[0]
            px = sq.convert("RGBA").load()
            seen = set()
            for y in range(0, side, 2):
                for x in range(0, side, 2):
                    r, g, b, a = px[x, y]
                    if a < 24:
                        continue
                    if b > 150 and r < 80 and g < 80:
                        seen.add("left")
                    elif r > 150 and b > 150 and g < 80:
                        seen.add("right")
        assert seen == {"left", "right"}, f"lost an end of a wide subject: {seen}"


def test_subject_window_may_run_off_the_photo():
    # A subject standing at the very edge needs canvas that is not in the photo.
    # Cropping past the edge pads with transparency, which is what a sticker
    # wants — the alternative is sliding the window and off-centring the person.
    win = build.subject_window((0, 0, 100, 400))
    assert win[0] < 0 and win[1] < 0, win
    assert win[2] - win[0] == win[3] - win[1], win


# --- no usable alpha: the old square crop, unclipped -------------------------

def test_a_photo_with_no_usable_alpha_keeps_the_old_square_crop():
    # docs/photo-card.md point 1 — an uncut photo must print as an obvious
    # white-edged rectangle, not quietly look almost right. So the degraded path
    # is byte-for-byte the crop we shipped before, and is NOT clipped to a disc.
    from PIL import Image
    with Store() as tmp:
        src = _portrait(os.path.join(tmp, "p.png"))
        assert build.subject_box(Image.open(src).convert("RGBA")) is None
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            side = sq.size[0]
            a = sq.getchannel("A").load()
            corners = [a[0, 0], a[side - 1, 0], a[0, side - 1], a[side - 1, side - 1]]
        assert corners == [255, 255, 255, 255], (
            f"the degraded path clipped the photo to a disc ({corners}) — an "
            "uncut photo is meant to look broken, not almost right")


def test_a_collapsed_cut_falls_back_instead_of_framing_on_nothing():
    # A cut that found almost nothing (one stray pixel) must not be framed on:
    # it would zoom that pixel to fill the disc. Below PHOTO_SUBJECT_MIN_COVER we
    # treat the photo as uncut and print it.
    from PIL import Image
    with Store() as tmp:
        src = os.path.join(tmp, "empty.png")
        im = Image.new("RGBA", (900, 1600), (0, 0, 0, 0))
        im.putpixel((450, 300), (255, 0, 0, 255))
        im.save(src)
        assert build.subject_box(Image.open(src)) is None
        out = build.square_photo(src, os.path.join(tmp, "sq"), 0)
        with Image.open(out) as sq:
            assert sq.size == (build.PHOTO_SLOT_PX, build.PHOTO_SLOT_PX)
            assert sq.mode == "RGBA"


# --- a template with no recipe yet ------------------------------------------
# Every freshly uploaded template is in this state until detection runs. Opening
# the calibration screen on one produced a Python traceback — on the very screen
# whose purpose is to supply the missing geometry.

def _drop_recipe():
    """Point the demo theme at a recipe that does not exist."""
    root = os.environ["DATA_DIR"]
    tp = os.path.join(root, "templates", "themes.json")
    with open(tp, encoding="utf-8") as f:
        themes = json.load(f)
    themes["demo"]["recipe"] = "no-such-recipe"
    themes["demo"].pop("card_slots", None)
    with open(tp, "w", encoding="utf-8") as f:
        json.dump(themes, f)


def test_a_missing_recipe_reads_as_empty_rather_than_raising():
    with Store():
        _drop_recipe()
        cfg = config.theme("demo")
        assert config.recipe_or_empty(cfg) == {}


def test_card_slots_alone_are_enough_without_any_recipe():
    # A hand-calibrated template must render from card_slots alone — the cell
    # comes from the ARTWORK's viewBox, not the (absent) recipe. Without that
    # fallback the cell collapsed to [0,0,0,0] and every fraction multiplied to
    # zero, so the card came out blank.
    import render_page as rp
    with Store():
        _drop_recipe()
        root = os.environ["DATA_DIR"]
        tp = os.path.join(root, "templates", "themes.json")
        with open(tp, encoding="utf-8") as f:
            themes = json.load(f)
        themes["demo"]["card_slots"] = {
            "words": [{"x0": 0.3, "y0": 0.35 + i * 0.1, "x1": 0.7, "y1": 0.40 + i * 0.1}
                      for i in range(4)],
            "titles": {str(n): {"x0": 0.27, "y0": 0.11, "x1": 0.73, "y1": 0.20}
                       for n in range(2, 10)},
        }
        with open(tp, "w", encoding="utf-8") as f:
            json.dump(themes, f)
        cfg = config.theme("demo")
        boxes = config.card_word_boxes(cfg, {}, rp._recipe_cell({}, [0, 0, W, H]))
        assert len(boxes) == 4
        # Real coordinates on the card, not a collapsed zero box.
        assert boxes[0]["x1"] > 100, boxes[0]


def test_an_order_refuses_when_there_is_no_geometry_at_all():
    # A preview may show a bare card; an ORDER may not print 104 blank ones.
    with Store() as tmp:
        _drop_recipe()
        try:
            build.deck_document("demo", _csv(tmp), ["שירה"])
        except RuntimeError as e:
            assert "no word-slot geometry" in str(e), e
            assert "זהה מחדש" in str(e), "the error must name the fix"
            return
        raise AssertionError("an order with no geometry must be refused")


# --- per-front backs --------------------------------------------------------
# A template whose eight card styles each have their OWN back. `cards.backs` is
# positional: backs[i] prints on the reverse of fronts[i], so the duplex pairing
# is fixed and a card never comes out with another style's back.

PAIRED_FRONTS = (2, 3, 4, 5, 6, 7, 8, 9)
PAIRED_BACKS = (10, 11, 12, 13, 14, 15, 16, 17)


def test_each_front_prints_with_its_OWN_back():
    with Store(fronts=PAIRED_FRONTS, backs=PAIRED_BACKS) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        keys = [k for k, _ in _pages(doc)]
        backs, fronts = keys[0::2], keys[1::2]
        assert len(backs) == len(fronts) == 104
        for back, front in zip(backs, fronts):
            if front == "photo":      # the photo card takes the first back
                assert back == "back10"
                continue
            n = int(front.removeprefix("front"))
            assert back == f"back{n + 8}", f"{front} printed with {back}"


def test_a_paired_deck_registers_every_back_exactly_once():
    with Store(fronts=PAIRED_FRONTS, backs=PAIRED_BACKS) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        assert sorted(doc._designs) == sorted(
            [f"back{n}" for n in PAIRED_BACKS]
            + [f"front{n}" for n in PAIRED_FRONTS]
            + ["photo"]
        ), sorted(doc._designs)


def test_a_paired_deck_is_still_104_cards_back_then_front():
    with Store(fronts=PAIRED_FRONTS, backs=PAIRED_BACKS) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        keys = [k for k, _ in _pages(doc)]
        assert doc.page_count == 208
        assert all(k.startswith("back") for k in keys[0::2])
        assert not any(k.startswith("back") for k in keys[1::2])
        assert keys[-1] == "photo"


def test_one_front_with_its_own_back_pairs_them():
    with Store(fronts=(2,), backs=(10,)) as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        assert sorted(doc._designs) == ["back10", "front2", "photo"]
        keys = [k for k, _ in _pages(doc)]
        assert keys[0::2] == ["back10"] * 104


# --- config.back_indices ----------------------------------------------------

def test_back_indices_pairs_positionally():
    cfg = {"cards": {"back": 1, "fronts": [2, 3, 4], "backs": [10, 11, 12]}}
    assert config.back_indices(cfg) == [10, 11, 12]
    assert config.has_per_front_backs(cfg) is True


def test_back_indices_repeats_the_single_back_when_there_is_no_list():
    cfg = {"cards": {"back": 1, "fronts": [2, 3, 4]}}
    # Callers zip fronts with backs and never branch — the shared-back deck is
    # the degenerate pairing, not a special case.
    assert config.back_indices(cfg) == [1, 1, 1]
    assert config.has_per_front_backs(cfg) is False


def test_a_short_back_list_pads_from_its_OWN_first_back():
    # Padding from the default back (1) could print a back belonging to a
    # different design; repeating one of this artwork's own backs cannot.
    cfg = {"cards": {"back": 1, "fronts": [2, 3, 4, 5], "backs": [10, 11]}}
    assert config.back_indices(cfg) == [10, 11, 10, 10]


def test_a_longer_back_list_is_trimmed_to_the_front_count():
    cfg = {"cards": {"back": 1, "fronts": [2, 3], "backs": [10, 11, 12, 13]}}
    assert config.back_indices(cfg) == [10, 11]


def test_junk_entries_in_the_back_list_are_dropped():
    cfg = {"cards": {"back": 1, "fronts": [2, 3], "backs": ["10", None, 11]}}
    assert config.back_indices(cfg) == [10, 11]


def test_an_all_junk_back_list_falls_back_to_the_single_back():
    cfg = {"cards": {"back": 4, "fronts": [2, 3], "backs": [None, "x"]}}
    assert config.back_indices(cfg) == [4, 4]


def test_a_v1_theme_has_no_per_front_backs():
    assert config.has_per_front_backs({}) is False
    assert config.back_indices({"cards": {"fronts": [2]}}) == [1]
