#!/usr/bin/env python3
"""Tests for the v2 (single-card deck) accessors in generator/config.py.

These pin the CONTRACT the asset migration, the calibrator and the renderer all
code against — docs/card-structure-schema.md 2-3 and docs/photo-card.md — in
both the canonical nested ``cards`` shape and the flat shape this file first
shipped, because entries written against the flat one are already in flight.

Everything here works on temp dirs and a temp catalog: no test may depend on
which templates happen to be checked in, least of all on the shared photo-card
artwork, which ships on its own branch.

Run: python3 generator/test_config_v2.py   (or via pytest)
"""
import json
import os
import shutil
import tempfile

import config


# ---- fixtures ---------------------------------------------------------------


def _cards_cfg(**kw):
    """A theme entry in the CANONICAL shape (deck keys nested under ``cards``)."""
    cards = {"back": 1, "fronts": [2, 3, 4, 5, 6, 7, 8, 9]}
    cards.update(kw)
    return {"slug": "t", "cards": cards}


def _flat_cfg(**kw):
    """A theme entry in the LEGACY flat shape (card_layout/fronts/back_index)."""
    cfg = {"slug": "t", "card_layout": "single", "fronts": [2, 3, 4, 5, 6, 7, 8, 9],
           "back_index": 1}
    cfg.update(kw)
    return cfg


def _box(x0, y0, x1=200.0, y1=40.0, color="#711d20"):
    return {"x0": x0, "y0": y0, "x1": x1, "y1": y1, "color": color}


def _recipe_v2(title=None, back="omit", photo=None, words=None):
    """A recipe in the canonical v2 shape (format 2, one card, per-front titles).

    ``back`` defaults to the sentinel rather than to None so a test can tell the
    key being ABSENT apart from it being explicitly null — both must mean "this
    back has no text slot", and the difference must not matter.
    """
    recipe = {
        "theme": "grapefruit",
        "format": 2,
        "viewBox": [0.0, 0.0, 223.92, 312.0],
        "card": {
            "cell": [0.0, 0.0, 223.92, 312.0],
            "words": words if words is not None else [
                _box(20.0, 140.0 + i * 30.0) for i in range(4)],
        },
    }
    if title is not None:
        recipe["card"]["title"] = title
    if back != "omit":
        recipe["back"] = back
    if photo is not None:
        recipe["photo"] = {"slots": photo}
    return recipe


def _recipe_v1():
    """A v1 8-up sheet recipe: eight cells under ``cards`` (plural, a LIST)."""
    return {"theme": "trip", "viewBox": [0, 0, 841.92, 595.5],
            "cards": [{"cell": [9.7, 10.5, 200.2, 286.4], "words": []}] * 8}


