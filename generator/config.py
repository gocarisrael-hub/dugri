#!/usr/bin/env python3
"""Theme configuration for the card generator.

All per-theme knobs (fonts, title text/lines, colours, title style, board/back
title slots, recipe mapping) live in ``themes.json`` keyed by the template
folder name. Nothing about a specific theme is hardcoded in the render code —
it all flows from here.
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, ".."))
THEMES_JSON = os.path.join(HERE, "themes.json")
# Shared word-font pool the customer can pick from in the order preview. A
# filename here overrides a theme's own card word font. Kept OUTSIDE any single
# theme's fonts/ dir so the same options are offered for every theme;
# ``word-fonts/options.json`` lists them as [{label, file}, ...].
WORD_FONTS_DIR = os.path.join(HERE, "word-fonts")
WORD_FONTS_JSON = os.path.join(WORD_FONTS_DIR, "options.json")


# ---- Owner template store (persistent-volume overlay) ----------------------
# WHY: templates the owner uploads — and the calibrations they save — are written
# at RUNTIME. In production only the volume mounted at ``DATA_DIR`` survives a
# deploy; anything written next to the code lives inside the container image and
# is gone the moment a new container starts. So the catalog is split in two and
# every read below merges them:
#
#   <image>/generator/themes.json           shipped entries, read-only
#   <image>/resources/canva/templates/<k>/  shipped assets, read-only
#   <image>/generator/recipes/<r>.json      shipped recipes, read-only
#
#   DATA_DIR/templates/themes.json          owner entries, same shape as a
#                                           generator/themes.json entry
#   DATA_DIR/templates/<key>/               owner assets: clean/ filled/ fonts/
#   DATA_DIR/templates/recipes/<r>.json     owner recipes
#
# The generator is a PURE READER of that store: the server owns every write, so a
# render can never corrupt the catalog it is rendering from.
#
# ``DATA_DIR`` unset (local dev, tests, CLI use) means "no owner store" — every
# lookup short-circuits to the image paths and behaves exactly as it did before
# the overlay existed. The env var is read on EACH call rather than captured at
# import, so a test (or an embedding process) can point the store elsewhere
# without re-importing the module, mirroring how ``THEMES_JSON`` is monkeypatched.
OWNER_STORE_SUBDIR = "templates"


def owner_store():
    """Absolute path of the owner template store, or None when DATA_DIR is unset."""
    data_dir = os.environ.get("DATA_DIR")
    if not data_dir:
        return None
    return os.path.join(data_dir, OWNER_STORE_SUBDIR)


def owner_themes_path():
    """Absolute path of the owner themes.json, or None when there is no store."""
    root = owner_store()
    return os.path.join(root, "themes.json") if root else None


def owner_themes():
    """The owner's theme entries — ``{}`` when there is no store or no file yet.

    A MISSING file is the normal state (nothing uploaded yet), so it reads as an
    empty mapping. A CORRUPT one RAISES rather than being ignored: swallowing it
    would drop the owner's templates and — worse — silently render the SHIPPED
    design for any key the owner had overridden, i.e. the wrong artwork on a
    paying customer's PDF. A loud error naming the file is the recoverable one.
    """
    path = owner_themes_path()
    if not path or not os.path.exists(path):
        return {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as exc:
        raise RuntimeError(
            f"the owner template store is unreadable: {path} ({exc}). It holds "
            "every template uploaded after launch; fix or restore that file "
            "before rendering."
        ) from exc
    if not isinstance(data, dict):
        raise RuntimeError(
            f"the owner template store {path} must be a JSON object keyed by "
            f"template name, got {type(data).__name__}."
        )
    return data


def load_themes():
    """Return the full themes mapping (key = template folder name).

    Shipped entries first, the owner's on top: a key present in BOTH resolves to
    the OWNER's entry — a whole-entry override, not a deep merge, so a saved
    calibration replaces the shipped one outright instead of leaving half of each
    behind. With no owner store this is the shipped mapping, unchanged.
    """
    with open(THEMES_JSON, encoding="utf-8") as f:
        shipped = json.load(f)
    owner = owner_themes()
    if not owner:
        return shipped
    return {**shipped, **owner}


# ---- Preview-only calibration overrides -----------------------------------
# The owner's calibration form previews an UNCALIBRATED template (title_style /
# board / back are still null) using knobs it has NOT saved yet, so the look can
# be tuned before it is written to themes.json. ``preview.py`` installs those
# knobs here and every ``theme()`` read in the SAME process then sees them merged
# over the stored entry — which matters because ``render_page.build_page``,
# ``build.render_board`` and ``build.render_backs`` each re-read the config
# themselves rather than being handed one.
#
# Process-local by design: the server spawns a fresh Python per preview request,
# so knobs can never leak between requests, and NO production entry point
# (order_to_pdf / build) installs them — a real print-ready PDF still requires a
# genuine ``calibrated: true`` in themes.json.
_PREVIEW_OVERRIDES = {}

# Only the render knobs the calibration form owns may be overridden. Everything
# else (dir, recipe, fonts, visibility, ...) is identity/asset configuration, so
# a preview can never repoint a theme at another template's files.
_OVERRIDABLE = ("title_style", "board", "back", "word_size")

# Marker merged into an overridden cfg so ``ensure_calibrated`` lets the preview
# through. In-memory only — overrides are never written back to themes.json.
_PREVIEW_MARK = "_preview_calibration"


def set_preview_overrides(name, overrides):
    """Install in-memory calibration knobs for theme ``name`` (PREVIEW ONLY).

    ``overrides`` is the calibration blob the admin form sent
    (``{title_style, board, back, word_size}``). Unknown keys are ignored. A
    falsy/empty blob is a no-op, so the normal preview path is untouched.
    """
    if not overrides:
        return
    picked = {k: overrides[k] for k in _OVERRIDABLE if k in overrides}
    if not picked:
        return
    picked[_PREVIEW_MARK] = True
    _PREVIEW_OVERRIDES[name] = picked


def clear_preview_overrides():
    """Drop every installed preview override (used by tests)."""
    _PREVIEW_OVERRIDES.clear()


def theme(name):
    """Return the config dict for a single theme (by folder-name key).

    Any preview-only calibration override installed for ``name`` is merged over
    the stored entry (see ``set_preview_overrides``); with none installed this
    returns the themes.json entry exactly as before.
    """
    themes = load_themes()
    if name not in themes:
        raise KeyError(f"unknown theme {name!r}; known: {sorted(themes)}")
    override = _PREVIEW_OVERRIDES.get(name)
    if override:
        return {**themes[name], **override}
    return themes[name]


def theme_dir(name):
    """Absolute path to the theme's template directory.

    An OWNER template is resolved BY KEY (the themes.json key is also the folder
    name), never through the entry's ``dir`` field: the server writes that field
    as an in-image ``resources/canva/templates/<key>`` path, which is exactly the
    location that does not survive a deploy. So the volume copy wins whenever it
    is there, and the image copy is the fallback.

    A SHIPPED entry keeps using its own ``dir`` verbatim, so no shipped render
    moves a byte. With no owner store this is the old one-liner.

    The name is resolved through ``theme()`` FIRST, exactly as before: only a
    REGISTERED key ever reaches the filesystem join, so an unknown one still
    raises the familiar KeyError instead of being turned into a path.
    """
    cfg = theme(name)  # raises the usual KeyError for an unknown theme
    root = owner_store()
    if root:
        owned = os.path.join(root, name)
        if os.path.isdir(owned):
            return owned
    if root and name in owner_themes():
        # Registered by the owner but with no assets on the volume. It may still
        # be an override of a SHIPPED design (entry on the volume, art in the
        # image) — that is legitimate, so try the image dir by key first.
        shipped = os.path.join(REPO, "resources", "canva", "templates", name)
        if os.path.isdir(shipped):
            return shipped
        raise RuntimeError(
            f"template {name!r} is registered in the owner store "
            f"({owner_themes_path()}) but its files are missing: expected "
            f"{os.path.join(root, name)} on the persistent volume, and there is "
            f"no shipped copy at {shipped}. Re-upload the template — its assets "
            "were most likely written inside the container image and lost on a "
            "deploy."
        )
    return os.path.join(REPO, cfg["dir"])


def font_path(theme_name, filename):
    """Absolute path to a font file inside the theme's ``fonts/`` dir."""
    return os.path.join(theme_dir(theme_name), "fonts", filename)


