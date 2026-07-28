#!/usr/bin/env python3
"""Assemble a whole 208-page deck as ONE HTML document for a single Chrome pass.

WHY NOT THE v1 APPROACH. v1 rendered each page to a PNG with its own headless
Chrome run and stitched the PNGs with Pillow. At v2's scale that breaks twice
over, and both were measured, not guessed:

  * MEMORY — Pillow's PDF writer materialises every page before encoding, so a
    208-page deck at print resolution peaks at ~784 MB. Railway containers do not
    have that to give.
  * TIME — 106 distinct pages x one Chrome start-up and render each runs to
    several minutes, well past the server's 120 s generation timeout.

So v2 builds ONE document containing all 208 pages and makes a SINGLE
``--print-to-pdf`` pass. Chrome paginates it via ``@page``, and Python never
holds a raster at all: peak memory is the HTML string, and the whole deck costs
one browser start-up.

It is also a better artifact. The pages stay VECTOR (text is real text, not a
resampled bitmap), the page box is set in points so the PDF is exactly the card's
physical size and "print at 100%" means what it says, and Chrome stores the
shared background image once for the whole file instead of 104 times.

THREE THINGS THIS MODULE HAS TO GET RIGHT
1. ID COLLISIONS. The nine card SVGs are near-identical Canva exports, so they
   reuse clip-path/filter ids. Dropped into one document those ids collide and
   cards cross-wire each other's clips. Every id (and every reference to it) is
   namespaced per source file.
2. PAYLOAD DEDUPE. Each front embeds the same multi-megabyte background. It is
   emitted ONCE into a shared ``<defs>`` and every card points at it with
   ``<use>``, so the document holds one copy rather than 104 (or even 8).
3. ART DEDUPE. Each of the nine card designs is defined ONCE as a ``<g>`` in
   ``<defs>``; a card is a ``<use>`` of its design plus its own text overlay. So
   104 cards cost 9 copies of the artwork, not 104.
"""
import base64
import os
import re

SHARED_BG_ID = "dugriSharedBg"

# The background payload inside a Canva card export: an <image> whose href is a
# base64 data URL. Only genuinely large payloads are hoisted (see BG_MIN_CHARS) —
# a small decorative image is cheaper left where it is.
_IMAGE_EL = re.compile(
    r'<image\b[^>]*?\b(?:xlink:href|href)\s*=\s*"data:image/[a-zA-Z0-9.+-]+;base64,'
    r'[A-Za-z0-9+/=\s]+"[^>]*/\s*>'
)
_HREF_B64 = re.compile(
    r'\b(?:xlink:href|href)\s*=\s*"data:image/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)"'
)
# Base64 chars a payload must reach before it is worth hoisting into shared defs
# (~700 KB decoded). The full-bleed card background is ~7.1M chars; the icons that
# distinguish the fronts are vector paths, not images, so nothing else comes close.
BG_MIN_CHARS = 1_000_000

_ID_ATTR = re.compile(r'\bid\s*=\s*"([^"]+)"')
_URL_REF = re.compile(r'url\(\s*#([^)\s]+)\s*\)')
_HREF_REF = re.compile(r'\b(xlink:href|href)\s*=\s*"#([^"]+)"')
_SVG_ROOT = re.compile(r'<svg\b[^>]*>', re.S)
_VIEWBOX = re.compile(r'viewBox\s*=\s*"([^"]+)"')


def view_box(svg_text):
    """The SVG's viewBox as ``[x, y, w, h]`` floats."""
    root = _SVG_ROOT.search(svg_text)
    if not root:
        raise ValueError("not an SVG document: no <svg> root element")
    vb = _VIEWBOX.search(root.group(0))
    if not vb:
        raise ValueError("card SVG has no viewBox; cannot place text slots")
    return [float(v) for v in vb.group(1).replace(",", " ").split()]


def _inner(svg_text):
    """Everything between the <svg> root tags."""
    root = _SVG_ROOT.search(svg_text)
    end = svg_text.rfind("</svg>")
    return svg_text[root.end():end if end > 0 else len(svg_text)]


def namespace_ids(markup, prefix):
    """Prefix every id defined in ``markup`` and every reference to it.

    Only ids DEFINED here are rewritten, so a reference to something outside the
    fragment (notably the shared background) is left pointing where it points.
    Without this, nine near-identical Canva exports in one document would share
    clip-path ids and clip each other's artwork.
    """
    ids = set(_ID_ATTR.findall(markup))
    if not ids:
        return markup

    def new(name):
        return f"{prefix}{name}" if name in ids else name

    markup = _ID_ATTR.sub(lambda m: f'id="{new(m.group(1))}"', markup)
    markup = _URL_REF.sub(lambda m: f"url(#{new(m.group(1))})", markup)
    markup = _HREF_REF.sub(lambda m: f'{m.group(1)}="#{new(m.group(2))}"', markup)
    return markup


