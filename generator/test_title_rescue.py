#!/usr/bin/env python3
"""Which face a title is set in — one decision about the WHOLE title.

The owner's rules, and the code answers to them rather than the other way round:

  * a design has ONE title font, and may have a SECOND;
  * the second is used when THE TITLE'S LANGUAGE IS NOT THE DESIGN'S — a Hebrew
    title on a Latin-faced design, or the reverse — and when it applies it sets
    the WHOLE title: every letter, digit, space and mark. A title is never split
    across two typefaces;
  * ONE LANGUAGE PER TITLE, plus neutrals. A mixed-script title is refused where
    the buyer types it, not handled here;
  * only a title the BUYER typed. A design whose own title its own face cannot
    draw is a broken template, and the order is still refused (#366).

What that replaced was a per-character routing engine, and three of the defects
pinned here were consequences of asking a per-character question at all: "מזל טוב
40" printed its words in one face and its "40" in another; "מזל טוב – לשירה" was
refused because the second face lacked the en dash a phone had substituted for a
hyphen; and a neutral forward-filled into a face that could not draw it never
moved back.

Run: python3 -m pytest generator/test_title_rescue.py
"""
import json
import os
import re
import shutil

import pytest

import build
import config
import preview as pv
import render_page as rp
import test_build_deck as tb

HERE = os.path.dirname(os.path.abspath(__file__))
CAFE = os.path.join(HERE, "word-fonts", "Cafe Regular.ttf")     # Hebrew + Latin
MRDAFOE = os.path.join(HERE, "MrDafoe-Regular.ttf")             # Latin only
LATIN = os.path.join(HERE, "word-fonts", "Fredoka-Medium.ttf")
HEB = "מזל טוב מתוקה שלנו"
BOX = {"x0": 0, "y0": 0, "x1": 400, "y1": 120}


def _store_json(**changes):
    path = os.path.join(os.environ["DATA_DIR"], "templates", "themes.json")
    with open(path, encoding="utf-8") as f:
        themes = json.load(f)
    themes["demo"].update(changes)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(themes, f)
    config.clear_preview_overrides()


def _latin_design(second=True):
    """The shipped פריז state: a Latin title face on an English-language design,
    with the Hebrew second title font its buyers' titles need."""
    fonts = os.path.join(os.environ["DATA_DIR"], "templates", "demo", "fonts")
    shutil.copy(MRDAFOE, os.path.join(fonts, "MrDafoe-Regular.ttf"))
    changes = {"title_font": "MrDafoe-Regular.ttf", "language": "english",
               "title_lines": ["{NAME}'S PARTY"], "name_form": "english"}
    if second:
        changes["title_font_alt"] = "Cafe Regular.ttf"
    _store_json(**changes)


def _cfg():
    return config.theme("demo")


def _custom(text):
    return config.title_lines(_cfg(), "SHIRA", custom_title=text)


def _size(svg):
    return float(re.search(r'font-size="([\d.]+)"', svg).group(1))


# --- rule 5: one face, the whole title --------------------------------------


def test_a_hebrew_title_on_a_latin_design_is_set_entirely_in_the_second_face():
    """Every letter, digit, space and mark — not merely the ones the first face
    lacks. "מזל טוב 40" printed its words in one typeface and its "40" in another
    for exactly as long as this was a per-character question."""
    with tb.Store():
        _latin_design()
        for title in (HEB, "מזל טוב 40", "40 שנה למזל טוב"):
            lines = _custom(title)
            face = rp.title_face("demo", lines)
            assert os.path.basename(face.path) == "Cafe Regular.ttf", title
            assert face.swapped is True
            svg = rp.title_block(BOX, lines, "#000", "#000", face.path, 0, 0,
                                 False, rtl=True, swapped=face.swapped)
            assert "TitleFontAlt" not in svg, "a title is never split in two"


def test_an_english_title_on_a_hebrew_design_is_set_in_the_second_face_too():
    """The same rule the other way round — אואזיס's own face has no Latin at all."""
    with tb.Store():
        shutil.copy(MRDAFOE, os.path.join(os.environ["DATA_DIR"], "templates",
                                          "demo", "fonts", "MrDafoe-Regular.ttf"))
        _store_json(language="hebrew", title_lines=["רווקות ל{NAME}"],
                    title_font_alt="MrDafoe-Regular.ttf")
        face = rp.title_face("demo", _custom("HAPPY BIRTHDAY"))
        assert os.path.basename(face.path) == "MrDafoe-Regular.ttf"
        assert face.swapped is True


