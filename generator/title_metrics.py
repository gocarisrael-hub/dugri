"""How wide will Chrome actually draw this title?

THE GAP THIS CLOSES. The title is sized to fill its calibrated box, and that fit
measures with Pillow. Chrome is what draws the card, and for some faces it lays
the same string out WIDER than Pillow reports — measured on סנטוריני's brush face
(GveretLevin) at 60px:

    ליאתי מלכת המשחקים   Pillow 455   Chrome 490   +7.7%
    ליאתי מלכת           Pillow 220   Chrome 272   +23.6%
    יעל חוגגת יוֹבל       Pillow 315   Chrome 320   +1.6%
    אבגדהוזחטיכלמנסעפצ   Pillow 531   Chrome 540   +1.7%

So "shrink until it fits" already ran — it shrank to the wrong target. It stopped
where PILLOW said the title fit, and Chrome then drew it past the box edge: on a
real card the owner's "ליאתי מלכת המשחקים" started exactly on the box's left edge
and ran 2.2mm out the right one, which reads as a title shoved to one side.

The gap is not a constant to bake in. It swings from 1.02x to 1.24x WITHIN one
font, so a per-template safety margin would over-shrink short titles and still
let long ones through. The only number worth shrinking to is the one Chrome
gives, so this asks Chrome — once per order, not once per card.

IT ONLY EVER SHRINKS. Where Chrome draws NARROWER than Pillow expects the ratio
is clamped to 1.0 and the title keeps the size it has today. That is deliberate:
this change exists to stop titles overflowing, and letting it also GROW type
would re-size every title on every template on the strength of one measurement.
"""
import os
import shutil
import tempfile

# The size the probe is drawn at. Big enough that a pixel of antialiasing is
# noise rather than signal; small enough to screenshot instantly.
PROBE_SIZE = 120.0
# Canvas for one probe line. Wide, because the whole point is that a line can be
# wider than expected — a line clipped by the canvas would measure NARROW and
# hand back a ratio that says "no correction needed", which is the one wrong
# answer this must never give.
PROBE_W, PROBE_H = 4000, 320
PROBE_SCALE = 1

# (font, alt, weight, lines) -> answer. A deck asks for the same title on every
# one of its ~104 cards; without this that is 104 Chrome runs for one answer.
#
# Capped, because this module can be imported into a long-lived process: the
# generator itself is a short subprocess per order, but nothing stops a server
# from importing it, and an unbounded dict keyed by buyer-supplied text is a slow
# leak. Oldest-out is fine — a deck asks for one title over and over, so the
# entry that matters is always the one just added.
_CACHE = {}
_CACHE_MAX = 256


def _doc(font_path, alt_font_path, weight, lines, italic=False):
    """One SVG, each line on its own band, drawn at PROBE_SIZE.

    Deliberately NO outline stroke and NO emulated bold, though the card may draw
    both: the number being corrected is the run's glyph width, and the fit
    already reserves the paint's own growth separately (title_paint_grow). A
    probe that painted the ring would fold that reservation in twice and
    over-shrink the title. Italic IS drawn, because a slanted face genuinely
    lays the glyphs out differently and nothing else accounts for it.
    """
    import base64
    faces = []
    for fam, path in (("TFm", font_path), ("TFa", alt_font_path)):
        if not path or not os.path.exists(path):
            continue
        b64 = base64.b64encode(open(path, "rb").read()).decode()
        w = f"font-weight:{weight};" if weight else ""
        faces.append(f"@font-face{{font-family:{fam};{w}"
                     f"src:url(data:font/ttf;base64,{b64});}}")
    body = []
    for i, line in enumerate(lines):
        y = PROBE_H * (i + 0.72)
        it = ' font-style="italic"' if italic else ""
        body.append(f'<text x="{PROBE_W/2}" y="{y}" font-family="TFm,TFa" '
                    f'font-size="{PROBE_SIZE}" fill="#000"{it} '
                    f'text-anchor="middle">{_esc(line)}</text>')
    h = PROBE_H * max(1, len(lines))
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {PROBE_W} {h}" '
            f'width="{PROBE_W}" height="{h}">'
            f'<style>{"".join(faces)}</style>'
            f'<rect width="{PROBE_W}" height="{h}" fill="#fff"/>'
            f'{"".join(body)}</svg>')