class Store:
    """A throwaway catalog: temp image REPO + temp DATA_DIR volume + temp _shared.

    Both halves of the overlay are temporary, and so is the shared artwork tree,
    so photo-card resolution can be tested step by step without any file that is
    (or is not yet) checked in changing the answer. Everything the module reads
    from the environment or from module state is restored on exit.
    """

    def __init__(self, shipped=None, owner=None):
        self.shipped = shipped or {}
        self.owner = owner

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="dugri-cfg-v2-")
        self.repo = os.path.join(self.tmp, "repo")
        self.data = os.path.join(self.tmp, "data")
        os.makedirs(os.path.join(self.data, "templates"))
        os.makedirs(os.path.join(self.repo, "resources", "canva", "templates"))

        self.shipped_json = os.path.join(self.tmp, "shipped-themes.json")
        with open(self.shipped_json, "w", encoding="utf-8") as f:
            json.dump(self.shipped, f)
        if self.owner is not None:
            with open(os.path.join(self.data, "templates", "themes.json"), "w",
                      encoding="utf-8") as f:
                json.dump(self.owner, f)

        self.saved = {
            "DATA_DIR": os.environ.get("DATA_DIR"),
            "THEMES_JSON": config.THEMES_JSON,
            "REPO": config.REPO,
            "SHARED": config.SHARED_TEMPLATES_DIR,
            "GENERIC": config.GENERIC_PHOTO_CARD,
        }
        os.environ["DATA_DIR"] = self.data
        config.THEMES_JSON = self.shipped_json
        config.REPO = self.repo
        config.SHARED_TEMPLATES_DIR = os.path.join(
            self.repo, "resources", "canva", "templates", "_shared")
        config.GENERIC_PHOTO_CARD = os.path.join(
            config.SHARED_TEMPLATES_DIR, "photo-card", "photo.svg")
        config.clear_preview_overrides()
        return self

    def __exit__(self, *exc):
        if self.saved["DATA_DIR"] is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self.saved["DATA_DIR"]
        config.THEMES_JSON = self.saved["THEMES_JSON"]
        config.REPO = self.saved["REPO"]
        config.SHARED_TEMPLATES_DIR = self.saved["SHARED"]
        config.GENERIC_PHOTO_CARD = self.saved["GENERIC"]
        shutil.rmtree(self.tmp, ignore_errors=True)
        return False

    # -- helpers ------------------------------------------------------------

    def image_dir(self, key):
        return os.path.join(self.repo, "resources", "canva", "templates", key)

    def volume_dir(self, key):
        return os.path.join(self.data, "templates", key)

    def write(self, path, text="<svg/>"):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(text)
        return path

    def photo_card(self, directory, text="<svg/>"):
        return self.write(os.path.join(directory, "clean", "photo.svg"), text)

    def pawns(self, subdir="photo-fallback", indices=(1, 2, 3, 4)):
        return [self.write(os.path.join(config.SHARED_TEMPLATES_DIR, subdir,
                                        f"{i}.svg")) for i in indices]


# ---- themes.json shape ------------------------------------------------------


def test_a_cards_block_is_what_marks_a_theme_as_a_single_card_deck():
    assert config.is_single_card(_cards_cfg())
    # and the flat marker still counts, so an entry written before the rename
    # keeps rendering as a deck instead of dropping to the v1 sheet path.
    assert config.is_single_card(_flat_cfg())


def test_a_v1_theme_is_not_a_single_card_deck():
    assert not config.is_single_card({"slug": "trip", "word_font": "x.ttf"})
    assert not config.is_single_card({"cards": None})
    assert not config.is_single_card({"cards": []}), "a list is a v1 recipe's shape"
    assert not config.is_single_card({"card_layout": "sheet"})


def test_every_shipped_theme_still_reads_as_v1():
    # The seven un-migrated themes must keep taking the sheet path while the
    # first deck theme lands — read the shipped file directly so an owner store
    # in the environment cannot colour the answer.
    with open(config.THEMES_JSON, encoding="utf-8") as f:
        shipped = json.load(f)
    checked = 0
    for key, cfg in shipped.items():
        if cfg.get("cards") or cfg.get("card_layout") == "single":
            continue  # a migrated theme, once one lands
        assert not config.is_single_card(cfg), key
        assert config.fronts(cfg) == config.DEFAULT_FRONTS, key
        checked += 1
    assert checked, "no un-migrated theme was exercised"


def test_fronts_read_the_cards_block_first_then_the_flat_key():
    assert config.fronts(_cards_cfg(fronts=[2, 5])) == [2, 5]
    assert config.fronts(_flat_cfg(fronts=[3, 4])) == [3, 4]
    # nested wins over a stale flat leftover: the canonical block is the truth.
    cfg = _cards_cfg(fronts=[2, 3])
    cfg["fronts"] = [7, 8, 9]
    assert config.fronts(cfg) == [2, 3]


def test_fronts_default_to_the_eight_when_unset_or_unusable():
    assert config.fronts({}) == config.DEFAULT_FRONTS
    assert config.fronts(_cards_cfg(fronts=[])) == config.DEFAULT_FRONTS
    # Non-int entries are dropped rather than trusted — a bad value would become
    # a filename and fail deep inside a render.
    assert config.fronts(_cards_cfg(fronts=[2, "x", None, "4"])) == [2, 4]
    assert config.fronts(_cards_cfg(fronts=["x"])) == config.DEFAULT_FRONTS


