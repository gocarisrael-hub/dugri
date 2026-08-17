#!/usr/bin/env python3
"""Tests for PER-BACK calibration: a deck whose eight styles each have own back.

#315 gave such a template its eight backs (files 10-17, positionally paired with
the fronts) and the render path to print them. What it could not do was say WHERE
the honoree's name goes on each: the calibration pass measured one back, and
``back_overlay`` stamped that single answer onto every back in the deck. Since
each back is separate artwork, the name may sit somewhere else on each — or on
none of them — so one shared answer misplaces it on seven cards in eight, on a
paid order, with no error to say so.

What these pin:

  * each back is overlaid with ITS OWN calibrated box, not the first one's;
  * a per-back ``null`` is an ANSWER ("this back carries no title") and prints
    nothing, exactly as an explicit null ``back`` already did;
  * a per-back entry OUTRANKS the recipe's shared ``back``, which a converted
    template keeps from artwork that is no longer what gets printed;
  * a template with no ``backs`` key renders byte-identically to before, which is
    every template that predates pairing;
  * each back may pin its own title size, since eight separately drawn backs give
    the title eight differently sized rooms.

Run: python3 -m pytest generator/test_calibrate_backs.py
"""
import json
import os
import re

import build
import config
import render_page as rp
from test_build_deck import Store, _csv

BACKS = [10, 11, 12, 13, 14, 15, 16, 17]


def _themes_path():
    return os.path.join(os.environ["DATA_DIR"], "templates", "themes.json")


def _recipe_path():
    return os.path.join(os.environ["DATA_DIR"], "templates", "recipes", "demo.json")


def _patch_theme(**keys):
    """Merge keys into the demo theme entry on disk and drop any config cache."""
    with open(_themes_path(), encoding="utf-8") as f:
        themes = json.load(f)
    themes["demo"].update(keys)
    with open(_themes_path(), "w", encoding="utf-8") as f:
        json.dump(themes, f)
    config.clear_preview_overrides()
    return themes["demo"]


def _patch_recipe(**keys):
    with open(_recipe_path(), encoding="utf-8") as f:
        recipe = json.load(f)
    recipe.update(keys)
    with open(_recipe_path(), "w", encoding="utf-8") as f:
        json.dump(recipe, f)
    return recipe


def _recipe():
    with open(_recipe_path(), encoding="utf-8") as f:
        return json.load(f)


def _slot(y0, y1, fill="#fff", outline="#000", size=None):
    slot = {"frac": {"x0": 0.1, "y0": y0, "x1": 0.9, "y1": y1},
            "fill": fill, "outline": outline}
    if size is not None:
        slot["size"] = size
    return slot


def _norm(overlay):
    """An overlay with its generated element ids masked out.

    Every call bumps a global counter for the arc-path ids (``t1s0``, ``t2s0``,
    …), so two renders of the SAME geometry differ by the ids alone. What these
    tests are about is where the title lands, so the ids are noise.
    """
    return re.sub(r'\bt\d+([sm])\d+\b', r't\1', overlay)


def _sizes(overlay):
    """The font sizes the overlay paints at."""
    return sorted(set(re.findall(r'font-size="([\d.]+)"', overlay)))


# --- each back gets its own box ---------------------------------------------

def test_each_back_is_overlaid_with_its_own_calibrated_box():
    with Store(backs=BACKS):
        # Two backs whose title boxes are nowhere near each other. If the shared
        # answer were still being used, both overlays would come out identical.
        _patch_theme(backs={"10": _slot(0.05, 0.20), "11": _slot(0.70, 0.90)})
        _patch_recipe(back=None)
        recipe = _recipe()
        first = rp.back_overlay("demo", recipe, ["שירה"], back_index=10)
        second = rp.back_overlay("demo", recipe, ["שירה"], back_index=11)
        assert first and second, "both backs carry a title, so both must print"
        assert _norm(first) != _norm(second), (
            "each back's title must land in ITS OWN box — identical overlays mean "
            "one back's calibration was stamped onto the other"
        )


def test_a_null_per_back_entry_prints_nothing_on_that_back():
    with Store(backs=BACKS):
        _patch_theme(backs={"10": _slot(0.4, 0.6), "11": None})
        _patch_recipe(back=None)
        recipe = _recipe()
        assert rp.back_overlay("demo", recipe, ["שירה"], back_index=10), (
            "back 10 carries a title and must print it"
        )
        assert rp.back_overlay("demo", recipe, ["שירה"], back_index=11) == "", (
            "a null per-back entry means that artwork has no text slot; printing "
            "the name there would deface every card that carries this back"
        )


def test_an_unlisted_back_falls_back_to_the_shared_answer():
    with Store(backs=BACKS):
        # Only back 10 was measured; 12 was not, so it takes the deck's `back`.
        _patch_theme(backs={"10": _slot(0.05, 0.20)})
        _patch_recipe(back=None)
        recipe = _recipe()
        unlisted = rp.back_overlay("demo", recipe, ["שירה"], back_index=12)
        shared = rp.back_overlay("demo", recipe, ["שירה"], back_index=None)
        assert _norm(unlisted) == _norm(shared), (
            "a back nobody has measured yet must fall through to the deck-wide "
            "answer, not to another back's box"
        )


