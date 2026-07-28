#!/usr/bin/env python3
"""Shared-image de-duplication for card SVGs.

WHY THIS EXISTS
---------------
Canva exports every card as a self-contained SVG with its background raster
embedded as a base64 data URI. The eight fronts of a template differ only by a
thin icon layer, so all eight embed the SAME ~5 MB PNG — and each ships twice
(``clean/`` and ``filled/``). For grapefruit that is 124 MB of SVG carrying
8.6 MB of unique pixels; multiplied by eight templates it is ~1 GB on the
DATA_DIR volume, in the Docker image, and re-parsed on every render.

The fix is to store each distinct image ONCE under ``<template>/assets/<sha>.png``
and have the SVGs reference it:

    <template>/clean/2.svg    href="../assets/<sha>.png"
    <template>/filled/2.svg   href="../assets/<sha>.png"
    <template>/assets/<sha>.png

Chrome — the renderer — resolves that relative reference against the SVG's own
location, and the rasterised output is byte-identical to the embedded original.

THE ONE CATCH
-------------
``render_page.render`` writes its composed SVG to the OUTPUT directory, not next
to the artwork, and a relative href does not survive that move: the background
silently vanishes and the card renders bare. So a de-duplicated SVG must never
be read with a plain ``open()``. Use :func:`read_svg`, which rewrites every
``../assets/`` reference to an absolute path as it reads, making the text safe to
write anywhere. Absolute paths and ``file://`` URLs both render identically to
the embedded original; the plain absolute path is used because it needs no
escaping of a Windows-or-POSIX distinction downstream.

:func:`read_svg` is deliberately safe on artwork that was never migrated — an SVG
with its images still embedded has no ``../assets/`` references, so the rewrite
is a no-op and the text is returned verbatim. Callers therefore never need to ask
which form a template is in.
"""
import base64
import hashlib
import os
import re
import shutil

# Directory (sibling of clean/ and filled/) holding the extracted images.
ASSETS_DIRNAME = "assets"

# How much of the SHA-1 names the file. 16 hex chars = 64 bits: collision-free
# for the low hundreds of images a catalog will ever hold, and short enough to
# keep the SVG readable.
SHA_LEN = 16

# A base64 data URI in an href, with or without the xlink: prefix. Canva emits
# xlink:href; hand-authored SVGs often use bare href, and both must be caught or
# an image silently stays embedded.
_DATA_URI = re.compile(
    r'((?:xlink:)?href=")data:image/(png|jpe?g|gif|webp|svg\+xml);base64,([^"]+)(")',
    re.IGNORECASE,
)

# A reference this module previously wrote, as it appears on disk.
_ASSET_REF = re.compile(
    r'((?:xlink:)?href=")\.\./' + ASSETS_DIRNAME + r'/([^"/]+)(")',
    re.IGNORECASE,
)

_EXT = {"png": "png", "jpeg": "jpg", "jpg": "jpg", "gif": "gif",
        "webp": "webp", "svg+xml": "svg"}


def _decode(payload):
    """Bytes behind a base64 data-URI payload, tolerating embedded whitespace."""
    return base64.b64decode(re.sub(r"\s+", "", payload))


def extract(svg_text, assets_dir):
    """Pull every embedded image out of ``svg_text`` into ``assets_dir``.

    Returns ``(new_text, written)`` where ``written`` maps filename -> byte
    count for the images this call materialised. Images already present on disk
    are left alone: the filename is the content hash, so an existing file with
    the right name necessarily has the right bytes — that is what makes the
    eight fronts collapse onto one copy.
    """
    written = {}

    def swap(m):
        prefix, mime, payload, suffix = m.groups()
        raw = _decode(payload)
        name = "%s.%s" % (hashlib.sha1(raw).hexdigest()[:SHA_LEN],
                          _EXT.get(mime.lower(), "bin"))
        dest = os.path.join(assets_dir, name)
        if not os.path.exists(dest):
            os.makedirs(assets_dir, exist_ok=True)
            with open(dest, "wb") as f:
                f.write(raw)
            written[name] = len(raw)
        return "%s../%s/%s%s" % (prefix, ASSETS_DIRNAME, name, suffix)

    return _DATA_URI.sub(swap, svg_text), written


def read_svg(path):
    """Read a card SVG, resolving ``../assets/`` references to absolute paths.

    This is the ONLY correct way to load a de-duplicated card SVG, because the
    composed copy is written to the output directory where a relative reference
    no longer points at the artwork. Artwork that still embeds its images is
    returned unchanged, so this is safe to use everywhere.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()
    return absolutize(text, os.path.dirname(os.path.abspath(path)))


def absolutize(svg_text, svg_dir):
    """Rewrite ``../assets/x.png`` references as absolute paths.

    ``svg_dir`` is the directory the SVG lives in (e.g. ``<template>/clean``),
    so the assets directory is its sibling.
    """
    assets = os.path.join(os.path.dirname(os.path.abspath(svg_dir)),
                          ASSETS_DIRNAME)

    def swap(m):
        prefix, name, suffix = m.groups()
        return "%s%s%s" % (prefix, os.path.join(assets, name), suffix)

    return _ASSET_REF.sub(swap, svg_text)


def migrate_file(src, dst, assets_dir):
    """De-duplicate one SVG from ``src`` to ``dst``. Returns (before, after)."""
    with open(src, encoding="utf-8") as f:
        text = f.read()
    new, _ = extract(text, assets_dir)
    os.makedirs(os.path.dirname(os.path.abspath(dst)), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        f.write(new)
    return len(text.encode("utf-8")), len(new.encode("utf-8"))


def migrate_template(src_root, dst_root, subdirs=("clean", "filled")):
    """De-duplicate a whole template directory.

    Reads ``<src_root>/<subdir>/*.svg``, writes the slimmed SVGs to
    ``<dst_root>/<subdir>/`` and every distinct image to ``<dst_root>/assets/``.
    Returns a summary dict for reporting.
    """
    assets_dir = os.path.join(dst_root, ASSETS_DIRNAME)
    before = after = 0
    files = 0
    for sub in subdirs:
        srcdir = os.path.join(src_root, sub)
        if not os.path.isdir(srcdir):
            continue
        for name in sorted(os.listdir(srcdir)):
            if not name.lower().endswith(".svg"):
                continue
            b, a = migrate_file(os.path.join(srcdir, name),
                                os.path.join(dst_root, sub, name), assets_dir)
            before += b
            after += a
            files += 1
    assets = 0
    if os.path.isdir(assets_dir):
        assets = sum(os.path.getsize(os.path.join(assets_dir, n))
                     for n in os.listdir(assets_dir))
    return {"files": files, "svg_before": before, "svg_after": after,
            "assets_bytes": assets, "total_after": after + assets}


def copy_sidecars(src_root, dst_root, names=("fonts",)):
    """Copy non-SVG sidecar directories (fonts/) alongside migrated artwork."""
    for name in names:
        s = os.path.join(src_root, name)
        if os.path.isdir(s):
            shutil.copytree(s, os.path.join(dst_root, name), dirs_exist_ok=True)


if __name__ == "__main__":
    import sys

    src, dst = sys.argv[1], sys.argv[2]
    stats = migrate_template(src, dst)
    copy_sidecars(src, dst)
    print("%d svg  %.1f MB -> %.2f MB  + assets %.2f MB  = %.2f MB" % (
        stats["files"], stats["svg_before"] / 1e6, stats["svg_after"] / 1e6,
        stats["assets_bytes"] / 1e6, stats["total_after"] / 1e6))