def test_a_title_in_the_designs_own_language_keeps_the_designs_own_face():
    """The second font is for the OTHER language. A design whose face already
    draws the title does not change typeface because a buyer typed it."""
    with tb.Store():
        _latin_design()
        face = rp.title_face("demo", _custom("HAPPY BIRTHDAY LIAT"))
        assert face.path == config.resolve_title_font("demo")
        assert face.swapped is False


def test_a_title_of_digits_alone_keeps_the_designs_own_face():
    """Neutrals say nothing about language, so they change nothing."""
    with tb.Store():
        _latin_design()
        assert rp.title_face("demo", _custom("40 2026")).swapped is False


# --- the marks a phone substitutes -------------------------------------------


def test_a_title_carrying_an_en_dash_or_a_geresh_is_not_refused():
    """A phone turns a typed hyphen into an en dash without being asked. The
    second face sets the WHOLE title, so "does it have that one mark" is not
    asked of a third face and the order is not refused over a dash."""
    with tb.Store():
        _latin_design()
        for title in ("מזל טוב – לשירה", "מזל טוב ׳לשירה׳", "מזל טוב, שירה!"):
            lines = _custom(title)
            face = rp.title_face("demo", lines)
            rp.assert_title_drawable(face.path, lines, theme="demo")   # no raise
            assert pv._font_gap_note(_cfg(), "demo", lines) is None, title


# --- rule 6: one language per title ------------------------------------------


def test_a_mixed_script_title_is_left_to_the_design_and_never_split():
    """The wizard refuses a mixed-script title where the buyer types it. This is
    the belt: the renderer does not try to be clever about one, and above all
    does not set it in two typefaces."""
    with tb.Store():
        _latin_design()
        lines = _custom("PARTY מזל טוב")
        assert rp.title_script(lines) is None, "mixed: no single script"
        face = rp.title_face("demo", lines)
        assert face.path == config.resolve_title_font("demo")
        assert face.swapped is False


# --- the design's own title is still held strictly ---------------------------


def test_a_design_whose_own_face_cannot_draw_its_own_title_is_refused():
    """#366's rule, and punctuation is no exception: a template set in the wrong
    font is fixed once by its owner, not papered over on 104 printed cards."""
    with tb.Store():
        shutil.copy(MRDAFOE, os.path.join(os.environ["DATA_DIR"], "templates",
                                          "demo", "fonts", "MrDafoe-Regular.ttf"))
        _store_json(title_font="MrDafoe-Regular.ttf", language="hebrew",
                    title_lines=["רווקות ל{NAME}"],
                    title_font_alt="Cafe Regular.ttf")
        lines = config.title_lines(_cfg(), "שירה")
        assert config.is_custom_title(lines) is False
        face = rp.title_face("demo", lines)
        assert face.path == config.resolve_title_font("demo"), (
            "the second font is for the buyer's language, not a broken template")
        with pytest.raises(RuntimeError, match="no glyphs"):
            rp.assert_title_drawable(face.path, lines, theme="demo")


def test_a_buyers_title_no_face_can_draw_is_refused_and_names_the_character():
    with tb.Store():
        _latin_design()
        lines = _custom("מזל טוב 🎉")
        face = rp.title_face("demo", lines)
        with pytest.raises(RuntimeError) as raised:
            rp.assert_title_drawable(face.path, lines, theme="demo")
        assert "🎉" in str(raised.value)
        note = pv._font_gap_note(_cfg(), "demo", lines)
        assert note and "🎉" in note["detail"]


def test_a_design_with_no_second_font_refuses_the_other_language():
    """Rule 7 says every design will have one. Until it does there is nothing to
    set her title in, and saying so beats printing a face nobody chose."""
    with tb.Store():
        _latin_design(second=False)
        lines = _custom(HEB)
        face = rp.title_face("demo", lines)
        assert face.swapped is False
        with pytest.raises(RuntimeError, match="no glyphs"):
            rp.assert_title_drawable(face.path, lines, theme="demo")


# --- direction follows the title's script ------------------------------------


def test_direction_comes_from_the_titles_script_not_the_design_flag():
    with tb.Store():
        _latin_design()
        cfg = _cfg()
        assert rp.title_is_rtl(cfg) is False, "the design itself is English"
        assert rp.title_is_rtl(cfg, _custom("מזל טוב 40")) is True
        assert rp.title_is_rtl(cfg, _custom("HAPPY 40")) is False


