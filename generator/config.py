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


def load_themes():
    """Return the full themes mapping (key = template folder name)."""
    with open(THEMES_JSON, encoding="utf-8") as f:
        return json.load(f)


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
    """Absolute path to the theme's template directory."""
    return os.path.join(REPO, theme(name)["dir"])


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