def word_font_options():
    """The shared word-font choices, as a list of ``{"label", "file"}`` dicts.

    A single default list (read from ``word-fonts/options.json``) offered for
    every theme, so the order preview shows the same picker regardless of design.
    Returns ``[]`` when the manifest is missing/unparseable (never crashes).
    """
    try:
        with open(WORD_FONTS_JSON, encoding="utf-8") as f:
            opts = json.load(f)
    except (OSError, ValueError):
        return []
    return [o for o in opts if isinstance(o, dict) and o.get("file")]


def resolve_word_font(theme_name, filename=None):
    """Resolve the card word-font path for a theme, honouring an override.

    ``filename`` is an optional override (e.g. one the customer picked in the
    preview). Resolution order:
      1. no override -> the theme's own configured ``word_font`` (in its fonts/);
      2. a file that exists in the theme's own ``fonts/`` dir;
      3. otherwise fall back to the shared ``word-fonts/`` pool.
    When the override resolves to nothing that exists (neither in the theme's
    fonts/ nor the shared pool), fall back to the theme's own default word_font
    rather than returning a path that isn't there — the theme default is the only
    trusted path, so the render never dies with an opaque FileNotFoundError.
    """
    default_path = font_path(theme_name, theme(theme_name)["word_font"])
    if not filename:
        return default_path
    own = font_path(theme_name, filename)
    if os.path.exists(own):
        return own
    shared = os.path.join(WORD_FONTS_DIR, filename)
    if os.path.exists(shared):
        return shared
    return default_path


