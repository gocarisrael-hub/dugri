#!/usr/bin/env python3
"""THE SAME PAWN PHOTO, DRAWN THREE WAYS, HELD TOGETHER.

A buyer's photo is rendered three times over on the collection page's photos tab
and each one used to be free to drift:

  * the PRINTED card — the generator. The reference; the other two are promises
    about it.
  * the PREVIEW CARD at the top of the tab — the base card from the server with
    the photos laid over it in the browser.
  * the EDITOR CIRCLE in the row beneath it.

They did drift, and the owner reported it repeatedly: "the girl is positioned
exactly in the middle here but in here it's more to the left", "the circle itself
is not centred and sitting correctly on the card". It took a harness to see why,
because every check made before this one compared each photo to ITS OWN circle —
which comes out identical however far apart the three have moved. What differed
was the CIRCLE: the editor drew its dashed cut-line at the DISC's size (90% of the
slot) instead of the slot's, so the photo filled its ring in the row and sat well
inside its ring on the card an inch above it. Measured: the row's ring came out
12% smaller and the subject 15% larger against it.

So these tests render all three for real — Chrome, the generator's own composition,
the page's own stylesheet and geometry module — normalise them onto the ring, and
fail when any of the three moves away from the print. See generator/pawn_three_views.py
for the harness itself and for the pictures it writes.

Run: python3 generator/test_pawn_three_views.py   (or via pytest)
"""
import os

import pawn_three_views as h

# Where the three are allowed to sit apart, in RING RADII (the ring being the
# dashed cut-line, whose radius is half the slot). A whole ring is 2.0 across in
# these units, so 0.05 is 2.5% of the circle — comfortably above the ~1% the
# three rasterisers cost us (the print's slot is 132px, the row's 232 and the
# card's 264, and each rounds its edges differently) and far below the 0.14 the
# ring bug was worth.
TOL = 0.05
# The ring itself, as a fraction of the slot crop. Tighter, because this is the
# number the bug moved by 12%: the three rings ARE the same circle and only
# differ by where each renderer puts a stroke's antialiasing.
RING_TOL = 0.02
# The white sticker edge, in ring radii, and how much of it has to actually be
# white. The print dilates a hard rim; a browser can only stack shadows, so
# neither the width nor the hardness comes out exact — but a soft glow at 60% of
# the wrong width (which is what the row used to draw) has to fail.
HALO_TOL = 0.02
HALO_SOLID_MIN = 0.55

# The two framings worth rendering: the automatic one, and one the buyer has
# moved and zoomed. The second is not decoration — `applyView` (browser) and
# `apply_photo_view` (generator) are two implementations of one transform, and a
# default-view-only test would never touch either.
VIEWS = ((1.0, 0.0, 0.0), (1.35, 0.12, -0.08))

# One shipped theme, chosen by what is on disk rather than by name.
THEME = h.pick_theme()

_cache = {}


def _chrome():
    # chrome.binary() is the resolution the renderer itself uses, so this skips
    # exactly when a real render would fail — and runs on a Mac, where the
    # browser is an .app and not on PATH.
    try:
        import chrome
        return chrome.binary()
    except Exception:
        return None


def _views(view):
    """The three measurements for one framing, rendered once and kept.

    Three Chrome runs a piece (the print, the base card, the harness page), so
    the two framings are rendered once each for the whole module rather than once
    per assertion.
    """
    key = tuple(view)
    if key not in _cache:
        # NOT inside test_build_deck.Store: that store's card paper is plain
        # white, and a white sticker edge on white paper cannot be measured at
        # all. This renders a SHIPPED theme, read-only, out of the repo — see
        # pawn_three_views.pick_theme.
        out = os.environ.get("DUGRI_PAWN_VIZ_DIR")
        if out:
            out = os.path.join(out, "view-" + "-".join(str(v) for v in key))
        _cache[key] = h.compare(THEME, view, out_dir=out)
    return _cache[key]


def _check(view):
    m = _views(view)
    why = h.report(m)
    for other in ("preview", "editor"):
        assert abs(m[other]["ring"] - m["print"]["ring"]) <= RING_TOL, (
            "the %s's dashed ring is not the printed card's ring — which is the "
            "one measurement that made the same photo look a different size in "
            "each of the three places it is drawn:\n%s" % (other, why))
        for k in ("cx", "cy", "w", "h", "left", "top", "right", "bottom"):
            assert abs(m[other][k] - m["print"][k]) <= TOL, (
                "the %s puts the photo somewhere the printer does not (%s off by "
                "%.4f ring radii):\n%s" % (other, k, m[other][k] - m["print"][k], why))
        if m["print"]["halo"] is None or m[other]["halo"] is None:
            continue  # white paper: the white rim is invisible to a pixel scan
        assert abs(m[other]["halo"] - m["print"]["halo"]) <= HALO_TOL, (
            "the %s's white sticker edge is not the printed one's width:\n%s"
            % (other, why))
        assert m[other]["halo_solid"] >= HALO_SOLID_MIN, (
            "the %s's sticker edge is a soft glow, not the print's hard white "
            "rim:\n%s" % (other, why))
    return m


# --- pure: the numbers the three renderings share ---------------------------


