#!/usr/bin/env python3
"""THE COMPARISON HARNESS: the same pawn photo, rendered all three ways.

WHY THIS EXISTS. A buyer's photo is drawn three times over on the collection
page's photos tab, by three different pieces of code:

  1. the PRINTED card — ``build.square_photo`` plus the photo-card SVG, rendered
     by the generator. This is the truth; everything else is a promise about it.
  2. the PREVIEW CARD at the top of the tab — a server-rendered BASE card with
     empty discs, with the photos laid over it in the browser
     (``paintPawnCard`` in site/collect.html, positioned by ``placePawn``).
  3. the EDITOR CIRCLE in each row below it — ``.pawn-pad`` / ``.pawn-disc`` /
     ``.pawn-cut-line``, positioned by the same ``placePawn``.

The owner reported, repeatedly and correctly, that the three did not agree: "the
girl is positioned exactly in the middle here but in here it's more to the left",
"the circle itself is not centred and sitting correctly on the card". Every
attempt to chase that down by eye — and several by measurement — compared each
photo to ITS OWN circle, which is precisely the comparison that comes out
identical no matter how far apart the three have drifted. What was different was
the CIRCLE: the editor drew its dashed cut-line at the disc's size instead of the
slot's, so the same photo filled its ring there and sat inside its ring on the
card next to it.

So this measures every photo AGAINST ITS RING, and the ring is found in the
pixels rather than assumed. Three renderings, normalised to the same size and
aligned on the dashed ring; then, per slot, the subject's box relative to that
ring. If they drift apart again, the numbers say so and by how much.

IT ALSO MEASURES THE WHITE STICKER EDGE, which is only possible because a deck's
card paper is a warm off-white and the halo is #ffffff. On a theme whose paper IS
white there is no signal to find and the halo comes back ``None`` rather than
zero — "unmeasurable", not "missing".

THE HALO IS WHY THE FILTER MOVED. It used to sit on the ``<img>``, inside a
circle that clips with ``overflow: hidden`` — so wherever the subject reached the
rim (which is every zoomed-in photo) the browser cut the white edge off at the
same line it cut the photo, while the print's dilate runs outward from there into
the gap between disc and cut-line. Measured on a zoomed photo: half the print's
halo, missing entirely along the arc. Filtering the CLIPPING element instead
paints outside its own overflow and matches.

Run it for its own sake to look at the pictures:

    python3 generator/pawn_three_views.py --out /tmp/pawnviz

The assertions live in generator/test_pawn_three_views.py, which imports this.
"""
import base64
import json
import math
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SITE = os.path.join(REPO, "site")

# Every measurement is taken on a crop of the SLOT — the square the card gives
# one photo — resampled to this many pixels a side, so the three panes are
# directly comparable and the visual diff can be stacked.
NORM_PX = 512

# The card picture the browser pane is laid out at. The base card PNG comes back
# at 448x624 (preview.CARD_MAX_W), and rendering it at its own pixel size keeps
# the browser from resampling it — one fewer difference between the panes that is
# nothing to do with the geometry under test.
CARD_SCALE = 1

# Chrome's device scale for the browser pane. 2 buys sub-CSS-pixel precision on
# the ring, which matters: the editor's ring is a 1.5px border and the card's is
# a 0.6-unit dashed stroke.
SHOT_SCALE = 2

# The synthetic photo. A hard-edged opaque blob on transparency: the point of the
# harness is WHERE the picture lands, and a blob of one exact colour can be found
# in a screenshot to the pixel, where a real photograph has to be segmented
# before it can be measured at all. Deliberately off-centre in a non-square
# canvas, because a subject in the middle of a square hides every translation
# bug there is.
SUBJECT_RGB = (0, 32, 220)
PHOTO_W, PHOTO_H = 300, 420

# What share of the slot the photo's disc takes, mirrored from build.PHOTO_DISC_FILL
# so the harness can describe the geometry it is measuring without importing the
# generator for a constant.
DISC_FILL = 0.90


def _import_generator():
    if HERE not in sys.path:
        sys.path.insert(0, HERE)


