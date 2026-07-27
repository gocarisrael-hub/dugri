#!/usr/bin/env python3
"""Tests for generator/calibration_health.py — the calibration health check.

Two halves. Most tests build a SYNTHETIC theme (its own temp template dir, its
own themes.json via ``config.THEMES_JSON``, a throwaway recipe) so a fault can be
introduced deliberately and the report checked against it — no Chrome, no
template art, well under a second. The other half runs the checker against the
eight REAL shipped themes and requires it to find nothing: a checker that cries
wolf on known-good templates is worse than no checker, so that is asserted here
rather than left to a manual pass.

The pinned sizes the synthetic tests use are DERIVED from the fixture's own font
metrics (see ``_pins``) instead of hardcoded, so the tests state the property
under test — "a size twice what the box can hold is reported" — rather than a
magic number that would silently stop meaning that if the fixture font changed.

Run: python3 generator/test_calibration_health.py   (or via pytest)
"""
import json
import os
import shutil
import subprocess
import tempfile

import calibration_health as H
import config
import render_page as rp

HERE = os.path.dirname(os.path.abspath(__file__))
# Real fonts that ship inside generator/, so a fixture can swap one for another
# without reaching into a template's assets. Measured on the sample title these
# tests use, FONT_C paints 39% shorter than FONT_A at the same size while
# FONT_B is within 6% of it — which is exactly the pair of cases the swap tests
# below need (one a fit-breaking swap, one that stays inside the box).
FONT_A = os.path.join(HERE, "Cafe-Regular.ttf")
FONT_B = os.path.join(HERE, "MrDafoe-Regular.ttf")
FONT_C = os.path.join(HERE, "word-fonts", "almoni-neue-aaa-bold-OFFICE.ttf")

_SVG = ('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300" '
        'viewBox="0 0 400 300"></svg>')

# One card: a title box 160x60 inside a 200x300 cell, with four word slots.
_RECIPE = {
    "viewBox": [0, 0, 400, 300],
    "cards": [{
        "cell": [0, 0, 200, 300],
        "title": [{"x0": 20, "y0": 20, "x1": 180, "y1": 80, "color": "#000"}],
        "words": [{"x0": 20, "y0": 100 + i * 30, "x1": 180, "y1": 120 + i * 30,
                   "color": "#000"} for i in range(4)],
    }],
}

_TITLE_STYLE = {"fill": "#ffffff", "outline": "#000000", "outline_w": 0.05,
                "arch": 0.0, "shadow": False}


class Fixture:
    """A synthetic theme on disk: template dir + themes.json + recipe.

    Used as a context manager so every test gets a clean one and nothing leaks
    into the real generator config.
    """

    def __init__(self, title_style=None, font=FONT_A, recipe=None, **entry):
        self.tmp = tempfile.mkdtemp(prefix="dugri-health-")
        self.key = "synthetic"
        self.recipe_name = "synthetic-health-test"
        tdir = os.path.join(self.tmp, "tpl")
        os.makedirs(os.path.join(tdir, "fonts"))
        os.makedirs(os.path.join(tdir, "clean"))
        shutil.copy(font, os.path.join(tdir, "fonts", "Title.ttf"))
        shutil.copy(FONT_A, os.path.join(tdir, "fonts", "Word.ttf"))
        for which in ("fronts", "board", "backs"):
            with open(os.path.join(tdir, "clean", which + ".svg"), "w",
                      encoding="utf-8") as f:
                f.write(_SVG)
        self.entry = {
            "slug": "synthetic", "dir": os.path.relpath(tdir, config.REPO),
            "recipe": self.recipe_name, "wordlist": "generic-350.txt",
            "display_he": "סינתטי", "title_text": "{NAME}'S PARTY",
            "title_lines": ["{NAME}'S", "PARTY"], "language": "english",
            "name_form": "english-caps", "extra_fields": [],
            "title_font": "Title.ttf", "word_font": "Word.ttf",
            "title_style": dict(title_style or _TITLE_STYLE),
            "board": None, "back": None, "calibrated": True,
        }
        self.entry.update(entry)
        self.recipe = json.loads(json.dumps(recipe or _RECIPE))
        self.themes_json = os.path.join(self.tmp, "themes.json")
        self.recipe_path = os.path.join(HERE, "recipes", self.recipe_name + ".json")
        self._saved = config.THEMES_JSON

    def write(self):
        with open(self.themes_json, "w", encoding="utf-8") as f:
            json.dump({self.key: self.entry}, f)
        with open(self.recipe_path, "w", encoding="utf-8") as f:
            json.dump(self.recipe, f)

    def __enter__(self):
        self.write()
        config.THEMES_JSON = self.themes_json
        # The font metric caches are keyed by PATH, and a fixture reuses paths
        # across tests, so stale metrics would silently answer for the wrong face.
        rp._title_metrics.cache_clear()
        rp._word_metrics.cache_clear()
        return self

    def __exit__(self, *exc):
        config.THEMES_JSON = self._saved
        if os.path.exists(self.recipe_path):
            os.remove(self.recipe_path)
        shutil.rmtree(self.tmp, ignore_errors=True)
        rp._title_metrics.cache_clear()
        rp._word_metrics.cache_clear()

    def font_path(self):
        return os.path.join(config.REPO, self.entry["dir"], "fonts", "Title.ttf")

    def check(self, **kw):
        return H.check(self.key, **kw)