def test_back_index_reads_the_cards_block_first_then_the_flat_key():
    assert config.back_index(_cards_cfg(back=3)) == 3
    assert config.back_index(_flat_cfg(back_index=4)) == 4
    cfg = _cards_cfg(back=1)
    cfg["back_index"] = 9
    assert config.back_index(cfg) == 1


def test_back_index_falls_back_to_one_when_absent_or_unusable():
    assert config.back_index({}) == config.DEFAULT_BACK_INDEX
    assert config.back_index(_cards_cfg(back=None)) == config.DEFAULT_BACK_INDEX
    assert config.back_index(_cards_cfg(back="oops")) == config.DEFAULT_BACK_INDEX


def test_front_offset_still_reads_per_front_then_the_shared_nudge():
    cfg = {"title_style": {"front_offset": {"3": [0.01, 0.02]}, "offset": [0.0, 0.5]}}
    assert config.front_offset(cfg, 3) == [0.01, 0.02]
    assert config.front_offset(cfg, 4) == [0.0, 0.5]
    assert config.front_offset({"title_style": {}}, 2) is None
    assert config.front_offset({}, 2) is None


# ---- recipe format v2 -------------------------------------------------------


def test_format_two_is_what_marks_a_recipe_as_a_single_card():
    assert config.is_single_card_recipe(_recipe_v2())
    # the pre-rename markers still read as v2
    assert config.is_single_card_recipe({"layout": "single"})
    assert config.is_single_card_recipe({"card": {"cell": [0, 0, 1, 1]}})


def test_a_v1_sheet_recipe_is_not_a_single_card_recipe():
    assert not config.is_single_card_recipe(_recipe_v1())
    assert not config.is_single_card_recipe({"format": 1, "cards": []})
    assert not config.is_single_card_recipe({})


def test_recipe_card_returns_the_card_block():
    card = config.recipe_card(_recipe_v2())
    assert card["cell"] == [0.0, 0.0, 223.92, 312.0]
    assert len(card["words"]) == 4


def test_recipe_card_names_the_fix_when_the_recipe_is_a_v1_sheet():
    try:
        config.recipe_card(_recipe_v1())
    except RuntimeError as e:
        assert "calibration" in str(e), e
        return
    raise AssertionError("a v1 recipe must be refused, not half-read")


def test_front_titles_are_keyed_by_front_number():
    titles = {str(n): [_box(float(n), 10.0)] for n in range(2, 10)}
    recipe = _recipe_v2(title=titles)
    for n in range(2, 10):
        got = config.recipe_front_title(recipe, n)
        assert len(got) == 1 and got[0]["x0"] == float(n), (n, got)


def test_a_multi_line_title_survives_as_several_boxes():
    lines = [_box(20.0, 10.0), _box(30.0, 44.0, 190.0, 70.0)]
    recipe = _recipe_v2(title={"2": lines})
    assert config.recipe_front_title(recipe, 2) == lines


def test_a_front_missing_from_the_title_map_falls_back_to_the_union():
    # A partly-calibrated template must still print the honoree's name, roughly
    # where the calibrated fronts put it — never drop it.
    recipe = _recipe_v2(title={"2": [_box(20.0, 10.0, 100.0, 40.0)],
                               "3": [_box(60.0, 14.0, 200.0, 50.0)]})
    got = config.recipe_front_title(recipe, 7)
    assert len(got) == 1
    assert (got[0]["x0"], got[0]["y0"], got[0]["x1"], got[0]["y1"]) == (
        20.0, 10.0, 200.0, 50.0)


def test_a_shared_title_list_places_every_front():
    # ``card.title`` as a plain LIST (not a per-front map) means "same slot on
    # all eight" — the shape a template whose title does not move can ship.
    shared = [_box(20.0, 10.0)]
    recipe = _recipe_v2(title=shared)
    for n in range(2, 10):
        assert config.recipe_front_title(recipe, n) == shared