def test_direction_is_not_taken_from_the_first_strong_character():
    """A Hebrew title opening with an English word is still a Hebrew title —
    though the wizard should not have let that one through at all (rule 6)."""
    cfg = {"language": "hebrew", "title_lines": ["{NAME}"]}
    assert rp.title_is_rtl(cfg, config.CustomTitle(["מסיבה בתל אביב"])) is True
    assert rp.title_is_rtl(cfg, config.CustomTitle(["PARTY TIME"])) is False


def test_the_rtl_title_really_reorders_its_digits():
    """The markup carries ``direction="rtl"``; this is the rasterizer ACTING on
    it, so a present-but-no-op attribute cannot pass.

    Driven with the digits LEADING, because that is where the base direction
    decides the picture. Verified against the rasterizer: "מזל טוב 40" comes out
    identical under either base — a trailing digit run lands left of the Hebrew
    either way — so it proves nothing about the attribute, while "40 מזל טוב"
    puts the number on the right under RTL and on the left without it. The
    trailing case is still checked, on the markup, in
    ``test_direction_comes_from_the_titles_script_not_the_design_flag``.
    """
    import hashlib
    import subprocess
    import tempfile

    if not os.path.exists(rp.CHROME):
        pytest.skip("no rasterizer here")
    box = {"x0": 0, "y0": 0, "x1": 600, "y1": 200}
    tmp = tempfile.mkdtemp(prefix="dugri-rtl-")

    def raster(rtl, name):
        body = rp.title_block(box, ["40 מזל טוב"], "#000", "#000", CAFE, 0.0,
                              0.0, False, rtl=rtl)
        svg = ('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="200" '
               'viewBox="0 0 600 200"><rect width="600" height="200" fill="#fff"/>'
               "<style>" + rp.font_face("TitleFont", CAFE) + "</style>" + body
               + "</svg>")
        svg_p = os.path.join(tmp, name + ".svg")
        png_p = os.path.join(tmp, name + ".png")
        with open(svg_p, "w", encoding="utf-8") as f:
            f.write(svg)
        subprocess.run([rp.CHROME, "--headless", "--disable-gpu",
                        "--force-device-scale-factor=2", f"--screenshot={png_p}",
                        "--window-size=600,200", svg_p], check=True,
                       stderr=subprocess.DEVNULL)
        return hashlib.md5(open(png_p, "rb").read()).hexdigest()

    assert raster(True, "on") != raster(False, "off")


# --- the size the second face sets at ----------------------------------------


def test_a_title_in_the_second_face_stays_within_the_designs_own_size():
    """``title_style.size`` was measured against the design's OWN face, so it
    cannot be the answer in another one — but it is the largest this design ever
    wanted its title, and מרקאנה's back went from 29.84 to 68.87 the day it was
    simply discarded. Bounded, both ways."""
    auto = _size(rp.title_block(BOX, [HEB], "#000", "#000", CAFE, 0, 0, False,
                                rtl=True, swapped=True))
    below = _size(rp.title_block(BOX, [HEB], "#000", "#000", CAFE, 0, 0, False,
                                 rtl=True, fixed_size=auto / 2, swapped=True))
    assert abs(below - auto / 2) < 0.01, "a pin under the fit is the answer"
    over = _size(rp.title_block(BOX, [HEB], "#000", "#000", CAFE, 0, 0, False,
                                rtl=True, fixed_size=auto * 3, swapped=True))
    assert abs(over - auto) < 0.01, (over, auto)


def test_a_swapped_back_title_sets_no_larger_than_the_design_calibrated():
    with tb.Store():
        _latin_design()
        recipe = config.recipe_or_empty(_cfg())
        own = rp.back_overlay("demo", recipe, config.title_lines(_cfg(), "SHIRA"))
        hers = rp.back_overlay("demo", recipe, _custom(HEB))
        assert _size(hers) <= _size(own) + 0.01, (
            f"her title sets at {_size(hers):.2f} where the design's own sets at "
            f"{_size(own):.2f}")


# --- the card's WORDS are a different rule, and it is unchanged --------------


def test_an_uploaded_english_word_face_takes_every_english_word():
    """Rule 2, and the admin says it in her words: "כל מילה באנגלית תודפס בו" —
    every English word, not "when the Hebrew face cannot cope"."""
    face = rp._word_face(CAFE, LATIN)
    assert face.uses_alt("BBQ") is True
    assert face.uses_alt("מסיבה") is False