def _pins(fx):
    """(fitting, too_big, too_small) pinned sizes for this fixture's own font.

    Measured off the fixture rather than hardcoded, so the tests keep asserting
    the PROPERTY (a size the box cannot hold / one it dwarfs) whatever font the
    fixture happens to use.
    """
    cfg = config.theme(fx.key)
    ts = cfg["title_style"]
    box = H._front_boxes(fx.recipe, ts)[0]
    bw, bh = box["x1"] - box["x0"], box["y1"] - box["y0"]
    samples = H.sample_titles(cfg)
    hi_h = max(H._paint_ratio(fx.font_path(), ln, ts["outline_w"], ts["shadow"])
               for ln, _n in samples)
    hi_w = max(H._width_ratio(fx.font_path(), ln) for ln, _n in samples)
    fitting = min(bh / hi_h, bw / hi_w)
    return fitting, fitting * 2.5, fitting * 0.15


def _texts(report):
    return " || ".join(report["problems"])


# ---- the real shipped themes ----------------------------------------------

def test_every_shipped_theme_reports_healthy():
    # The whole point of the checker is that a WARNING CAN BE TRUSTED. Five of
    # the eight shipped themes pin a title size ('trip comeback' 23.9,
    # bachelorette 21.9, birthday-girls 23.0 + back 30.0, neon 25.9, japanese
    # 23.9) and every one of them is correct as shipped, so the checker must be
    # silent on all eight. If this ever fails, the threshold is wrong before the
    # theme is.
    config.clear_preview_overrides()
    for key, report in H.check_all().items():
        assert report["ok"], f"{key} must be healthy, got: {_texts(report)}"


def test_the_check_never_writes_themes_json():
    # Read-only is a hard requirement: the owner runs this to get an opinion, not
    # to have their calibration edited. Byte-compare the file across a full run.
    before = open(config.THEMES_JSON, "rb").read()
    H.check_all()
    assert open(config.THEMES_JSON, "rb").read() == before, (
        "the health check must never modify themes.json")


def test_shipped_themes_keep_a_margin_on_both_thresholds():
    # Not just "passes" but "passes with room". A checker whose real-world inputs
    # sit a hair inside the threshold is one font update away from being noise,
    # so record the actual margins here — this is what makes the numbers in
    # calibration_health's docstring auditable rather than claimed.
    worst_over, worst_small = 0, 1
    for _key, report in H.check_all().items():
        for m in (report["measurements"].get("title_fit") or {}).values():
            worst_over = max(worst_over, m["fills_box_h_min"],
                             m["fills_box_w_min"] or 0)
            worst_small = min(worst_small, m["fills_box_h_max"])
    assert worst_over < H._OVERFLOW, (
        f"a shipped theme fills {worst_over:.3f} of its box vs the "
        f"{H._OVERFLOW} overflow threshold")
    assert worst_small > H._TOO_SMALL, (
        f"a shipped theme fills only {worst_small:.3f} of its box vs the "
        f"{H._TOO_SMALL} too-small floor")


# ---- pinned title size vs the box -----------------------------------------

def test_a_pinned_size_that_fits_is_not_reported():
    with Fixture() as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        r = fx.check()
        assert r["ok"], _texts(r)


def test_a_pinned_size_too_large_for_its_box_is_reported():
    with Fixture() as fx:
        _fit, big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(big, 2)
        fx.write()
        r = fx.check()
        assert not r["ok"], "an oversized pinned title must be reported"
        assert "גדול מדי" in _texts(r), _texts(r)
        assert str(round(big, 2)) in _texts(r), "the report must name the size"


def test_a_pinned_size_far_below_its_box_is_reported():
    with Fixture() as fx:
        _fit, _big, small = _pins(fx)
        fx.entry["title_style"]["size"] = round(small, 2)
        fx.write()
        r = fx.check()
        assert not r["ok"], "a pinned title far smaller than its box must be reported"
        assert "קטן מדי" in _texts(r), _texts(r)