def test_the_legacy_per_front_block_is_still_read():
    # Recipes detected before the rename put the per-front titles in a top-level
    # ``fronts`` map; they must keep placing titles rather than silently
    # collapsing to the union of nothing.
    recipe = _recipe_v2()
    recipe["fronts"] = {"2": {"title": [_box(11.0, 10.0)]},
                        "3": {"title": [_box(12.0, 10.0)]}}
    assert config.recipe_front_title(recipe, 2)[0]["x0"] == 11.0
    got = config.recipe_front_title(recipe, 9)
    assert len(got) == 1 and got[0]["x0"] == 11.0, "union of the recorded fronts"


def test_a_recipe_with_no_title_anywhere_returns_nothing():
    assert config.recipe_front_title(_recipe_v2(), 2) == []
    assert config.recipe_front_title({}, 2) == []


def test_a_null_back_means_no_back_title_not_a_fallback():
    # grapefruit's back is a full-bleed pattern with NO text slot: "back": null
    # is the calibrated answer, so the name must not be stamped onto artwork that
    # was designed without room for it.
    assert config.recipe_back_title(_recipe_v2(back=None)) == []
    assert config.recipe_back_title(_recipe_v2()) == [], "an absent back reads the same"
    assert config.recipe_back_title(_recipe_v2(back={})) == []
    # and a back that DOES carry a slot still hands it over verbatim
    boxes = [_box(15.0, 120.0)]
    assert config.recipe_back_title(_recipe_v2(back={"title": boxes})) == boxes


def test_a_null_back_never_leaks_into_a_front_title():
    recipe = _recipe_v2(title={"2": [_box(20.0, 10.0)]}, back=None)
    assert config.recipe_front_title(recipe, 2)[0]["x0"] == 20.0


def test_detected_photo_slots_reach_the_renderer_verbatim():
    quads = [{"x0": 39.93, "y0": 87.0, "x1": 105.93, "y1": 153.0},
             {"x0": 117.93, "y0": 87.0, "x1": 183.93, "y1": 153.0},
             {"x0": 39.93, "y0": 165.0, "x1": 105.93, "y1": 231.0},
             {"x0": 117.93, "y0": 165.0, "x1": 183.93, "y1": 231.0}]
    recipe = _recipe_v2(photo=quads)
    assert config.photo_slots(recipe, config.recipe_card(recipe)["cell"]) == quads


def test_photo_slots_default_to_an_inset_two_by_two_grid():
    recipe = _recipe_v2()
    cell = config.recipe_card(recipe)["cell"]
    slots = config.photo_slots(recipe, cell)
    assert len(slots) == 4
    assert all(cell[0] <= s["x0"] < s["x1"] <= cell[2] for s in slots)
    assert all(cell[1] <= s["y0"] < s["y1"] <= cell[3] for s in slots)
    # reading order: two across, then two down
    assert slots[0]["x0"] < slots[1]["x0"] and slots[0]["y0"] == slots[1]["y0"]
    assert slots[2]["y0"] > slots[0]["y0"]


def test_a_short_photo_slot_list_is_not_trusted():
    # Three detected slots is a failed detection, not a three-photo card.
    recipe = _recipe_v2(photo=[{"x0": 0.0, "y0": 0.0, "x1": 1.0, "y1": 1.0}] * 3)
    assert len(config.photo_slots(recipe, [0, 0, 223.92, 312.0])) == 4


# ---- the photo card: which artwork -----------------------------------------


def test_the_owner_overlay_wins_over_the_theme_and_the_generic():
    with Store(owner={"demo": _cards_cfg()}) as s:
        os.makedirs(s.volume_dir("demo"))
        want = s.photo_card(s.volume_dir("demo"), "<svg id='volume'/>")
        s.photo_card(s.image_dir("demo"), "<svg id='image'/>")
        s.write(config.GENERIC_PHOTO_CARD, "<svg id='generic'/>")
        assert config.photo_card_path("demo") == want