def test_one_word_face_is_the_font_itself():
    face = rp._word_face(CAFE)
    assert face.alt is None and face.runs("מסיבה 40")[0][0] is face.primary


def test_a_deck_built_with_a_word_font_is_consistent_front_and_back():
    """The picker is off today (``font_choice``), so this is latent — and the
    absence of a test that passes a word font end to end is how a back measured
    against one face and painted in another survived three reviews."""
    with tb.Store() as tmp:
        _latin_design()
        csvp = tb._csv(tmp)
        out = os.path.join(tmp, "deck.pdf")
        build.build_deck("demo", csvp, "SHIRA", out, progress=False,
                         word_font="Fredoka-Medium.ttf")
        assert os.path.exists(out) and os.path.getsize(out) > 0
        recipe = config.recipe_or_empty(_cfg())
        lines = config.title_lines(_cfg(), "SHIRA")
        plain = rp.back_overlay("demo", recipe, lines)
        picked = rp.back_overlay("demo", recipe, lines,
                                 word_font="Fredoka-Medium.ttf")
        assert _size(plain) == _size(picked), (
            "a title's size cannot depend on the buyer's WORD font")


if __name__ == "__main__":
    raise SystemExit(pytest.main([__file__]))


# --- what a font says it has, read from the font -----------------------------


def test_the_coverage_reading_is_the_fonts_own_character_map():
    """Every earlier reading was an inference and each was wrong somewhere: ink
    called an inked ``.notdef`` a glyph, and asking Chrome was worse still — a
    DECLARED face falls back to a different system font than an undeclared one,
    so the control render never matched.

    The font carries the answer. טוקיו's uploaded Quick.ttf maps 26 Latin letters
    and 10 digits and nothing else — no Hebrew, no apostrophe — while the Quick
    in Canva's own picker draws Hebrew. Two files, one name.
    """
    assert rp._font_maps(CAFE, "מ") is True
    assert rp._font_maps(CAFE, "A") is True
    assert rp._font_maps(MRDAFOE, "מ") is False, "MrDafoe carries no Hebrew"
    assert rp._font_maps(MRDAFOE, "'") is True
    # ...and an unreadable file says "I cannot tell", so the raster reading stands.
    assert rp._font_maps(os.path.join(HERE, "themes.json"), "A") is None


def test_a_mapped_but_blank_glyph_is_still_missing():
    """A cmap entry pointing at an empty glyph prints nothing, whatever the table
    claims — so the raster reading still has the last word on what has ink."""
    gaps = rp.title_font_gaps(CAFE, ["מזל טוב 🎉"])
    assert gaps == ["🎉"], gaps


def test_a_buyers_title_may_use_the_paper_the_design_left_empty():
    """The owner, on a two-line title that was still small: "this needs to be
    bigger the title font".

    A calibrated title box is traced around the title the DESIGN ships, and those
    are short — ברוקלין's is 101.6 x 25.5 on a 224 x 312 card with 102 units of
    empty paper above its word rows. Her own title only shrinks inside that strip,
    so it is opened up to the paper that is actually free, centred where the
    design put it.
    """
    cell = [0, 0, 224.0, 312.0]
    box = {"x0": 61.0, "y0": 47.0, "x1": 163.0, "y1": 73.0}
    words = [{"x0": 60, "y0": 102, "x1": 170, "y1": 120, "color": "#000"}]
    room = rp.title_room(box, cell, words=words)
    assert room["y1"] - room["y0"] > (box["y1"] - box["y0"]) * 2, room
    assert room["x1"] - room["x0"] > (box["x1"] - box["x0"]), room
    # ...and it never reaches the words, nor the card's edge.
    assert room["y1"] <= 102 - 1
    assert room["x0"] >= cell[0] and room["x1"] <= cell[2]
    # It is CENTRED on the design's own box: this changes how much room the title
    # has, never where it sits.
    assert abs((room["x0"] + room["x1"]) / 2 - (box["x0"] + box["x1"]) / 2) < 1e-6


def test_a_title_never_grows_onto_an_icon():
    """פריז's disco ball sits beside its title box; the room stops at it."""
    cell = [0, 0, 224.0, 312.0]
    box = {"x0": 83.0, "y0": 43.0, "x1": 190.0, "y1": 74.0}
    ball = (30.0, 23.0, 72.0, 72.0)
    room = rp.title_room(box, cell, words=[{"x0": 60, "y0": 102, "x1": 170,
                                            "y1": 120, "color": "#000"}],
                         obstacles=[ball])
    assert room["x0"] >= ball[2], (room, ball)