def test_swapping_the_title_font_alone_turns_a_good_pin_bad():
    # The exact scenario this module exists for: the artwork does not move, the
    # box stays valid, only the typeface behind the pinned size changes — and the
    # pin, which bypasses the auto-fit, silently stops matching.
    with Fixture(font=FONT_C) as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        assert fx.check()["ok"], "the pin must be healthy against its own font"
        shutil.copy(FONT_A, fx.font_path())    # same box, same pin, new face
        rp._title_metrics.cache_clear()
        r = fx.check()
        assert not r["ok"], (
            "a pinned size must stop being healthy once the title font is "
            "swapped out from under it")
        assert "פונט" in _texts(r), _texts(r)


def test_a_font_swap_that_still_fits_the_box_is_left_to_the_git_check():
    # The honest limit of a box-fit test, asserted so nobody later "fixes" it by
    # tightening the thresholds into false alarms. Two faces can differ visibly
    # and still both land inside the same box (FONT_A vs FONT_B are within 6% on
    # this title), and a box that the calibration deliberately over-measures has
    # even more slack. Detecting THAT swap is the git-history check's job — see
    # test_a_font_committed_after_the_calibration_is_reported — not this one's.
    with Fixture(font=FONT_A) as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        shutil.copy(FONT_B, fx.font_path())
        rp._title_metrics.cache_clear()
        r = fx.check()
        assert not any("גדול מדי" in p or "קטן מדי" in p for p in r["problems"]), (
            "a swap that still fits must NOT be reported as a bad fit: "
            + _texts(r))


def test_the_verdict_does_not_depend_on_the_honoree_name():
    # A title's size on the page depends on the name; a verdict about the
    # CALIBRATION must not. Whatever name is passed, the problems reported stay
    # the same set — a long name can only add notes.
    with Fixture() as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        base = fx.check()["problems"]
        for name in ("Jo", "Gaby", "Bartholomew-Maximilian"):
            r = fx.check(name=name)
            assert r["problems"] == base, (
                f"the name {name!r} changed the verdict: {_texts(r)}")


def test_a_long_name_is_reported_as_a_note_not_a_problem():
    with Fixture() as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        r = fx.check(name="Bartholomew-Maximilian")
        assert r["ok"], "a long honoree name is not a calibration fault"
        assert r["notes"], "…but it should still be pointed out"
        assert "Bartholomew-Maximilian" in " ".join(r["notes"])


def test_board_and_back_pins_are_checked_on_their_own_boxes():
    # back_size / board_size pin DIFFERENT surfaces with different boxes, so each
    # is judged against its own — a bad back_size must not hide behind a fine size.
    with Fixture() as fx:
        fitting, big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.entry["title_style"]["back_size"] = round(big * 3, 2)
        fx.entry["back"] = {"fill": "#fff", "outline": "#000",
                            "frac": {"x0": 0.1, "y0": 0.1, "x1": 0.9, "y1": 0.3}}
        fx.write()
        r = fx.check()
        assert not r["ok"] and "back_size" in _texts(r), _texts(r)


def test_an_unpinned_theme_raises_no_fit_verdict():
    # With nothing pinned the renderer auto-fits to the box, so there is no
    # stored number that can go stale — and nothing to report.
    with Fixture() as fx:
        r = fx.check()
        assert r["ok"], _texts(r)
        assert not r["measurements"].get("title_fit")


# ---- structure -------------------------------------------------------------

def test_calibrated_theme_missing_title_style_keys_is_reported():
    ts = dict(_TITLE_STYLE)
    del ts["arch"]
    with Fixture(title_style=ts) as fx:
        r = fx.check()
        assert not r["ok"] and "arch" in _texts(r), _texts(r)


def test_calibrated_theme_with_no_title_style_at_all_is_reported():
    with Fixture(title_style=None) as fx:
        fx.entry["title_style"] = None
        fx.write()
        r = fx.check()
        assert not r["ok"] and "title_style" in _texts(r), _texts(r)


def test_an_inverted_or_out_of_range_frac_is_reported():
    for frac, why in (
        ({"x0": 0.9, "y0": 0.1, "x1": 0.2, "y1": 0.3}, "inverted"),
        ({"x0": 0.1, "y0": 0.1, "x1": 1.4, "y1": 0.3}, "out of range"),
    ):
        with Fixture() as fx:
            fx.entry["board"] = {"fill": "#fff", "outline": "#000", "frac": frac}
            fx.write()
            r = fx.check()
            assert not r["ok"], f"a {why} frac must be reported"