def test_a_per_back_entry_outranks_the_recipes_shared_null_back():
    with Store(backs=BACKS):
        # A converted template keeps the `back: null` its OLD artwork was
        # detected against. That answer is not about the card now being printed,
        # so a back calibrated since must win — otherwise re-calibrating a
        # converted template silently changes nothing.
        _patch_theme(backs={"10": _slot(0.3, 0.5)})
        _patch_recipe(back=None)
        assert rp.back_overlay("demo", _recipe(), ["שירה"], back_index=10), (
            "a back calibrated after conversion must print, even though the "
            "recipe still carries the pre-conversion `back: null`"
        )


def test_the_owners_back_box_outranks_the_one_detection_traced():
    """Her box is the answer; the recipe is what the picture used to look like.

    Detection traces where the ORIGIN's own back title sat — often line by line,
    tight around a short name. The owner then draws the room she wants the title
    to have, and on קליפורניה the deck ignored it: 10.1 of type inside a 95-unit
    traced box while her box, 156 wide, had 16.6 to give. Fronts have always
    preferred her boxes (config.card_title_boxes); backs now do too.
    """
    with Store(backs=BACKS):
        # Auto-fit, so the BOX is what decides the size — a pin would answer
        # for it and the two boxes would print identically.
        _patch_theme(title_style={"fill": "#fff", "outline": "#000",
                                  "outline_w": 0.05, "arch": 0.06, "shadow": True},
                     back=_slot(0.10, 0.90))          # hers: most of the card
        _patch_recipe(back={"title": [{"x0": 90.0, "y0": 140.0,
                                       "x1": 130.0, "y1": 160.0}]})   # traced: tiny
        def span(overlay):
            """How wide the room the title was given is, in card units."""
            m = re.search(r'd="M ([-0-9.]+) [-0-9.]+ Q [-0-9.]+ [-0-9.]+ '
                          r'([-0-9.]+) ', overlay)
            return float(m.group(2)) - float(m.group(1))

        hers = rp.back_overlay("demo", _recipe(), ["שירה"], back_index=None)
        assert hers, "the back carries a title and must print it"
        _patch_theme(back=None)
        traced = rp.back_overlay("demo", _recipe(), ["שירה"], back_index=None)
        assert span(hers) > span(traced) * 1.5, (
            f"her box gives the title {span(hers):.1f} units of room and the "
            f"traced one {span(traced):.1f} — the back is still being set to "
            "artwork nobody is printing")


def test_a_per_back_size_pins_that_backs_title():
    with Store(backs=BACKS):
        _patch_theme(backs={"10": _slot(0.3, 0.5, size=7),
                            "11": _slot(0.3, 0.5, size=31)})
        _patch_recipe(back=None)
        recipe = _recipe()
        small = rp.back_overlay("demo", recipe, ["שירה"], back_index=10)
        large = rp.back_overlay("demo", recipe, ["שירה"], back_index=11)
        assert _sizes(small) == ["7.00"], (
            "back 10 pins size 7; the same box at two pinned sizes must render at "
            f"each of them. got: {_sizes(small)}"
        )
        assert _sizes(large) == ["31.00"], (
            f"back 11 pins size 31. got: {_sizes(large)}"
        )


# --- the shared-back deck is untouched --------------------------------------

def test_a_template_with_no_backs_key_renders_exactly_as_before():
    with Store():
        recipe = _recipe()
        # No `backs` on the entry and no index passed: the pre-#315 call shape.
        before = rp.back_overlay("demo", recipe, ["שירה"])
        # The same deck, now naming the back it is drawing — the shared-back deck
        # is the degenerate pairing, so the answer must not move.
        after = rp.back_overlay("demo", recipe, ["שירה"], back_index=1)
        assert _norm(before) == _norm(after), (
            "naming the back must not change what a one-back deck prints"
        )
        assert before, "the demo theme has a back title, so it must print one"


def test_an_explicit_null_back_still_prints_nothing_when_uncalibrated():
    with Store():
        _patch_recipe(back=None)
        assert rp.back_overlay("demo", _recipe(), ["שירה"], back_index=1) == "", (
            "with no per-back calibration, an explicit null back keeps meaning "
            "'this artwork has no text slot'"
        )


# --- the deck path uses them ------------------------------------------------

def test_the_deck_gives_each_back_its_own_overlay():
    with Store(backs=BACKS) as tmp:
        _patch_theme(backs={str(n): _slot(0.05 + i * 0.09, 0.14 + i * 0.09)
                            for i, n in enumerate(BACKS)})
        _patch_recipe(back=None)
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        # Collect the overlay actually emitted for each distinct back design.
        by_back = {}
        for design, overlay in doc._pages:
            if design.startswith("back"):
                by_back.setdefault(design, set()).add(_norm(overlay))
        assert len(by_back) == len(BACKS), (
            f"the deck must print all {len(BACKS)} backs, got {sorted(by_back)}"
        )
        for design, overlays in by_back.items():
            assert len(overlays) == 1, f"{design} must always carry the same title box"
        distinct = {next(iter(v)) for v in by_back.values()}
        assert len(distinct) == len(BACKS), (
            "each back was calibrated to a different box, so the deck must emit a "
            "different overlay for each — one repeated overlay is the bug this "
            "guards: the name in the wrong place on seven cards in eight"
        )


def test_a_shared_back_deck_still_emits_one_repeated_overlay():
    with Store() as tmp:
        doc, _ = build.deck_document("demo", _csv(tmp), ["שירה"])
        overlays = {_norm(overlay) for design, overlay in doc._pages
                    if design.startswith("back")}
        assert len(overlays) == 1, (
            "a one-back deck has exactly one back and one answer for it"
        )


if __name__ == "__main__":
    import pytest
    raise SystemExit(pytest.main([__file__, "-q"]))