def display_path(path):
    """A path as it should be SHOWN to a human: repo-relative, or absolute.

    Reports used to say ``resources/canva/templates/x/clean/fronts.svg`` by taking
    a relpath against the repo. An owner template's files live on the volume,
    OUTSIDE the repo, where that produces a ladder of ``../..`` that names nothing
    the reader recognises. So relativize only what is actually inside the repo and
    show everything else in full. Purely cosmetic — no resolution depends on it.
    """
    rel = os.path.relpath(path, REPO)
    return path if rel.startswith(os.pardir) else rel


def recipe_path(recipe_name):
    """Absolute path to a recipe JSON, owner store first, image second.

    The same overlay as the assets: the recipe auto-detected for an owner-uploaded
    template is written to ``DATA_DIR/templates/recipes/<name>.json``, while the
    shipped recipes stay in ``generator/recipes/``. Not on the volume (or no store
    configured) -> the image path, i.e. exactly today's behaviour. Returns the path
    whether or not it exists, so existence checks stay with the caller.
    """
    root = owner_store()
    if root:
        owned = os.path.join(root, "recipes", f"{recipe_name}.json")
        if os.path.exists(owned):
            return owned
    return os.path.join(HERE, "recipes", f"{recipe_name}.json")


def load_recipe(recipe_name):
    """Parse a theme's recipe through the overlay, with a clear error if absent.

    A missing recipe used to surface as a bare FileNotFoundError from inside a
    render; it means the template was never (or no longer is) fully onboarded, so
    say that and name the path that was looked for.
    """
    path = recipe_path(recipe_name)
    if not os.path.exists(path):
        raise RuntimeError(
            f"recipe {recipe_name!r} is missing — looked for {path}. A template's "
            "recipe (its card/word slot geometry) is detected when the template is "
            "uploaded; re-run detection for it before rendering."
        )
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def clean_path(theme_name, which):
    """Absolute path to a clean background SVG (which in fronts/backs/board)."""
    return os.path.join(theme_dir(theme_name), "clean", f"{which}.svg")


def board_clean_path(theme_name, chasers=False):
    """Absolute path to the board clean SVG for an order.

    When the ``chasers`` (drinking-game) add-on is on AND the theme ships a
    ``clean/board-chasers.svg`` variant, that variant is used so the board shows
    the special "drink" tiles. Otherwise — chasers off, or the theme has no
    chasers board — this falls back to the normal ``clean/board.svg``. The
    feature is purely additive: a theme without a chasers board renders exactly
    as before, and this never raises for a missing chasers file.
    """
    if chasers:
        variant = os.path.join(theme_dir(theme_name), "clean", "board-chasers.svg")
        if os.path.exists(variant):
            return variant
    return clean_path(theme_name, "board")


# ---- v2: single-card deck --------------------------------------------------
# A v2 template ships its deck as numbered cards — clean/1.svg (the back) and
# clean/2.svg..9.svg (eight fronts that differ only by an icon) — instead of the
# v1 8-up ``fronts.svg`` / ``backs.svg`` sheets. The board is NOT part of that
# numeric set: it keeps its own ``clean/board.svg`` because it is a different
# geometry and, in v2, a separate output artifact.
#
# ``card_layout`` gates the whole path, so a theme without it renders through the
# v1 sheet code exactly as before and the seven un-migrated themes keep working
# while grapefruit goes first. See docs/card-schema-v2.md.
DEFAULT_FRONTS = [2, 3, 4, 5, 6, 7, 8, 9]
DEFAULT_BACK_INDEX = 1


def is_single_card(cfg):
    """True when a theme config uses the v2 single-card deck."""
    return cfg.get("card_layout") == "single"