def test_an_uncalibrated_theme_is_not_judged_on_completeness():
    # calibrated:false means "still being onboarded" — the nulls are expected and
    # reporting them as faults would bury the real findings.
    with Fixture() as fx:
        fx.entry["calibrated"] = False
        fx.entry["title_style"] = None
        fx.write()
        r = fx.check()
        assert r["ok"], _texts(r)


# ---- assets ----------------------------------------------------------------

def test_a_missing_title_font_file_is_reported():
    with Fixture() as fx:
        os.remove(fx.font_path())
        r = fx.check()
        assert not r["ok"] and "Title.ttf" in _texts(r), _texts(r)


def test_a_missing_clean_background_is_reported():
    with Fixture() as fx:
        os.remove(os.path.join(config.REPO, fx.entry["dir"], "clean", "fronts.svg"))
        r = fx.check()
        assert not r["ok"] and "fronts.svg" in _texts(r), _texts(r)


def test_an_unreadable_title_font_is_unknown_not_a_verdict():
    # A font PIL cannot parse means the fit CANNOT be measured. Saying so is the
    # honest answer; inventing a pass or a fail from it is not.
    with Fixture() as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        with open(fx.font_path(), "wb") as f:
            f.write(b"not a font at all")
        rp._title_metrics.cache_clear()
        r = fx.check()
        assert r["unknown"], "an unreadable font must be reported as unmeasured"
        assert not any("גדול מדי" in p or "קטן מדי" in p for p in r["problems"]), (
            "no fit verdict may be reached on a font that could not be read")


# ---- word slots ------------------------------------------------------------

def test_words_that_no_longer_fit_their_slots_are_reported():
    # Narrow the card until the theme's own wordlist stops fitting: the per-word
    # clamp starts shrinking words one by one and the card loses the single
    # uniform size the origin design has. The CELL is what is narrowed, not the
    # slot — a numbered line is right-anchored and clamped against the cell edge,
    # so the slot's own left edge is not what decides whether a word fits.
    recipe = json.loads(json.dumps(_RECIPE))
    card = recipe["cards"][0]
    card["cell"] = [0, 0, 80, 300]
    card["title"] = [{"x0": 10, "y0": 20, "x1": 70, "y1": 80, "color": "#000"}]
    for slot in card["words"]:
        slot["x0"], slot["x1"] = 10, 70
    with Fixture(recipe=recipe) as fx:
        fx.entry["word_size"] = 30
        fx.write()
        r = fx.check()
        assert not r["ok"] and "מילים" in _texts(r), _texts(r)
        assert r["measurements"]["words"]["words_shrunk_share"] > H._WORD_CLAMP_FAIL


def test_words_that_fit_are_not_reported():
    with Fixture() as fx:
        r = fx.check()
        assert r["ok"], _texts(r)
        assert r["measurements"]["words"]["words_shrunk_share"] == 0


# ---- font drift out of git history ----------------------------------------