def test_the_themes_own_card_wins_over_the_generic():
    # Registered by the owner but with its art in the image: theme_dir resolves
    # by key, and the theme's own photo card must still beat the generic one.
    with Store(owner={"demo": _cards_cfg()}) as s:
        want = s.photo_card(s.image_dir("demo"), "<svg id='image'/>")
        s.write(config.GENERIC_PHOTO_CARD, "<svg id='generic'/>")
        assert config.photo_card_path("demo") == want


def test_a_theme_shipping_no_photo_card_gets_the_generic_dugri_one():
    with Store(owner={"demo": _cards_cfg()}) as s:
        os.makedirs(os.path.join(s.image_dir("demo"), "clean"))
        want = s.write(config.GENERIC_PHOTO_CARD, "<svg id='generic'/>")
        assert config.photo_card_path("demo") == want


def test_a_volume_template_without_a_photo_card_still_finds_the_generic():
    # theme_dir answers with the VOLUME dir here, so resolution must not stop at
    # the one directory theme_dir picked.
    with Store(owner={"demo": _cards_cfg()}) as s:
        os.makedirs(os.path.join(s.volume_dir("demo"), "clean"))
        want = s.write(config.GENERIC_PHOTO_CARD, "<svg id='generic'/>")
        assert config.photo_card_path("demo") == want


def test_a_theme_may_name_its_own_photo_card_file():
    with Store(owner={"demo": _cards_cfg(
            photo={"template": "clean/party.svg"})}) as s:
        want = s.write(os.path.join(s.image_dir("demo"), "clean", "party.svg"))
        s.write(config.GENERIC_PHOTO_CARD)
        assert config.photo_card_path("demo") == want


def test_the_legacy_photo_card_block_is_still_read():
    cfg = _flat_cfg(photo_card={"template": "clean/party.svg"})
    with Store(owner={"demo": cfg}) as s:
        want = s.write(os.path.join(s.image_dir("demo"), "clean", "party.svg"))
        s.write(config.GENERIC_PHOTO_CARD)
        assert config.photo_card_path("demo") == want


def test_a_photo_card_name_cannot_escape_the_templates_clean_dir():
    cfg = _cards_cfg(photo={"template": "../../../../etc/passwd"})
    with Store(owner={"demo": cfg}) as s:
        os.makedirs(os.path.join(s.image_dir("demo"), "clean"))
        want = s.write(config.GENERIC_PHOTO_CARD)
        # only the basename is used, so the traversal can only ever miss
        assert config.photo_card_path("demo") == want


# ---- the photo card: which images ------------------------------------------


def test_the_fallback_set_is_the_shared_pawns_in_numeric_order():
    with Store(owner={"demo": _cards_cfg()}) as s:
        want = s.pawns()
        assert config.photo_fallback_paths("demo") == want
        assert [os.path.basename(p) for p in want] == [
            "1.svg", "2.svg", "3.svg", "4.svg"], "slot N takes pawn N"


def test_a_theme_may_point_at_another_fallback_directory():
    cfg = _cards_cfg(photo={"fallback": "photo-fallback-neon"})
    with Store(owner={"demo": cfg}) as s:
        s.pawns()
        want = s.pawns("photo-fallback-neon")
        assert config.photo_fallback_paths("demo") == want


def test_a_fallback_directory_name_cannot_escape_the_shared_tree():
    cfg = _cards_cfg(photo={"fallback": "../../../photo-fallback"})
    with Store(owner={"demo": cfg}) as s:
        want = s.pawns()
        assert config.photo_fallback_paths("demo") == want


def test_a_partly_shipped_fallback_set_degrades_to_what_is_there():
    with Store(owner={"demo": _cards_cfg()}) as s:
        want = s.pawns(indices=(1, 3))
        # missing files are dropped rather than rendered as a broken slot
        assert config.photo_fallback_paths("demo") == want


def test_no_fallback_artwork_at_all_is_an_empty_set_not_a_crash():
    with Store(owner={"demo": _cards_cfg()}):
        assert config.photo_fallback_paths("demo") == []


