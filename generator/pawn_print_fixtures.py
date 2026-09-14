#!/usr/bin/env python3
"""The fixtures that hold site/js/pawn-print.js to build.square_photo's crop.

site/js/pawn-print.js repeats the generator's framing in the buyer's browser so
the pawn she approves is the pawn that prints. Two implementations of one rule
drift unless something holds them together, and a transcription of the Python
into a test only proves the transcription agrees with itself. So the generator
answers, on real images, and both sides are checked against those answers:

  * generator/test_pawn_print_fixtures.py fails when build.py stops giving them;
  * tests/unit/pawn-print.test.js fails when the browser module stops giving them.

Regenerate after a deliberate change to the framing (from the repo root):

    python3 generator/pawn_print_fixtures.py

Every image is drawn here, deterministically, so a regenerated set is byte-for-byte
the same unless build.py changed.
"""
import hashlib
import json
import os
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
OUT = os.path.join(REPO, "tests", "unit", "fixtures", "pawn-print")
sys.path.insert(0, HERE)

import build  # noqa: E402

# Buyer adjustments applied to every fixture's automatic crop: none, and a spread
# of zooms and pans chosen so Python's half-to-even rounding is actually exercised.
VIEWS = [None, (1.37, 0.113, -0.05), (0.62, -0.4, 0.31), (2.2, 0.25, 0.25), (1.5, 0.0, 0.0),
         (0.5, 1.0, -1.0), (1.25, 0.125, 0.375)]

# Pillow BILINEAR resizes of a fixed pattern: the generator resamples its masks
# with it, so the browser's port has to reproduce it to the byte.
RESAMPLE = [((313, 217), (100, 69)), ((200, 120), (129, 77)), ((50, 40), (123, 97)),
            ((900, 1), (200, 1)), ((7, 333), (3, 200)), ((64, 64), (64, 20))]


def pattern(w, h):
    return bytes(((x * 7 + y * 13 + (x * y) % 11) % 256) for y in range(h) for x in range(w))


def _soft(im, radius):
    im = im.copy()
    im.putalpha(im.getchannel("A").filter(ImageFilter.GaussianBlur(radius)))
    return im


def _person(draw, cx, top, scale, fill_head, fill_body):
    r = 70 * scale
    draw.ellipse([cx - r, top, cx + r, top + 2 * r], fill=fill_head)
    draw.rounded_rectangle([cx - 115 * scale, top + 1.8 * r, cx + 115 * scale,
                            top + 1.8 * r + 420 * scale], int(40 * scale), fill=fill_body)


def images():
    """``name -> (RGBA image, cutout flag)``."""
    out = {}

    im = Image.new("RGBA", (600, 800), (0, 0, 0, 0))
    _person(ImageDraw.Draw(im), 400, 150, 1.0, (200, 120, 90, 255), (40, 80, 160, 255))
    out["portrait-offcentre"] = (_soft(im, 2), True)

    im = Image.new("RGBA", (900, 700), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    _person(d, 470, 120, 1.0, (210, 150, 110, 255), (160, 40, 60, 255))
    _person(d, 120, 260, 0.7, (90, 90, 90, 255), (20, 120, 40, 255))  # the bystander
    out["bystander"] = (_soft(im, 1.5), True)

    im = Image.new("RGBA", (500, 500), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rectangle([248, 248, 253, 253], fill=(255, 0, 0, 255))  # a speck at dead centre
    _person(d, 360, 150, 0.6, (230, 180, 140, 255), (60, 60, 200, 255))
    out["speck-at-centre"] = (im, True)

    im = Image.new("RGBA", (500, 400), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    _person(d, 150, 60, 0.55, (200, 160, 120, 255), (120, 60, 20, 255))
    _person(d, 330, 90, 0.55, (180, 140, 100, 255), (20, 60, 120, 255))
    out["two-people"] = (_soft(im, 1), True)

    im = Image.new("RGBA", (150, 180), (0, 0, 0, 0))
    _person(ImageDraw.Draw(im), 70, 20, 0.2, (220, 170, 130, 255), (90, 30, 30, 255))
    out["small"] = (_soft(im, 0.8), True)

    im = Image.new("RGBA", (480, 640), (90, 140, 60, 255))
    _person(ImageDraw.Draw(im), 240, 120, 0.8, (220, 170, 130, 255), (30, 30, 90, 255))
    out["opaque-cutout"] = (im, True)

    out["original-with-alpha"] = (out["portrait-offcentre"][0], False)

    im = Image.new("RGBA", (800, 500), (200, 210, 230, 255))
    _person(ImageDraw.Draw(im), 300, 40, 0.8, (220, 170, 130, 255), (130, 30, 30, 255))
    out["landscape-original"] = (im, False)

    out["empty"] = (Image.new("RGBA", (300, 300), (0, 0, 0, 0)), True)

    im = Image.new("RGBA", (400, 400), (10, 10, 10, 255))
    ImageDraw.Draw(im).rectangle([0, 0, 0, 0], fill=(0, 0, 0, 0))  # 1 transparent pixel
    out["nearly-opaque"] = (im, True)
    return out


def expected(im, cutout):
    w, h = im.size
    found = build.subject_box(im) if cutout else None
    if found:
        box, alpha = found
        crop = build.subject_window(box, alpha=alpha)
        erased = alpha.tobytes() != im.getchannel("A").tobytes()
        sha = hashlib.sha1(alpha.tobytes()).hexdigest()
    else:
        crop, erased, sha = build.plain_crop(w, h), False, None
    return {
        "width": w,
        "height": h,
        "cutout": cutout,
        "framed": bool(found),
        "crop": list(crop),
        "erased": erased,
        "alpha_sha1": sha,
        "views": [[list(v) if v else None, list(build.apply_photo_view(crop, v))]
                  for v in VIEWS],
    }


def resample_expected():
    out = []
    for (w, h), (W, H) in RESAMPLE:
        src = Image.frombytes("L", (w, h), pattern(w, h))
        res = src.resize((W, H), Image.BILINEAR).tobytes()
        out.append({"from": [w, h], "to": [W, H], "sha1": hashlib.sha1(res).hexdigest()})
    return out


def compute():
    """The whole expected.json document, from the images on disk."""
    doc = {"images": {}, "resample": resample_expected()}
    for name, (_, cutout) in sorted(images().items()):
        with Image.open(os.path.join(OUT, name + ".png")) as im:
            doc["images"][name] = expected(im.convert("RGBA"), cutout)
    return doc


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, (im, _) in images().items():
        im.save(os.path.join(OUT, name + ".png"), optimize=True)
    with open(os.path.join(OUT, "expected.json"), "w", encoding="utf-8") as f:
        json.dump(compute(), f, indent=1)
        f.write("\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