def _esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def _ink_spans(png, count):
    """Per band: ink width, and how far the ink's centre sits from the anchor.

    The probe draws each line ``text-anchor="middle"`` at the canvas centre —
    the same anchoring the card uses — so the second number IS the error the
    card would show: how far the drawn ink lands from where it was anchored.
    """
    from PIL import Image
    im = Image.open(png).convert("L")
    band = im.height // count
    out = []
    for i in range(count):
        strip = im.crop((0, i * band, im.width, (i + 1) * band))
        bbox = strip.point(lambda v: 255 if v < 200 else 0).getbbox()
        if not bbox:
            out.append((0.0, 0.0))
            continue
        x0, x1 = bbox[0] / PROBE_SCALE, bbox[2] / PROBE_SCALE
        out.append((x1 - x0, (x0 + x1) / 2 - PROBE_W / 2))
    return out


def probe(font_path, lines, face, alt_font_path=None, weight=None,
          italic=False):
    """Per line: ``(width_ratio, centre_offset)`` as measured off a real render.

    ``width_ratio`` is how much wider Chrome draws the line than the fit expects,
    never below 1.0. ``centre_offset`` is how far the drawn ink lands from the
    point it was anchored at, PER UNIT OF FONT SIZE — multiply by the size in use
    and shift the anchor back by it, and the ink straddles the box centre.

    The offset is why this exists at all rather than a width fudge: correcting
    the overflow alone left the owner's title fitting its box and still sitting
    1.8mm to one side, because the run is centred by its ADVANCE and its ink is
    not symmetric within that advance. Both numbers come off the same render, so
    neither is an opinion about the other.

    ``face`` is the same Face the fit measures with, so the denominator is
    EXACTLY the number the fit will use — not a second opinion about it. A ratio
    is only ever >= 1 (see the module docstring), and every failure path answers
    1.0, which is today's behaviour: a title that cannot be measured must still
    be drawn.
    """
    lines = [ln for ln in (lines or []) if ln and ln.strip()]
    if not lines:
        return {}
    key = (font_path, alt_font_path, weight, italic, tuple(lines))
    if key in _CACHE:
        return _CACHE[key]
    out = {ln: (1.0, 0.0) for ln in lines}
    # NO FACE, NO MEASUREMENT. With the @font-face missing Chrome cheerfully
    # draws the line in a fallback face and the probe would hand back a
    # correction measured off a font the card will never use — worse than no
    # correction, because it looks like one.
    if not font_path or not os.path.exists(font_path):
        _CACHE[key] = out
        return out
    d = None
    try:
        import chrome
        d = tempfile.mkdtemp(prefix="titlewidth-")
        svg = os.path.join(d, "probe.svg")
        png = os.path.join(d, "probe.png")
        with open(svg, "w", encoding="utf-8") as f:
            f.write(_doc(font_path, alt_font_path, weight, lines, italic))
        chrome.screenshot(svg, png, PROBE_W, PROBE_H * len(lines),
                          scale=PROBE_SCALE, what="title-width")
        drawn = _ink_spans(png, len(lines))
        for line, (got, off) in zip(lines, drawn):
            want = face.getlength(line) / face.ref * PROBE_SIZE
            # A zero width means the probe told us nothing — a face that did not
            # load, an empty raster. Correcting by it would be worse than not
            # correcting at all, so that line keeps today's numbers.
            if got > 0 and want > 0:
                out[line] = (max(1.0, got / want), off / PROBE_SIZE)
    except Exception:
        # Chrome missing, a timeout, a font that will not load: the title still
        # has to be drawn, and drawn as it is drawn today.
        pass
    finally:
        # The probe SVG carries the whole font inline as base64 — tens of KB a
        # time, on the same volume the orders live on. Left behind, one per
        # order, that is a slow disk leak nobody would think to look for.
        if d:
            shutil.rmtree(d, ignore_errors=True)
    if len(_CACHE) >= _CACHE_MAX:
        _CACHE.pop(next(iter(_CACHE)))
    _CACHE[key] = out
    return out


def clear_cache():
    _CACHE.clear()