def fronts(cfg):
    """The theme's front indices (``[2..9]`` when unset).

    Non-int / empty entries are dropped rather than trusted: a bad value would
    otherwise become a filename and fail deep inside a render.
    """
    raw = cfg.get("fronts") or DEFAULT_FRONTS
    out = []
    for v in raw:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out or list(DEFAULT_FRONTS)


def back_index(cfg):
    """The card index of the deck's back (``1`` when unset)."""
    try:
        return int(cfg.get("back_index", DEFAULT_BACK_INDEX))
    except (TypeError, ValueError):
        return DEFAULT_BACK_INDEX


def card_path(theme_name, index, filled=False):
    """Absolute path to a numbered card SVG (``clean/3.svg``, ``filled/3.svg``)."""
    sub = "filled" if filled else "clean"
    return os.path.join(theme_dir(theme_name), sub, f"{int(index)}.svg")


def front_paths(theme_name, filled=False):
    """Absolute paths of the theme's eight fronts, in configured order."""
    return [card_path(theme_name, i, filled=filled) for i in fronts(theme(theme_name))]


def back_path(theme_name, filled=False):
    """Absolute path of the theme's card back."""
    return card_path(theme_name, back_index(theme(theme_name)), filled=filled)


def photo_card_config(cfg):
    """The theme's ``photo_card`` block, or ``{}`` when it ships none."""
    block = cfg.get("photo_card")
    return block if isinstance(block, dict) else {}


def photo_card_path(theme_name):
    """Absolute path of the photo-card background.

    The theme's ``photo_card.template`` (a filename in ``clean/``) when it ships
    one and the file exists; otherwise the FIRST front, so a template that has
    not shipped dedicated photo-card art still produces a photo card on brand
    artwork rather than failing the order.
    """
    cfg = theme(theme_name)
    name = photo_card_config(cfg).get("template")
    if name:
        path = os.path.join(theme_dir(theme_name), "clean", os.path.basename(str(name)))
        if os.path.exists(path):
            return path
    return card_path(theme_name, fronts(cfg)[0])


def photo_fallback_paths(theme_name):
    """The generic Dugri pawn images used when the customer uploaded none.

    Repo-relative paths from the theme's ``photo_card.fallback``; entries that
    do not exist are dropped, so a partly-shipped fallback set degrades to the
    images that ARE there instead of rendering a broken slot.
    """
    out = []
    for rel in photo_card_config(theme(theme_name)).get("fallback") or []:
        path = rel if os.path.isabs(str(rel)) else os.path.join(REPO, str(rel))
        if os.path.isfile(path):
            out.append(path)
    return out


def front_offset(cfg, front_index):
    """Title nudge for one front, as ``[dx, dy]`` fractions of the card cell.

    ``title_style.front_offset["<n>"]`` when that front has its own nudge, else
    the shared ``title_style.offset``, else ``None``. This is the OWNER-tunable
    half of "per-front title position"; the detected box is the recipe's half.
    """
    ts = cfg.get("title_style") or {}
    per = ts.get("front_offset") or {}
    off = per.get(str(front_index), per.get(front_index))
    if off is None:
        off = ts.get("offset")
    if not off or len(off) < 2:
        return None
    return [float(off[0]), float(off[1])]


def is_single_card_recipe(recipe):
    """True when a recipe describes ONE card rather than a v1 8-up sheet."""
    return recipe.get("layout") == "single" or "card" in recipe


def recipe_card(recipe):
    """The single-card block (``{cell, words}``) of a v2 recipe."""
    card = recipe.get("card")
    if not isinstance(card, dict):
        raise RuntimeError(
            "this template's recipe has no single-card block — it looks like a "
            "v1 8-up sheet recipe. Re-run calibration for the template so its "
            "card/word slot geometry is detected against the new card art."
        )
    return card


def recipe_front_title(recipe, front_index):
    """Title boxes for one front — a list, possibly one box per title line.

    Falls back, in order, to: the front's own entry; a shared ``card.title``;
    then the union of every other front's boxes. The last fallback keeps a
    partially-calibrated template rendering a title in roughly the right place
    on an un-detected front instead of dropping the honoree's name entirely.
    Returns ``[]`` when the recipe records no title anywhere.
    """
    entry = (recipe.get("fronts") or {}).get(str(front_index))
    if isinstance(entry, dict) and entry.get("title"):
        return entry["title"]
    card = recipe.get("card") or {}
    if card.get("title"):
        return card["title"]
    boxes = []
    for other in (recipe.get("fronts") or {}).values():
        if isinstance(other, dict) and other.get("title"):
            boxes.extend(other["title"])
    if not boxes:
        return []
    return [{"x0": min(b["x0"] for b in boxes), "y0": min(b["y0"] for b in boxes),
             "x1": max(b["x1"] for b in boxes), "y1": max(b["y1"] for b in boxes),
             "color": boxes[0].get("color", "#000000")}]