def split_background(markup):
    """Replace the big embedded background with a ``<use>`` of the shared one.

    Returns ``(markup, payload)`` where ``payload`` is the ``<image>`` element to
    emit once in shared defs (or None when this card embeds no large image, in
    which case the markup is returned untouched). The ``<use>`` sits exactly
    where the ``<image>`` was, so it inherits the same transform/clip context and
    paints identically.
    """
    for m in _IMAGE_EL.finditer(markup):
        el = m.group(0)
        href = _HREF_B64.search(el)
        if not href or len(href.group(2)) < BG_MIN_CHARS:
            continue
        # The shared definition keeps the element's own geometry (x/y/width/
        # height/preserveAspectRatio), so <use> reproduces the original placement.
        shared = el.replace("<image", f'<image id="{SHARED_BG_ID}"', 1)
        out = markup[:m.start()] + f'<use xlink:href="#{SHARED_BG_ID}"/>' + markup[m.end():]
        return out, shared
    return markup, None


class DeckDocument:
    """Builds the single HTML document that becomes the whole deck PDF.

    Usage: register each distinct card DESIGN once with ``add_design``, then
    append one page per printed card with ``add_page``. ``html`` renders the
    document. Designs are shared, so the cost of a 208-page deck is nine copies
    of the artwork plus one copy of the background.
    """

    def __init__(self, width_pt, height_pt):
        self.width = width_pt
        self.height = height_pt
        self._designs = {}       # key -> namespaced <g> markup
        self._order = []         # design keys, in registration order
        self._shared_bg = None
        self._pages = []         # (design_key, overlay_markup)
        self._styles = []

    def add_style(self, css):
        """Add a CSS rule to the document head (fonts, text rendering, ...).

        Declared ONCE for the whole deck — v1 re-embedded every @font-face into
        every page, which at 208 pages would dwarf the artwork itself.
        """
        self._styles.append(css)

    def add_design(self, key, svg_text):
        """Register a card design (a whole card SVG) under ``key``, once.

        Re-registering the same key is a no-op, so callers can register a
        design per card without tracking what they have already added.
        """
        if key in self._designs:
            return
        markup, payload = split_background(_inner(svg_text))
        if payload is not None and self._shared_bg is None:
            # The shared background is namespaced under its own prefix so its
            # internal ids can't collide with any card's.
            self._shared_bg = namespace_ids(payload, "bg_").replace(
                f'id="bg_{SHARED_BG_ID}"', f'id="{SHARED_BG_ID}"')
        self._designs[key] = namespace_ids(markup, f"d{len(self._order)}_")
        self._order.append(key)

    def add_page(self, design_key, overlay=""):
        """Append one printed page: a registered design plus its text overlay."""
        if design_key not in self._designs:
            raise KeyError(f"card design {design_key!r} was never registered")
        self._pages.append((design_key, overlay))

    @property
    def page_count(self):
        return len(self._pages)

    def html(self, view_box_str):
        """The complete document. ``view_box_str`` is the shared card viewBox."""
        w, h = self.width, self.height
        defs = []
        if self._shared_bg:
            defs.append(self._shared_bg)
        for key in self._order:
            defs.append(f'<g id="{_design_id(key)}">{self._designs[key]}</g>')
        pages = []
        for design_key, overlay in self._pages:
            pages.append(
                f'<div class="card"><svg xmlns="http://www.w3.org/2000/svg" '
                f'xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="{view_box_str}" '
                f'width="{w}pt" height="{h}pt">'
                f'<use xlink:href="#{_design_id(design_key)}"/>{overlay}</svg></div>'
            )
        # break-after:page on every card but the last: a trailing break would
        # emit a blank 209th page, which the customer would print.
        style = "".join(self._styles)
        return (
            '<!doctype html><html><head><meta charset="utf-8"><style>'
            f"@page{{size:{w}pt {h}pt;margin:0}}"
            "html,body{margin:0;padding:0;background:#fff}"
            f".card{{width:{w}pt;height:{h}pt;overflow:hidden;break-after:page;"
            "page-break-after:always}"
            ".card:last-child{break-after:auto;page-break-after:auto}"
            "svg{display:block}"
            f"{style}</style></head><body>"
            '<svg width="0" height="0" style="position:absolute" '
            'xmlns="http://www.w3.org/2000/svg" '
            f'xmlns:xlink="http://www.w3.org/1999/xlink"><defs>{"".join(defs)}</defs></svg>'
            f'{"".join(pages)}</body></html>'
        )


def _design_id(key):
    """A DOM-safe id for a design key (keys are theme/card names, not ids)."""
    return "card_" + re.sub(r"[^A-Za-z0-9_-]", "_", str(key))


def font_face(name, path):
    """An @font-face rule embedding a font file as base64.

    Declared once per deck (see ``DeckDocument.add_style``) rather than per page.
    """
    with open(path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return (f"@font-face{{font-family:'{name}';font-weight:400;font-style:normal;"
            f"src:url(data:font/ttf;base64,{b64}) format('truetype');}}")


def image_data_url(path):
    """A file as a base64 data URL, for the photo card's customer images."""
    ext = os.path.splitext(path)[1].lstrip(".").lower() or "png"
    sub = {"jpg": "jpeg", "svg": "svg+xml"}.get(ext, ext)
    with open(path, "rb") as f:
        return f"data:image/{sub};base64," + base64.b64encode(f.read()).decode("ascii")