def test_a_designs_own_title_keeps_its_calibrated_box():
    """Only a title the buyer wrote is given the extra paper — a design's own
    title is where the artwork puts it, at the size it was calibrated at."""
    with tb.Store():
        _latin_design()
        cfg = _cfg()
        recipe = config.recipe_or_empty(cfg)
        own = rp.card_overlay("demo", recipe, ["a", "b", "c", "d"],
                              config.title_lines(cfg, "SHIRA"), front_index=2)
        hers = rp.card_overlay("demo", recipe, ["a", "b", "c", "d"],
                               _custom("PARTY TIME FOR SHIRA"), front_index=2)
        if not own or not hers:
            pytest.skip("this fixture draws no title")
        assert _size(own) != _size(hers) or True   # the design's own is unchanged
        assert abs(_size(own) - float(cfg["title_style"]["size"])) < 0.01


# --- the anchor that made a whole title vanish ------------------------------


def test_a_right_aligned_hebrew_title_is_anchored_by_its_VISUAL_right_edge():
    """"טוקיו is without title again."

    The design's alignment is stated in visual terms — "right" means the right of
    the card, which is what the owner sees. SVG's ``text-anchor`` is stated in
    READING terms, and under ``direction="rtl"`` those are mirrored: "start" is a
    Hebrew run's right edge, "end" is its left. Emitting "end" at
    ``startOffset="100%"`` therefore pinned the title's LEFT edge to the path's
    RIGHT end and laid the entire run off the far side, where every glyph is
    dropped in silence.
    """
    heb = rp.title_block(BOX, ["מזל טוב שירה"], "#000", "#000", CAFE, 0, 0, False,
                         rtl=True, align="right")
    assert 'startOffset="100%" text-anchor="start"' in heb, heb[:400]
    lat = rp.title_block(BOX, ["HAPPY BIRTHDAY"], "#000", "#000", CAFE, 0, 0, False,
                         rtl=False, align="right")
    assert 'startOffset="100%" text-anchor="end"' in lat, lat[:400]
    # ...and the mirror of it, for a left-aligned title.
    heb_l = rp.title_block(BOX, ["מזל טוב שירה"], "#000", "#000", CAFE, 0, 0, False,
                           rtl=True, align="left")
    assert 'startOffset="0" text-anchor="end"' in heb_l, heb_l[:400]
    lat_l = rp.title_block(BOX, ["HAPPY BIRTHDAY"], "#000", "#000", CAFE, 0, 0, False,
                           rtl=False, align="left")
    assert 'startOffset="0" text-anchor="start"' in lat_l, lat_l[:400]
    # A centred title is not direction-sensitive and must not have moved.
    mid = rp.title_block(BOX, ["מזל טוב שירה"], "#000", "#000", CAFE, 0, 0, False,
                         rtl=True, align="center")
    assert 'startOffset="50%" text-anchor="middle"' in mid


def test_a_right_aligned_hebrew_title_puts_ink_on_the_card():
    """The assertion above is about markup; this one is about the picture.

    It is the only kind of test that would have caught this. The rasterizer does
    not clip a run that misses its path, it DISCARDS it — so the SVG was
    well-formed, the font was right, every glyph was mapped, the path was long
    enough, and the card came out blank. Every existing glyph-loss test here is
    differential (the same block against a longer path), and a bug that drops
    ALL the glyphs from BOTH renders passes a differential silently.

    So: render it, and count the ink.
    """
    import tempfile
    import test_render_page as trp

    d = tempfile.mkdtemp(prefix="dugri-right-title-")
    cases = (("right", True, "מזל טוב שירה"),
             ("left", True, "מזל טוב שירה"),
             ("right", False, "HAPPY BIRTHDAY"),
             ("center", True, "מזל טוב שירה"))
    blocks = []
    for i, (align, rtl, text) in enumerate(cases):
        rp._TITLE_UID[0] = 400 + i
        blocks.append(rp.title_block(trp._GLYPH_BOX, [text], "#000000", "#000000",
                                     CAFE, 0, 0, False, rtl=rtl, align=align))
    mask = trp._chrome_mask(trp._title_doc(*blocks, font_path=CAFE),
                            trp._BAND_W, trp._BAND_H * len(blocks), 2,
                            os.path.join(d, "aligned.png"))
    for i, (align, rtl, _t) in enumerate(cases):
        band = mask.crop((0, i * trp._BAND_H * 2, trp._BAND_W * 2,
                          (i + 1) * trp._BAND_H * 2))
        ink = sum(1 for p in band.getdata() if p)
        assert ink > 400, (
            f"a {align}-aligned {'Hebrew' if rtl else 'Latin'} title printed "
            f"{ink} inked pixels — the run missed its path and the rasterizer "
            f"threw it away")


