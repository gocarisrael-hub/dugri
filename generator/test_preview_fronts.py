#!/usr/bin/env python3
"""Tests for the per-front calibration preview.

The title position is calibrated PER FRONT, so an owner tuning fronts 2..9 has
to see fronts 2..9 — previewing only the first leaves them adjusting numbers
blind. These pin:

  * an OWNER calibration preview returns every front, keyed by front number;
  * a BUYER preview still returns exactly one card (one Chrome run on a public
    endpoint, and a stable image as they retype the name);
  * the strip is sliced into equal, correctly-sized cards.

Run: python3 generator/test_preview_fronts.py   (or via pytest)
"""
import os
import shutil

import config
import render_page as rp
import test_build_deck as tb


def _chrome():
    exe = os.environ.get("CHROME", "")
    if exe and os.path.exists(exe):
        return exe
    return (shutil.which("google-chrome") or shutil.which("chromium")
            or shutil.which("chromium-browser"))


# --- pure ------------------------------------------------------------------

def test_no_fronts_renders_nothing():
    assert rp.render_fronts_strip("demo", [], [], [], "/tmp/unused") == []


def test_a_buyer_preview_asks_for_one_card_only():
    # The public preview path must not fan out to eight renders; the signal for
    # "render them all" is the presence of an owner calibration blob.
    import inspect
    src = inspect.getsource(__import__("preview")._preview_single_card)
    assert "all_fronts" in src
    src_preview = inspect.getsource(__import__("preview").preview)
    assert "all_fronts=bool(calibration)" in src_preview, (
        "all-fronts must be driven by the owner calibration blob, not always on"
    )


# --- with Chrome -----------------------------------------------------------

def test_every_front_is_rendered_and_sliced_evenly():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    from PIL import Image
    with tb.Store() as tmp:
        cfg = config.theme("demo")
        fronts = config.fronts(cfg)
        out_dir = os.path.join(tmp, "strip")
        paths = rp.render_fronts_strip(
            "demo", fronts, ["א", "ב", "ג", "ד"], ["שירה"], out_dir)
        assert len(paths) == len(fronts), paths
        # Named by front number, so the admin UI can label each image.
        for front, path in zip(fronts, paths):
            assert path.endswith(f"front-{front}.png"), path
            assert os.path.getsize(path) > 0
        sizes = {Image.open(p).size for p in paths}
        assert len(sizes) == 1, f"slices must be identical in size, got {sizes}"
        w, h = sizes.pop()
        # Portrait card, and wide enough to be a real render rather than a sliver
        # left over from an off-by-one slice.
        assert h > w > 100, (w, h)


def test_owner_preview_returns_every_front_and_buyer_preview_one():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    import preview
    with tb.Store() as tmp:
        cfg = config.theme("demo")
        fronts = config.fronts(cfg)
        calibration = {
            "title_style": dict(cfg["title_style"]),
            "card_slots": {
                "words": [{"x0": 0.1, "y0": 0.3 + i * 0.13,
                           "x1": 0.9, "y1": 0.4 + i * 0.13} for i in range(4)],
                "titles": {str(n): {"x0": 0.08, "y0": 0.06, "x1": 0.92, "y1": 0.19}
                           for n in fronts},
            },
        }
        owner_dir = os.path.join(tmp, "owner")
        os.makedirs(owner_dir, exist_ok=True)
        owner = preview.preview("demo", "שירה", workdir=owner_dir,
                                calibration=calibration)
        assert sorted(owner["cards"], key=int) == [str(f) for f in fronts]
        # "card" stays the first front so existing callers keep working.
        assert owner["card"] == owner["cards"][str(fronts[0])]

        config.clear_preview_overrides()
        buyer_dir = os.path.join(tmp, "buyer")
        os.makedirs(buyer_dir, exist_ok=True)
        buyer = preview.preview("demo", "שירה", workdir=buyer_dir)
        assert "cards" not in buyer, "a buyer preview must stay a single card"
        assert buyer["card"]


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  {fn.__name__}")
    print(f"all {len(fns)} tests passed")


# --- the enhancement must never cost the owner their preview ----------------
# Showing every front is a calibration nicety on a heavier render (one page
# eight cards wide). It fell over in production and took the WHOLE calibration
# preview down with it, rather than degrading to the single card the screen has
# always shown.

def test_a_failing_strip_degrades_to_one_card_instead_of_killing_the_preview():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    import preview as pv
    import test_build_deck as tb
    with tb.Store() as tmp:
        cfg = config.theme("demo")
        cal = {"title_style": dict(cfg["title_style"])}
        saved = rp.render_fronts_strip
        rp.render_fronts_strip = lambda *a, **k: (_ for _ in ()).throw(
            RuntimeError("simulated container failure"))
        try:
            out = pv.preview("demo", "שירה", workdir=os.path.join(tmp, "fb"),
                             calibration=cal)
        finally:
            rp.render_fronts_strip = saved
            config.clear_preview_overrides()
        assert out.get("card"), "the preview must still return a card"
        assert "cards" not in out, "and must not claim per-front images it does not have"


def test_the_strip_declares_its_fonts_once_not_once_per_card():
    # Eight cards x two base64 faces was sixteen copies of the same fonts in one
    # document; the deck assembler already declares them at document level. A
    # template that ships a second word face and a second title face doubles
    # that, so the count matters and not only the absence: ONE declaration per
    # family the strip actually uses, in the document's own stylesheet.
    import card_assets
    import render_page as rp
    cfg = config.theme("grapefruit") if "grapefruit" in config.load_themes() else None
    if cfg is None:
        print("  (skipped: grapefruit not present)")
        return
    fronts = config.fronts(cfg)
    svg = card_assets.read_svg(config.card_path("grapefruit", fronts[0]))
    assert "@font-face" not in svg, (
        "a card's artwork must not carry fonts; the strip declares them once"
    )
    # Nor may an OVERLAY smuggle one in — the strip pastes eight of them into
    # one document, so a per-card declaration is the same bloat by another route.
    recipe = config.recipe_or_empty(cfg)
    for front in fronts:
        overlay = rp.card_overlay("grapefruit", recipe, ["מסיבה"] * 4, ["שירה"],
                                  front_index=front, card_svg=svg)
        assert "@font-face" not in overlay, front
    # The stylesheet the strip does build: exactly one rule per family, and one
    # family per face the theme ships (no alt faces today -> two).
    style = rp.word_faces("grapefruit") + rp.title_faces("grapefruit", cfg)
    assert style.count("@font-face") == 2, style.count("@font-face")
    for family in ("HebWord", "TitleFont"):
        assert style.count(f"font-family:'{family}'") == 1, family
