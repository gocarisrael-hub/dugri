#!/usr/bin/env python3
"""Theme configuration for the card generator.

All per-theme knobs (fonts, title text/lines, colours, title style, board/back
title slots, recipe mapping) live in ``themes.json`` keyed by the template
folder name. Nothing about a specific theme is hardcoded in the render code —
it all flows from here.
"""
import json
import os

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


def theme(name):
    """Return the config dict for a single theme (by folder-name key)."""
    themes = load_themes()
    if name not in themes:
        raise KeyError(f"unknown theme {name!r}; known: {sorted(themes)}")
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
    Returns the theme-local path as a last resort so callers still get a path
    (font loading then fails loudly on a genuinely unknown filename).
    """
    if not filename:
        return font_path(theme_name, theme(theme_name)["word_font"])
    own = font_path(theme_name, filename)
    if os.path.exists(own):
        return own
    shared = os.path.join(WORD_FONTS_DIR, filename)
    if os.path.exists(shared):
        return shared
    return own


def clean_path(theme_name, which):
    """Absolute path to a clean background SVG (which in fronts/backs/board)."""
    return os.path.join(theme_dir(theme_name), "clean", f"{which}.svg")


def ensure_calibrated(cfg):
    """Raise a clear error if a theme has no calibrated render style yet."""
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


def title_lines(cfg, name, extra_fields_dict=None):
    """Substitute the theme's title_lines template.

    ``{NAME}`` comes from ``name`` (cased per ``name_form``); ``{NAME1}`` and
    ``{NAME2}`` come from ``extra_fields_dict`` and are cased the same way;
    ``{AGE}``/``{YEARS}`` (and any other extra field) are substituted verbatim.
    """
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
        out.append(line)
    return out