def pick_theme():
    """A real theme to render the comparison on.

    Not "demo": the throwaway test store's card paper is plain white, and the
    sticker halo is white, so on it the halo cannot be measured at all — it is
    the same colour as the page it is printed on. A shipped theme has the warm
    paper the deck actually prints on, which is what makes the white rim visible
    to a pixel scan.

    Chosen by what is THERE rather than by name, so renaming a template does not
    fail this. DUGRI_PAWN_VIEW_THEME overrides for a run by hand.
    """
    _import_generator()
    import config
    want = os.environ.get("DUGRI_PAWN_VIEW_THEME")
    names = [want] if want else list(config.load_themes())
    for name in names:
        try:
            cfg = config.theme(name)
            config.ensure_calibrated(cfg)
            if os.path.exists(config.photo_card_path(name)):
                return name
        except Exception:
            continue
    raise AssertionError("no calibrated theme with a photo card to compare on")


def synthetic_photo(path):
    """A cut-out-shaped PNG whose subject can be found exactly. Returns the path."""
    from PIL import Image, ImageDraw
    im = Image.new("RGBA", (PHOTO_W, PHOTO_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    # A head and a shoulder-line: taller than wide, off to one side and high up,
    # so a rendering that centres on the box rather than on the subject, or that
    # frames on width rather than reach, comes out visibly different.
    #
    # ONE CONNECTED BLOB, and this is load-bearing. Both sides pick the silhouette
    # nearest the middle of the frame when a cut leaves several, but only the
    # GENERATOR erases the ones it did not pick — the browser can only choose
    # where to put the file, which is the known, documented difference at the head
    # of site/js/pawn-frame.js. A two-blob photo would measure that difference and
    # report it as the geometry drifting, which it is not.
    d.ellipse([40, 30, 190, 200], fill=SUBJECT_RGB + (255,))
    d.polygon([(20, 330), (60, 170), (170, 170), (215, 330)], fill=SUBJECT_RGB + (255,))
    im.save(path)
    return path


def _b64(path):
    with open(path, "rb") as f:
        return base64.b64encode(f.read()).decode("ascii")


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


# --- the three renderings ---------------------------------------------------


def print_card(theme, photo, view, out_dir):
    """The PRINTED card, through the generator's own composition.

    ``{"png": path, "slots": [...]}`` — the slots being ``preview.pawn_slots``,
    fractions of the card, one square per photo.
    """
    _import_generator()
    import preview
    r = preview.pawn_card(theme, [photo], workdir=out_dir, views=[view])
    return {"png": r["pawns"], "slots": r["slots"]}


def base_card(theme, drawn, out_dir):
    """The card WITHOUT the buyer's photos — exactly what ``?live=1`` returns.

    The first ``drawn`` slots are left bare and the rest carry the shipped Dugri
    pawns, which is what the printed card does with a short list. Mirrors
    preview.py's ``--pawn-card --no-photos`` branch.
    """
    _import_generator()
    import build as buildmod
    import config
    import preview
    import render_page as rp
    photos = [None] * drawn + buildmod.fallback_photos(theme, drawn)
    out = os.path.join(out_dir, "base.png")
    os.makedirs(out_dir, exist_ok=True)
    rp.render_single_card(theme, config.photo_card_path(theme), [], [],
                          out, kind="photo", photos=photos)
    preview._downscale(out, preview.CARD_MAX_W)
    return out


def _page_css():
    """The collection page's own pawn rules, plus the tokens they lean on.

    Read from the files the page links, never copied: a harness carrying its own
    copy of the geometry agrees with itself and with nothing else, which is how
    the two previews came to disagree in the first place.
    """
    return "\n".join([
        _read(os.path.join(SITE, "css", "tokens.css")),
        _read(os.path.join(SITE, "css", "pawn.css")),
    ])


def browser_page(base_png, photo_png, slots, view, card_w, card_h):
    """The HTML the two BROWSER panes are screenshotted from.

    Both panes are built from the page's own stylesheet and the page's own
    geometry module — ``liveSlotStyle`` / ``discPhotoStyle`` / ``haloFilter`` /
    ``pawnCssVars`` out of site/js/pawn-frame.js, which is what collect.html
    calls. What the harness supplies is the DOM shape and nothing else, and
    tests/unit/pawn-three-views.test.js pins that the real page builds the same
    shape out of the same calls.

    Everything is absolutely positioned at known pixel coordinates so the crops
    can be taken without asking the browser where anything ended up.
    """
    module = _read(os.path.join(SITE, "js", "pawn-frame.js"))
    css = _page_css()
    photo_url = "data:image/png;base64," + _b64(photo_png)
    base_url = "data:image/png;base64," + _b64(base_png)
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body {{ margin: 0; padding: 0; background: #7a7a7a; }}
  #card {{ position: absolute; left: 20px; top: 20px;
           width: {card_w}px; height: {card_h}px; }}
  #card > img {{ width: 100%; height: 100%; display: block; }}
  #row {{ position: absolute; left: {card_w + 60}px; top: 20px; }}
{css}
</style></head><body>
<div id="card"><img id="cardimg"><div class="pawn-live-slots" id="live"></div></div>
<div id="row"><div class="pawn-pad" id="pad">
  <div class="pawn-disc" id="disc"><img id="rowimg"></div>
  <span class="pawn-cut-line"></span>
</div></div>
<script type="module">
{module}

const SLOTS = {json.dumps(slots)};
const VIEW = {json.dumps(view)};
const PHOTO = {json.dumps(photo_url)};

for (const [k, v] of Object.entries(pawnCssVars())) {{
  document.documentElement.style.setProperty(k, v);
}}
document.getElementById('cardimg').src = {json.dumps(base_url)};

// The frame is measured the way the page measures it — the real frameFromBlob
// over the real bytes — so the harness cannot accidentally hand the two panes a
// frame the page would never have computed.
const frame = await frameFromBlob(await (await fetch(PHOTO)).blob());

function paint(disc, img, slotPx) {{
  img.src = PHOTO;
  const s = discPhotoStyle(frame, VIEW);
  img.style.width = s.width;
  img.style.height = s.height;
  img.style.left = s.left;
  img.style.top = s.top;
  img.style.objectFit = s.objectFit;
  disc.classList.add('is-cut');
  disc.style.setProperty('--pawn-halo', haloFilter(slotPx));
}}

// PANE 1 — the preview card: the base card with a disc laid over slot 1.
const live = document.getElementById('live');
const el = document.createElement('div');
el.className = 'pawn-live-slot';
const cardImg = document.createElement('img');
el.appendChild(cardImg);
live.appendChild(el);
Object.assign(el.style, liveSlotStyle(SLOTS[0]));
paint(el, cardImg, el.getBoundingClientRect().width / DISC_FILL);

// PANE 2 — the editor row.
const disc = document.getElementById('disc');
paint(disc, document.getElementById('rowimg'),
      disc.getBoundingClientRect().width / DISC_FILL);
</script></body></html>
"""


def shoot(html, png, width, height):
    """Screenshot a harness page through the generator's own Chrome wrapper."""
    _import_generator()
    import chrome
    chrome.screenshot(html, png, width, height, scale=SHOT_SCALE,
                      what="pawn three-view harness")
    return png


# --- measurement ------------------------------------------------------------


def _crop_norm(im, box):
    """``box`` (a pixel rect) resampled to NORM_PX square, in RGB."""
    from PIL import Image
    return im.convert("RGB").crop(box).resize((NORM_PX, NORM_PX), Image.LANCZOS)


def _is_subject(px, tol=70):
    r, g, b = px[0], px[1], px[2]
    return (abs(r - SUBJECT_RGB[0]) < tol and abs(g - SUBJECT_RGB[1]) < tol
            and abs(b - SUBJECT_RGB[2]) < tol)


def measure(crop, bg=None):
    """What one normalised slot crop contains.

    ``ring`` is the radius of the dashed cut-line, as a fraction of the crop's
    side; ``subject`` is the blob's bounding box in RING RADII from the crop's
    centre — which is the only frame of reference in which the three renderings
    are answering the same question.

    The ring is found rather than assumed: it is the OUTERMOST thing in the crop
    that is not the background (the card's paper, or the row's pad), because
    everything else the crop contains — the photo, its disc, its white edge —
    lives inside it by construction.

    ``halo`` is the white sticker edge, as a mean width in ring radii: the area
    of pixels whiter than the background, over the subject's own perimeter. It is
    measurable at all only because the card's paper is a warm off-white and the
    halo is #ffffff; ``halo_solid`` is the share of it that actually reaches
    white, which is how a soft browser approximation is told apart from the
    print's hard dilate.
    """
    w, h = crop.size
    px = crop.load()
    if bg is None:
        bg = px[1, 1]
    # A white halo on white paper is not a faint halo, it is an unmeasurable one:
    # there is no signal to find. Say so rather than reporting zero, which reads
    # as "the rim is missing".
    bg_min = min(bg)
    measurable = bg_min < 249

    def differs(p):
        return (abs(p[0] - bg[0]) + abs(p[1] - bg[1]) + abs(p[2] - bg[2])) > 24

    cx = cy = (w - 1) / 2.0
    ring = 0.0
    halo = 0
    halo_solid = 0
    sx0, sy0, sx1, sy1 = w, h, -1, -1
    for y in range(h):
        dy = y - cy
        for x in range(w):
            p = px[x, y]
            if min(p) > bg_min + 6 and not _is_subject(p):
                halo += 1
                if min(p) >= 250:
                    halo_solid += 1
            if _is_subject(p):
                if x < sx0:
                    sx0 = x
                if x > sx1:
                    sx1 = x
                if y < sy0:
                    sy0 = y
                if y > sy1:
                    sy1 = y
            elif differs(p):
                d = math.hypot(x - cx, dy)
                if d > ring:
                    ring = d
    if sx1 < 0 or ring <= 0:
        raise AssertionError("nothing found in the crop: subject=%s ring=%s"
                             % ((sx0, sy0, sx1, sy1), ring))
    # Everything from here on is in RING RADII from the crop's centre. Pixel
    # indices are treated as pixel CENTRES throughout, which is also how the ring
    # was measured, so the two are on the same footing.
    r = float(ring)
    # The silhouette's own perimeter, so the halo's AREA can be turned into a
    # width. Counted as subject pixels with a non-subject neighbour, which
    # over-counts a diagonal edge by about root-2 — identically in all three
    # panes, and the harness only ever compares them with each other.
    perim = 0
    for y in range(sy0, sy1 + 1):
        for x in range(sx0, sx1 + 1):
            if not _is_subject(px[x, y]):
                continue
            if (not _is_subject(px[max(0, x - 1), y])
                    or not _is_subject(px[min(w - 1, x + 1), y])
                    or not _is_subject(px[x, max(0, y - 1)])
                    or not _is_subject(px[x, min(h - 1, y + 1)])):
                perim += 1
    return {
        "ring": ring / w,
        "left": (sx0 - cx) / r,
        "top": (sy0 - cy) / r,
        "right": (sx1 - cx) / r,
        "bottom": (sy1 - cy) / r,
        "cx": ((sx0 + sx1) / 2.0 - cx) / r,
        "cy": ((sy0 + sy1) / 2.0 - cy) / r,
        "w": (sx1 - sx0) / r,
        "h": (sy1 - sy0) / r,
        "halo": (halo / perim / r) if (measurable and perim) else None,
        "halo_solid": (halo_solid / halo) if (measurable and halo) else None,
    }


def compare(theme=None, view=(1.0, 0.0, 0.0), out_dir=None):
    """Render all three, measure all three, and return the numbers.

    ``{"print": {...}, "preview": {...}, "editor": {...}, "crops": {...}}`` —
    the three measurements plus where the normalised crops were written.
    """
    from PIL import Image
    theme = theme or pick_theme()
    own = out_dir is None
    out_dir = out_dir or tempfile.mkdtemp(prefix="dugri-3view-")
    os.makedirs(out_dir, exist_ok=True)

    photo = synthetic_photo(os.path.join(out_dir, "photo.png"))
    pv = None if tuple(view) == (1.0, 0.0, 0.0) else tuple(view)

    printed = print_card(theme, photo, pv, out_dir)
    slots = printed["slots"]
    base = base_card(theme, 1, out_dir)

    pim = Image.open(printed["png"])
    bim = Image.open(base)
    card_w, card_h = bim.size
    geo = slots[0]
    # The SLOT square, in the print's own pixels.
    box = (round(geo["x"] * pim.width), round(geo["y"] * pim.height),
           round((geo["x"] + geo["w"]) * pim.width),
           round((geo["y"] + geo["h"]) * pim.height))
    print_crop = _crop_norm(pim, box)

    html = os.path.join(out_dir, "harness.html")
    with open(html, "w", encoding="utf-8") as f:
        f.write(browser_page(base, photo, slots,
                             {"zoom": view[0], "dx": view[1], "dy": view[2], "bg": False},
                             card_w, card_h))
    shot = os.path.join(out_dir, "browser.png")
    shoot(html, shot, card_w + 60 + 160, max(card_h, 200) + 60)

    sim = Image.open(shot)
    s = SHOT_SCALE
    # PANE 1 — the same fractional slot rect, on the card image at (20, 20).
    pbox = (round((20 + geo["x"] * card_w) * s), round((20 + geo["y"] * card_h) * s),
            round((20 + (geo["x"] + geo["w"]) * card_w) * s),
            round((20 + (geo["y"] + geo["h"]) * card_h) * s))
    preview_crop = _crop_norm(sim, pbox)
    # PANE 2 — the pad IS the slot: 116 CSS px at (card_w + 60, 20).
    pad = 116
    ebox = (round((card_w + 60) * s), round(20 * s),
            round((card_w + 60 + pad) * s), round((20 + pad) * s))
    editor_crop = _crop_norm(sim, ebox)

    out = {
        "theme": theme,
        "print": measure(print_crop),
        "preview": measure(preview_crop),
        "editor": measure(editor_crop),
        "dir": out_dir,
        "own_dir": own,
    }
    for name, crop in (("print", print_crop), ("preview", preview_crop),
                       ("editor", editor_crop)):
        crop.save(os.path.join(out_dir, "norm-%s.png" % name))
    _visual_diff(out_dir, print_crop, preview_crop, editor_crop, out)
    return out


def _visual_diff(out_dir, a, b, c, m):
    """Three panes side by side, plus the three silhouettes stacked on one ring.

    The stack is the picture that actually answers the question: each rendering's
    subject is scaled so its OWN ring becomes the same circle, and then they are
    drawn over each other in red (print), green (preview) and blue (editor). Any
    colour you can see on its own is a rendering that disagrees with the print.
    """
    from PIL import Image, ImageDraw
    gap = 12
    strip = Image.new("RGB", (NORM_PX * 3 + gap * 4, NORM_PX + gap * 2), (40, 40, 40))
    for i, im in enumerate((a, b, c)):
        strip.paste(im, (gap + i * (NORM_PX + gap), gap))
    strip.save(os.path.join(out_dir, "panes.png"))

    stack = Image.new("RGB", (NORM_PX, NORM_PX), (0, 0, 0))
    sp = stack.load()
    ref = NORM_PX * 0.45  # where every ring is put, in the stacked picture
    for idx, (name, im) in enumerate((("print", a), ("preview", b), ("editor", c))):
        ring = m[name]["ring"] * NORM_PX
        k = ref / ring
        src = im.load()
        cen = (NORM_PX - 1) / 2.0
        for y in range(NORM_PX):
            sy = cen + (y - cen) / k
            if not (0 <= sy < NORM_PX):
                continue
            for x in range(NORM_PX):
                sx = cen + (x - cen) / k
                if not (0 <= sx < NORM_PX):
                    continue
                if _is_subject(src[int(sx), int(sy)]):
                    p = list(sp[x, y])
                    p[idx] = 255
                    sp[x, y] = tuple(p)
    d = ImageDraw.Draw(stack)
    d.ellipse([NORM_PX / 2 - ref, NORM_PX / 2 - ref, NORM_PX / 2 + ref, NORM_PX / 2 + ref],
              outline=(255, 255, 255))
    stack.save(os.path.join(out_dir, "stack.png"))


def report(m):
    """The numbers, as a table a human can read in a CI log."""
    keys = ("ring", "cx", "cy", "w", "h", "left", "top", "right", "bottom",
            "halo", "halo_solid")
    def cell(v):
        return "       -" if v is None else "%8.4f" % v

    rows = ["%-9s %s" % ("", " ".join("%8s" % k for k in keys))]
    for name in ("print", "preview", "editor"):
        rows.append("%-9s %s" % (name, " ".join(cell(m[name][k]) for k in keys)))
    for name in ("preview", "editor"):
        rows.append("%-9s %s" % ("Δ " + name, " ".join(
            cell(None if m[name][k] is None or m["print"][k] is None
                 else m[name][k] - m["print"][k]) for k in keys)))
    rows.append("theme %s — crops + visual diff: %s" % (m.get("theme"), m["dir"]))
    return "\n".join(rows)


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--theme", default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--zoom", type=float, default=1.0)
    ap.add_argument("--dx", type=float, default=0.0)
    ap.add_argument("--dy", type=float, default=0.0)
    args = ap.parse_args()
    m = compare(args.theme, (args.zoom, args.dx, args.dy), out_dir=args.out)
    print(report(m))


if __name__ == "__main__":
    main()