def test_the_legacy_explicit_fallback_list_still_resolves():
    # The first shape was a LIST of repo-relative/absolute paths. Entries in
    # flight keep resolving instead of being read as a directory name.
    outside = os.path.join(tempfile.mkdtemp(prefix="dugri-cfg-v2-abs-"), "absolute.svg")
    cfg = _flat_cfg(photo_card={
        "fallback": ["resources/pawn.svg", outside, "resources/gone.svg"]})
    try:
        with Store(owner={"demo": cfg}) as s:
            inside = s.write(os.path.join(s.repo, "resources", "pawn.svg"))
            s.write(outside)
            assert config.photo_fallback_paths("demo") == [inside, outside]
    finally:
        shutil.rmtree(os.path.dirname(outside), ignore_errors=True)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")


# --- the calibration form's unsaved slots must reach the preview -------------
# The owner tunes card_slots in the admin form and hits preview BEFORE saving.
# set_preview_overrides filters to _OVERRIDABLE, and card_slots was missing from
# it, so the slots were dropped and every preview came back a blank card — no
# words, no title, and nothing to say the knobs had been ignored rather than
# mis-measured.

def _slots():
    return {"words": [{"x0": 0.1, "y0": 0.3 + i * 0.15,
                       "x1": 0.9, "y1": 0.42 + i * 0.15} for i in range(4)],
            "titles": {str(n): {"x0": 0.08, "y0": 0.07, "x1": 0.92, "y1": 0.2}
                       for n in range(2, 10)}}


def test_card_slots_is_previewable():
    assert "card_slots" in config._OVERRIDABLE, (
        "the calibration form's own geometry must reach the preview, or the "
        "owner previews a blank card"
    )


def test_unsaved_card_slots_reach_the_render(tmp_path=None):
    import tempfile
    root = str(tmp_path or tempfile.mkdtemp())
    themes = os.path.join(root, "themes.json")
    with open(themes, "w", encoding="utf-8") as f:
        json.dump({"demo": {"slug": "demo", "dir": "d", "recipe": "demo",
                            "cards": {"back": 1, "fronts": [2, 3]},
                            "title_style": {"fill": "#fff", "outline": "#000"},
                            "calibrated": False}}, f)
    prev, config.THEMES_JSON = config.THEMES_JSON, themes
    try:
        config.clear_preview_overrides()
        config.set_preview_overrides("demo", {
            "title_style": {"fill": "#711d20", "outline": "#711d20"},
            "card_slots": _slots(),
        })
        cfg = config.theme("demo")
        cell = [0, 0, 223.92, 312]
        recipe = {"theme": "demo", "format": 2, "viewBox": [0, 0, 223.92, 312]}
        assert len(config.card_word_boxes(cfg, recipe, cell)) == 4
        assert len(config.card_title_boxes(cfg, recipe, 2, cell)) == 1
    finally:
        config.THEMES_JSON = prev
        config.clear_preview_overrides()


def test_a_preview_still_cannot_repoint_a_theme_at_other_artwork():
    # card_slots is pure geometry; `cards` chooses WHICH SVGs render, so it must
    # never be overridable from a preview request.
    assert "cards" not in config._OVERRIDABLE
    assert "dir" not in config._OVERRIDABLE
    assert "recipe" not in config._OVERRIDABLE


def test_admin_onboarded_template_is_detected_as_single_card():
    """The ADMIN writes card_structure and NO cards block.

    This is the shape server/templates.js appends on a nine-file upload. Reading
    it as a legacy sheet sent the render down the v1 path, which indexes
    recipe["cards"] — a key a v2 recipe does not have — so every owner-uploaded
    single-card template died with a KeyError instead of previewing.
    """
    assert config.is_single_card({"card_structure": "cards", "card_slots": None})
    # ...and the other two markers still work on their own.
    assert config.is_single_card({"cards": {"back": 1, "fronts": [2, 3]}})
    assert config.is_single_card({"card_layout": "single"})


def test_a_legacy_sheet_is_still_a_sheet():
    """The guard has to stay one-directional: nothing here may promote a v1 theme."""
    assert not config.is_single_card({})
    assert not config.is_single_card({"card_structure": "sheet"})
    assert not config.is_single_card({"cards": None})
    assert not config.is_single_card({"cards": []})