# Inset of the default photo grid from the card edge, as a fraction of the card.
_PHOTO_INSET = 0.06
# Gap between the 2x2 photo cells, as a fraction of the card.
_PHOTO_GAP = 0.04


def photo_slots(recipe, cell):
    """The four photo boxes on the photo card, in reading order.

    Uses the recipe's ``photo.slots`` when calibration detected them; otherwise
    lays out a 2x2 grid inset from the card edge, so the photo card works on a
    template whose photo slots have not been calibrated yet.
    """
    slots = (recipe.get("photo") or {}).get("slots")
    if isinstance(slots, list) and len(slots) >= 4:
        return slots[:4]
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    ix, iy = _PHOTO_INSET * w, _PHOTO_INSET * h
    gx, gy = _PHOTO_GAP * w, _PHOTO_GAP * h
    cw = (w - 2 * ix - gx) / 2
    ch = (h - 2 * iy - gy) / 2
    out = []
    for row in range(2):
        for col in range(2):
            sx = x0 + ix + col * (cw + gx)
            sy = y0 + iy + row * (ch + gy)
            out.append({"x0": sx, "y0": sy, "x1": sx + cw, "y1": sy + ch})
    return out


def ensure_calibrated(cfg):
    """Raise a clear error if a theme has no calibrated render style yet.

    A PREVIEW carrying unsaved calibration knobs is the one exception: it may
    render an uncalibrated template so the owner can see the look before saving.
    That exemption requires the knobs to actually supply a usable ``title_style``
    dict — otherwise the render would only get further before dying on a missing
    fill/outline. Production is unaffected: it never installs overrides, so a
    real PDF still needs ``calibrated: true``.
    """
    if cfg.get(_PREVIEW_MARK) and isinstance(cfg.get("title_style"), dict):
        return
    if not cfg.get("calibrated"):
        raise RuntimeError(
            f"theme {cfg.get('slug', '?')!r} is not calibrated yet — "
            "title_style/board/back are null. Calibrate it (fill title_style, "
            "board and back in themes.json and set calibrated:true) before "
            "rendering."
        )


def _form_name(value, name_form):
    """Apply the theme's name casing rule to a name-like value."""
    if name_form == "english-caps":
        return value.upper()
    return value


def custom_title_lines(custom_title):
    """Split an order-level custom title into render lines, or return None.

    Lines are separated by newlines; each is stripped and blank lines are
    dropped. Returns None when the title is missing or only whitespace, so the
    caller falls back to the theme-derived lines (default behavior unchanged).
    """
    if not custom_title:
        return None
    lines = [ln.strip() for ln in str(custom_title).splitlines() if ln.strip()]
    return lines or None


def title_lines(cfg, name, extra_fields_dict=None, custom_title=None):
    """Substitute the theme's title_lines template.

    ``{NAME}`` comes from ``name`` (cased per ``name_form``); ``{NAME1}`` and
    ``{NAME2}`` come from ``extra_fields_dict`` and are cased the same way;
    ``{AGE}``/``{YEARS}`` (and any other extra field) are substituted verbatim.

    ``custom_title`` (F7) is an OPTIONAL per-order free-form title: when the
    buyer supplies one it REPLACES the theme-derived lines everywhere the title
    renders (front cards, card backs, game board), flowing through the SAME
    ``render_page.title_block`` auto-fit — so a long custom title just renders
    smaller and can never overflow the card/board. Empty/whitespace is treated
    as absent, so the default (theme-derived) output stays byte-identical.
    """
    custom = custom_title_lines(custom_title)
    if custom is not None:
        return custom
    extra = dict(extra_fields_dict or {})
    name_form = cfg.get("name_form")
    values = {"NAME": _form_name(name, name_form) if name is not None else ""}
    for key, val in extra.items():
        val = str(val)
        values[key] = _form_name(val, name_form) if key in ("NAME1", "NAME2") else val
    out = []
    for line in cfg["title_lines"]:
        for key, val in values.items():
            line = line.replace("{" + key + "}", val)
        # Defense-in-depth: strip any placeholder we couldn't fill so the title
        # never prints raw braces like "{AGE}" (server validation already blocks
        # this case, but a missing extra field must never leak into the render).
        line = re.sub(r"\{[^{}]*\}", "", line)
        out.append(line)
    return out