def test_the_ring_is_the_slot_s_own_circle():
    # The dashed cut-line on the card is <circle r="33"> against a 66-unit slot —
    # the slot's inscribed circle. Anything else and the browser draws a circle
    # the printer will not cut.
    import re
    import card_assets
    import config
    svg = card_assets.read_svg(config.photo_card_path(THEME))
    slot = re.search(r'<image\b[^>]*\bid="photo-slot-1"[^>]*>', svg).group(0)
    attrs = dict(re.findall(r'([a-zA-Z:-]+)\s*=\s*"([^"]*)"', slot))
    ring = re.search(r'<circle class="cut-line"[^>]*>', svg).group(0)
    r = float(re.search(r'\br="([\d.]+)"', ring).group(1))
    assert abs(r * 2 - float(attrs["width"])) < 0.01, (r, attrs["width"])


def test_the_page_and_the_generator_agree_on_the_disc():
    # DISC_FILL in site/js/pawn-frame.js against PHOTO_DISC_FILL in build.py.
    # tests/unit/photo-card.test.js checks the same pair from the other side; both
    # exist because the two files are edited by different hands.
    import re
    import build
    js = h._read(os.path.join(h.SITE, "js", "pawn-frame.js"))
    fill = float(re.search(r"export const DISC_FILL = ([\d.]+);", js).group(1))
    assert abs(fill - build.PHOTO_DISC_FILL) < 1e-9, (fill, build.PHOTO_DISC_FILL)
    ring = float(re.search(r"export const RING_FILL = ([\d.]+);", js).group(1))
    assert ring == 1, ring


def test_the_stylesheet_takes_its_circles_from_the_module():
    # The two insets are the bug's own scene: the cut-line was a literal 5% — the
    # DISC's inset — sitting next to the disc's own 5%, which is exactly how they
    # came to be the same circle. Both now read the module, and the literals left
    # behind are fallbacks for the instant before it runs.
    css = h._read(os.path.join(h.SITE, "css", "pawn.css"))
    assert "inset: var(--pawn-disc-inset, 5%)" in css
    assert "inset: var(--pawn-ring-inset, 0%)" in css
    # The halo goes on the CIRCLE, never on the photo inside it: the circle clips
    # with overflow:hidden, and a filter on the clipped child is cut off at the
    # same rim — no white edge where the print has one.
    assert ".pawn-disc.is-cut,\n.pawn-live-slot.is-cut {" in css
    # …and the page has to actually hand them over.
    page = h._read(os.path.join(h.SITE, "collect.html"))
    assert "pawnCssVars()" in page


def test_the_page_places_every_photo_through_the_shared_geometry():
    # The harness renders its two browser panes with liveSlotStyle /
    # discPhotoStyle / haloFilter. It is only a test of the real page for as long
    # as the real page uses them too.
    page = h._read(os.path.join(h.SITE, "collect.html"))
    for fn in ("liveSlotStyle(", "discPhotoStyle(", "haloFilter("):
        assert fn in page, fn


def test_the_preview_card_measures_where_the_card_was_actually_drawn():
    # The discs are fractions of THE CARD and the layer they live in used to fill
    # the FRAME; those are the same rectangle only when the frame is the card's
    # shape. Handing the frame the card's own `aspect-ratio` was the first attempt
    # at that, and it works in Chrome ONLY: Safari leaves a `width: auto` box at
    # its full width and centres the picture inside it, so on an iPhone every pawn
    # was drawn 27% wider than tall and 22px clear of its printed cut-line. The
    # layer is measured onto the picture now (containRect / fitLiveSlots), and the
    # frame is sized BY the picture instead of by an assumed shape.
    page = h._read(os.path.join(h.SITE, "collect.html"))
    assert "containRect(" in page
    assert "function fitLiveSlots(" in page
    assert "classList.add('has-card')" in page


# --- with Chrome: the three renderings themselves ---------------------------


def test_the_three_renderings_agree_on_the_automatic_framing():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    _check(VIEWS[0])


def test_the_three_renderings_agree_once_the_buyer_has_moved_the_photo():
    if not _chrome():
        print("  (skipped: no Chrome)")
        return
    _check(VIEWS[1])


def test_the_measurement_is_sensitive_to_the_ring_and_not_only_to_the_photo():
    # A harness that cannot fail is a harness nobody can trust, and this is the
    # exact failure it exists for: the SAME photo, with the ring drawn at the
    # DISC's size instead of the slot's, which is how the editor circle shipped.
    #
    # Pure — no Chrome. Two synthetic crops, identical but for where the dashed
    # circle is, put through the very function the rendered panes go through.
    # Every check made before this harness measured the photo against its own
    # circle and so could not see this at all.
    from PIL import Image, ImageDraw
    side = h.NORM_PX
    paper = (244, 241, 235)

    slot_r = side * 0.5 * 0.98
    sub = slot_r * 0.47  # the SUBJECT never moves; only the ring around it does

    def crop(ring_r):
        im = Image.new("RGB", (side, side), paper)
        d = ImageDraw.Draw(im)
        c = side / 2.0
        d.ellipse([c - ring_r, c - ring_r, c + ring_r, c + ring_r],
                  outline=(150, 150, 150), width=3)
        d.ellipse([c - sub, c - sub * 1.5, c + sub, c + sub * 1.5],
                  fill=h.SUBJECT_RGB)
        return h.measure(im)

    slot_ring = crop(slot_r)                 # the cut-line where the card cuts
    disc_ring = crop(slot_r * h.DISC_FILL)   # …and where the row used to draw it
    assert abs(slot_ring["ring"] - disc_ring["ring"]) > RING_TOL, (
        slot_ring["ring"], disc_ring["ring"])
    assert abs(slot_ring["w"] - disc_ring["w"]) > TOL, (
        "the subject's size against its ring has to move when the ring does, or "
        "none of the assertions above can see the bug this module was written "
        "for: %.4f vs %.4f" % (slot_ring["w"], disc_ring["w"]))


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok", name)