def _git_available():
    try:
        subprocess.run(["git", "--version"], capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return False
    return True


def _git_repo_fixture():
    """A throwaway git repo holding a themes.json and a template font.

    Returns ``(tmpdir, font_path, commit)`` where ``commit`` commits everything
    with a message. Used to drive the "did the font move after the calibration
    was saved?" check without touching the real repository.
    """
    tmp = tempfile.mkdtemp(prefix="dugri-health-git-")
    os.makedirs(os.path.join(tmp, "generator"))
    tdir = os.path.join(tmp, "tpl")
    os.makedirs(os.path.join(tdir, "fonts"))
    os.makedirs(os.path.join(tdir, "clean"))
    for which in ("fronts", "board", "backs"):
        with open(os.path.join(tdir, "clean", which + ".svg"), "w",
                  encoding="utf-8") as f:
            f.write(_SVG)
    shutil.copy(FONT_A, os.path.join(tdir, "fonts", "Title.ttf"))
    shutil.copy(FONT_A, os.path.join(tdir, "fonts", "Word.ttf"))
    for args in (["init", "-q"], ["config", "user.email", "t@t"],
                 ["config", "user.name", "t"]):
        subprocess.run(["git", "-C", tmp] + args, capture_output=True, check=True)

    def commit(msg):
        subprocess.run(["git", "-C", tmp, "add", "-A"], capture_output=True,
                       check=True)
        subprocess.run(["git", "-C", tmp, "commit", "-q", "-m", msg],
                       capture_output=True, check=True)

    return tmp, os.path.join(tdir, "fonts", "Title.ttf"), commit


def _run_in_repo(tmp, entry, recipe_name):
    """Point config at the throwaway repo and check the theme inside it."""
    saved_repo, saved_json = config.REPO, config.THEMES_JSON
    config.REPO = tmp
    config.THEMES_JSON = os.path.join(tmp, "generator", "themes.json")
    recipe_path = os.path.join(HERE, "recipes", recipe_name + ".json")
    rp._title_metrics.cache_clear()
    rp._word_metrics.cache_clear()
    try:
        with open(config.THEMES_JSON, "w", encoding="utf-8") as f:
            json.dump({"synthetic": entry}, f)
        with open(recipe_path, "w", encoding="utf-8") as f:
            json.dump(_RECIPE, f)
        return H.check("synthetic")
    finally:
        config.REPO, config.THEMES_JSON = saved_repo, saved_json
        if os.path.exists(recipe_path):
            os.remove(recipe_path)
        rp._title_metrics.cache_clear()
        rp._word_metrics.cache_clear()


def _repo_entry(pin=None):
    entry = {
        "slug": "synthetic", "dir": "tpl", "recipe": "synthetic-health-git",
        "wordlist": "generic-350.txt", "display_he": "סינתטי",
        "title_text": "{NAME}'S PARTY", "title_lines": ["{NAME}'S", "PARTY"],
        "language": "english", "name_form": "english-caps", "extra_fields": [],
        "title_font": "Title.ttf", "word_font": "Word.ttf",
        "title_style": dict(_TITLE_STYLE), "board": None, "back": None,
        "calibrated": True,
    }
    if pin:
        entry["title_style"]["size"] = pin
    return entry


def test_a_font_committed_after_the_calibration_is_reported():
    # No fingerprint of the font is stored anywhere, so "has the font changed
    # since we pinned the size?" is answered from git history. Font first,
    # calibration second = healthy; calibration first, font second = the pin
    # predates the typeface it is meant to fit.
    if not _git_available():
        return  # no git here -> skip, don't fail
    tmp, font, commit = _git_repo_fixture()
    try:
        entry = _repo_entry(pin=20)
        os.makedirs(os.path.join(tmp, "generator"), exist_ok=True)
        with open(os.path.join(tmp, "generator", "themes.json"), "w",
                  encoding="utf-8") as f:
            json.dump({"synthetic": entry}, f)
        commit("font + calibration together")
        r = _run_in_repo(tmp, entry, "synthetic-health-git")
        assert not any("פונט הכותרת" in p and "כויילו מול פונט אחר" in p
                       for p in r["problems"]), (
            "a font committed WITH its calibration is not drift: " + _texts(r))

        # Now swap the face and commit only that — the calibration stays put.
        shutil.copy(FONT_B, font)
        commit("swap the title font, leave the pinned size alone")
        r = _run_in_repo(tmp, entry, "synthetic-health-git")
        assert any("כויילו מול פונט אחר" in p for p in r["problems"]), (
            "a font changed after the calibration must be reported: " + _texts(r))
        m = r["measurements"]["title_font"]
        # Both commits land in the same SECOND here, so this also pins down that
        # the answer comes from history order and not from the clock.
        assert m["font_commit_is_newer"] is True
        assert m["font_last_commit"] == m["calibration_last_commit"], (
            "the fixture is meant to commit twice within one second")
        assert m.get("suggested_scale"), (
            "the old font is in history, so the size change must be quantified")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_no_git_history_is_reported_as_unmeasured_not_as_a_fault():
    # A template dir outside any repository (a fresh upload, a tarball) cannot
    # answer the drift question. That is an "unknown", never a verdict.
    with Fixture() as fx:
        fitting, _big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(fitting, 2)
        fx.write()
        r = fx.check()
        assert r["ok"], _texts(r)
        assert "font_drift" in r["unknown"], (
            "an unanswerable drift question must be recorded as unknown, got "
            + repr(r["unknown"]))


# ---- report shape ----------------------------------------------------------

def test_the_report_is_json_serialisable_and_in_plain_language():
    with Fixture() as fx:
        _fit, big, _small = _pins(fx)
        fx.entry["title_style"]["size"] = round(big, 2)
        fx.write()
        r = fx.check()
        json.dumps(r, ensure_ascii=False)  # must not raise
        for key in ("theme", "ok", "problems", "warnings", "notes", "unknown",
                    "measurements"):
            assert key in r, f"missing report key {key}"
        for p in r["problems"]:
            assert isinstance(p, str) and len(p) > 30, (
                "a problem must be a sentence a non-programmer can act on, got "
                + repr(p))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok", fn.__name__)
    print(f"\nall {len(fns)} tests passed")