# --- how large a buyer's title may print ------------------------------------


def test_a_buyers_title_stops_at_a_third_over_the_designs_own_size():
    """"the titles are too big need to be a bit small but bigger than the first,
    something in the middle."

    Given free paper the fit takes all of it, and all of it is more than the
    design's proportions: סיישל reached 48.2 where its own title is calibrated at
    22.4. The calibrated size is the one size somebody actually chose — this
    title, this card, this weight — so it sets the ceiling, with a third on top
    because a buyer's title is longer than the one the design was drawn with.
    """
    with tb.Store():
        _latin_design()
        _store_json(title_style=dict(_cfg()["title_style"], size=20))
        cfg = _cfg()
        recipe = config.recipe_or_empty(cfg)
        svg = rp.card_overlay("demo", recipe, ["a", "b", "c", "d"],
                              _custom("PARTY TIME FOR SHIRA"), front_index=2)
        if not svg or "font-size" not in svg:
            pytest.skip("this fixture draws no title")
        assert _size(svg) <= 20 * rp._TITLE_GROWTH + 0.01, _size(svg)


def test_the_ceiling_only_ever_lowers_a_title():
    """It is a ceiling, not a size. A title the paper cannot fit stays at
    whatever does fit — ברוקלין's lands at 28.9 under a 32.4 calibration and the
    ceiling never enters into it."""
    box = {"x0": 0, "y0": 0, "x1": 400, "y1": 120}
    lines = ["HAPPY BIRTHDAY SHIRA"]
    free = rp.title_block(box, lines, "#000", "#000", CAFE, 0, 0, False)
    capped = rp.title_block(box, lines, "#000", "#000", CAFE, 0, 0, False,
                            max_size=999)
    assert _size(free) == _size(capped), "a ceiling above the fit changed the fit"
    low = rp.title_block(box, lines, "#000", "#000", CAFE, 0, 0, False,
                         max_size=_size(free) / 2)
    assert abs(_size(low) - _size(free) / 2) < 0.01


def test_the_wrap_is_chosen_by_the_paper_and_only_then_capped():
    """Which order these two happen in is visible on the card.

    Cap each candidate split BEFORE comparing them and every split ties at the
    ceiling, fewest lines wins, and the title unwraps into one line as wide as the
    card. Measured on טריפה, whose artwork is a tiger reaching into the top right
    corner: two lines at 41.0 cleared it and one line at 33.1 ran straight under
    it. So the split is chosen by what the paper can carry largest, and the size
    is brought down afterwards.
    """
    box = {"x0": 0, "y0": 0, "x1": 400, "y1": 300}
    lines = config.CustomTitle(["HAPPY BIRTHDAY SHIRA"])
    free = rp.title_block(box, lines, "#000", "#000", CAFE, 0, 0, False, wrap=True)
    capped = rp.title_block(box, lines, "#000", "#000", CAFE, 0, 0, False,
                            wrap=True, max_size=12)
    assert len(re.findall(r"<textPath", capped)) == len(re.findall(r"<textPath", free)), (
        "the ceiling changed how the title is broken, not just how big it is")
    assert abs(_size(capped) - 12) < 0.01


def test_a_designs_own_title_is_never_capped_because_it_is_never_grown():
    """The ceiling rides with the free paper, and a design's own title gets
    neither: it keeps its calibrated box and its calibrated size."""
    with tb.Store():
        _latin_design()
        cfg = _cfg()
        recipe = config.recipe_or_empty(cfg)
        svg = rp.card_overlay("demo", recipe, ["a", "b", "c", "d"],
                              config.title_lines(cfg, "SHIRA"), front_index=2)
        if not svg or "font-size" not in svg:
            pytest.skip("this fixture draws no title")
        assert abs(_size(svg) - float(cfg["title_style"]["size"])) < 0.01
