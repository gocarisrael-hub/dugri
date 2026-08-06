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
# (order_to_pdf / build) installs them — a real print-ready PDF still requires
# the theme's OWN stored geometry in themes.json (``ensure_calibrated``).
_PREVIEW_OVERRIDES = {}

# Only the render knobs the calibration form owns may be overridden. Everything
# else (dir, recipe, fonts, visibility, ...) is identity/asset configuration, so
# a preview can never repoint a theme at another template's files.
#
# ``card_slots`` is the single-card word/title geometry the form exists FOR, so
# it has to be here: without it the owner's unsaved slots were dropped before
# the render and every preview came back as a BLANK card — no words, no title —
# with nothing to say the knobs had been ignored rather than mis-measured.
# Allowing it is safe because it is pure geometry (fractions of the card, no
# path and no filename), so it still cannot repoint a theme at other artwork.
# ``cards`` — which SVG is the back and which are the fronts — is deliberately
# NOT here, for exactly that reason.
# ``backs`` is the per-back half of the same look pass — a paired template's
# eight backs each carry the title in their own place — so it overrides for the
# same reason ``back`` does. Also pure geometry and paints, keyed by card number;
# it selects no artwork, so it cannot repoint the theme either.
_OVERRIDABLE = ("title_style", "board", "back", "backs", "word_size", "card_slots")

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



def recipe_or_empty(cfg):
    """The theme's recipe, or ``{}`` when it has none yet.

    A freshly uploaded template has NO recipe until detection runs, and that is a
    normal state rather than a broken one: the owner's ``card_slots`` (set in the
    calibration form) supply the same geometry on their own, and
    ``card_word_boxes`` / ``card_title_boxes`` already prefer them.

    Raising here meant opening the calibration screen on a new template produced
    a Python traceback instead of the card the owner is trying to calibrate —
    the one screen whose entire purpose is to fix that missing geometry. Callers
    that genuinely cannot proceed without geometry check for it explicitly and
    say so in their own terms (see build.deck_document).
    """
    try:
        return load_recipe(cfg.get("recipe"))
    except RuntimeError:
        return {}


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
# The presence of a ``cards`` block gates the whole path, so a theme without one
# renders through the v1 sheet code exactly as before and the seven un-migrated
# themes keep working while grapefruit goes first.
#
# SHAPE: the canonical entry nests the deck keys under ``cards`` (this is Agent
# B's docs/card-structure-schema.md 3, which the asset migration and the admin UI
# both code against):
#
#   "cards": {"back": 1, "fronts": [2,3,4,5,6,7,8,9],
#             "photo": {"template": "clean/photo.svg",
#                       "fallback": "photo-fallback"}}
#
# The FLAT keys this file first shipped (``card_layout``/``fronts``/
# ``back_index``/``photo_card``) are still read as an alias. They cost three
# ``or`` clauses and they keep every in-flight branch, saved calibration and
# owner-store entry written against the earlier shape rendering instead of
# silently dropping to the v1 path — which is how a paying order would come out
# as an 8-up sheet.
DEFAULT_FRONTS = [2, 3, 4, 5, 6, 7, 8, 9]
DEFAULT_BACK_INDEX = 1

# Artwork every theme can borrow: the generic Dugri photo card and the generic
# pawn set. Shipped once under ``_shared`` rather than copied into each template,
# so a theme opts in by shipping NOTHING at all.
SHARED_TEMPLATES_DIR = os.path.join(REPO, "resources", "canva", "templates", "_shared")
GENERIC_PHOTO_CARD = os.path.join(SHARED_TEMPLATES_DIR, "photo-card", "photo.svg")
DEFAULT_PHOTO_FALLBACK_DIR = "photo-fallback"
PHOTO_FALLBACK_COUNT = 4


def cards_config(cfg):
    """The theme's ``cards`` block, or ``{}`` when it has none (v1 theme)."""
    block = cfg.get("cards")
    return block if isinstance(block, dict) else {}


def is_single_card(cfg):
    """True when a theme config uses the v2 single-card deck.

    THREE markers, because three different writers each declare it their own way
    and a template only has to carry ONE of them:

    * ``card_structure: "cards"`` — what the ADMIN writes when the owner uploads
      a nine-file deck (server/templates.js). It writes no ``cards`` block at
      all, so this used to read as a legacy sheet: the render fell through to the
      v1 path and died on ``recipe["cards"]``, which a v2 recipe has no such key
      for. Every owner-uploaded single-card template hit that; the shipped ones
      escaped it only because their ``cards`` block was written by hand.
    * a ``cards`` block — the hand-written shipped form (grapefruit).
    * ``card_layout: "single"`` — the earliest marker, kept so anything written
      before the rename keeps rendering.
    """
    return (
        cfg.get("card_structure") == "cards"
        or bool(cards_config(cfg))
        or cfg.get("card_layout") == "single"
    )


def fronts(cfg):
    """The theme's front indices (``[2..9]`` when unset).

    ``cards.fronts`` first, then the legacy flat ``fronts``. Non-int / empty
    entries are dropped rather than trusted: a bad value would otherwise become a
    filename and fail deep inside a render.
    """
    raw = cards_config(cfg).get("fronts") or cfg.get("fronts") or DEFAULT_FRONTS
    out = []
    for v in raw:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    return out or list(DEFAULT_FRONTS)


def back_index(cfg):
    """The card index of the deck's SINGLE back (``1`` when unset).

    ``cards.back`` first, then the legacy flat ``back_index``.

    A template with PER-FRONT backs has no single back; callers that render the
    deck must go through :func:`back_indices`, which covers both shapes. This
    stays for the one-back templates (every template that exists today) and for
    the storefront's single card-back picture.
    """
    cards = cards_config(cfg)
    raw = cards["back"] if "back" in cards else cfg.get("back_index", DEFAULT_BACK_INDEX)
    try:
        return int(raw)
    except (TypeError, ValueError):
        return DEFAULT_BACK_INDEX


def back_indices(cfg):
    """One back card index PER FRONT, positionally paired with :func:`fronts`.

    Two shapes, and the pairing is what the printed deck depends on:

    * ``cards.backs: [10, …, 17]`` — a template whose eight card styles each
      have their OWN back. ``backs[i]`` is printed on the reverse of
      ``fronts[i]``, so front 2 pairs with back 10, front 3 with 11, and so on.
      The numbering is disjoint from the fronts on purpose (fronts stay 2–9),
      so a file number means exactly one thing across every template.
    * no ``cards.backs`` — every card shares one back, so this returns that same
      index repeated once per front. Callers therefore never branch: they zip
      fronts with backs and the one-back deck falls out of the general case.

    A short/ragged list is padded from its own first entry rather than from the
    default back: the artwork was clearly authored per front, so repeating one of
    ITS backs prints something coherent, where falling back to ``1`` could print
    a back that belongs to a different design entirely. An empty/absent list is
    the one-back case above.
    """
    front_list = fronts(cfg)
    raw = cards_config(cfg).get("backs")
    if not isinstance(raw, (list, tuple)) or not raw:
        return [back_index(cfg)] * len(front_list)
    out = []
    for v in raw:
        try:
            out.append(int(v))
        except (TypeError, ValueError):
            continue
    if not out:
        return [back_index(cfg)] * len(front_list)
    while len(out) < len(front_list):
        out.append(out[0])
    return out[: len(front_list)]


def has_per_front_backs(cfg):
    """True when the theme ships a distinct back for each front."""
    raw = cards_config(cfg).get("backs")
    return isinstance(raw, (list, tuple)) and len(raw) > 0


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
    """The theme's photo-card block, or ``{}`` when it ships none.

    ``cards.photo`` first, then the legacy flat ``photo_card``.
    """
    block = cards_config(cfg).get("photo")
    if isinstance(block, dict):
        return block
    block = cfg.get("photo_card")
    return block if isinstance(block, dict) else {}


def photo_card_path(theme_name):
    """Absolute path of the photo-card background (docs/photo-card.md).

    Resolution order, most specific first:
      1. ``DATA_DIR/templates/<key>/clean/photo.svg`` — the owner's overlay;
      2. ``<theme dir>/clean/photo.svg`` — the theme's own, when it ships one;
      3. ``resources/canva/templates/_shared/photo-card/photo.svg`` — the generic
         Dugri card, which is always present, so resolution never fails.
    Each step is spelled out rather than left to ``theme_dir``, which resolves the
    whole DIRECTORY and therefore answers with ONE of the two: an owner template
    that exists on the volume but ships no ``photo.svg`` would otherwise skip
    straight past the theme's own shipped card in the image.

    ``photo.svg`` is the filename by contract; a theme may still name another via
    ``cards.photo.template``. Only its basename is used, so a template can never
    point the render outside its own ``clean/``.
    """
    cfg = theme(theme_name)
    name = os.path.basename(str(photo_card_config(cfg).get("template") or ""))
    fname = name or "photo.svg"
    root = owner_store()
    dirs = []
    if root:
        dirs.append(os.path.join(root, theme_name))
    dirs.append(theme_dir(theme_name))
    dirs.append(os.path.join(REPO, "resources", "canva", "templates", theme_name))
    candidates = [os.path.join(d, "clean", fname) for d in dirs]
    candidates.append(GENERIC_PHOTO_CARD)
    for path in candidates:
        if os.path.isfile(path):
            return path
    # Last resort: the first front. Step 3 is meant to be unmissable, but the
    # shared artwork ships on its own branch — until it lands, a photo order on a
    # theme without its own card must still render on brand artwork rather than
    # die on a path that is not there.
    return card_path(theme_name, fronts(cfg)[0])


# ---- the owner's admin overrides for the photo card's pawns ----------------
# The admin panel (server/photo-fallback.js, docs/photo-fallback-overrides.md)
# lets the owner replace any of the four fallback pawns without a deploy. It
# writes DATA_DIR/photo-fallback.json:
#
#   { "slots": { "1": "/content-uploads/<16-hex>.png", "3": "..." } }
#
# ONLY overridden slots are present; an absent slot means "use the shipped pawn".
# Reading this is what makes the panel real: without it the owner uploads a pawn,
# sees it on screen, and it never prints — a silent no-op on a paid order.
#
# Missing, unreadable or corrupt is deliberately the SAME as "no overrides": a
# bad file must degrade to the shipped pawns, never fail an order.
PHOTO_FALLBACK_STORE = "photo-fallback.json"
# The exact filename shape server/content.js produces. Checked here as well as
# basename()d, so a hand-edited or doctored value can neither escape the uploads
# directory nor point the render at an arbitrary file.
_UPLOAD_NAME_RE = re.compile(r"[a-f0-9]{16}\.(?:webp|jpe?g|png)")


def _photo_fallback_overrides():
    """The owner's pawn overrides as ``{slot_int: absolute_path}``."""
    data_dir = os.environ.get("DATA_DIR")
    if not data_dir:
        return {}
    try:
        with open(os.path.join(data_dir, PHOTO_FALLBACK_STORE), encoding="utf-8") as f:
            slots = (json.load(f) or {}).get("slots") or {}
    except (OSError, ValueError):
        return {}
    if not isinstance(slots, dict):
        return {}
    out = {}
    for key, rel in slots.items():
        if str(key) not in tuple(str(i) for i in range(1, PHOTO_FALLBACK_COUNT + 1)):
            continue
        name = os.path.basename(str(rel))
        if not _UPLOAD_NAME_RE.fullmatch(name):
            continue
        path = os.path.join(data_dir, "content-uploads", name)
        if os.path.isfile(path):
            out[int(key)] = path
    return out


def photo_fallback_paths(theme_name):
    """The generic Dugri pawn images used when the customer uploaded none.

    ``_shared/photo-fallback/{1,2,3,4}.svg`` in numeric order — slot N takes pawn
    N, so an order with two photos gets two faces plus pawns 3 and 4. A theme may
    point at a different set with ``cards.photo.fallback``, which is a DIRECTORY
    NAME under ``_shared/`` (basename only: a template can never reach out of the
    shared tree).

    Entries whose file is absent are dropped, so a partly-shipped set degrades to
    the images that ARE there instead of rendering a broken slot — and a set that
    has not shipped at all yields ``[]``, which the caller treats as "no top-up".

    A LIST value is still honoured as the legacy explicit set of repo-relative
    (or absolute) paths, so an entry written against the earlier shape keeps
    resolving instead of being read as a directory name.
    """
    raw = photo_card_config(theme(theme_name)).get("fallback")
    out = []
    if isinstance(raw, (list, tuple)):
        for rel in raw:
            path = rel if os.path.isabs(str(rel)) else os.path.join(REPO, str(rel))
            if os.path.isfile(path):
                out.append(path)
        return out
    # The owner's uploads win over the shipped set, per slot: the admin panel
    # presents one global set as THE fallback, and replacing a pawn there is the
    # more recent and more deliberate act than a theme's configured subdir.
    # Per-slot, not all-or-nothing — overriding pawn 2 must leave 1, 3 and 4 as
    # shipped, and slot N must still take pawn N.
    #
    # An override is a RASTER while the shipped pawns are SVG (content.js refuses
    # SVG uploads on purpose: served from our own origin, an SVG can carry
    # <script> and become stored XSS). So this routinely returns a MIXED set of
    # extensions — nothing downstream may assume .svg.
    override = _photo_fallback_overrides()
    subdir = os.path.basename(str(raw or "")) or DEFAULT_PHOTO_FALLBACK_DIR
    base = os.path.join(SHARED_TEMPLATES_DIR, subdir)
    for i in range(1, PHOTO_FALLBACK_COUNT + 1):
        path = override.get(i) or os.path.join(base, f"{i}.svg")
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


def title_font_weight(cfg):
    """The weight instance a VARIABLE title face is drawn at, or None.

    ``title_style.font_weight``, measured off the design's own ink. None for a
    static face (there is only one cut) and for a variable one nothing has
    measured yet — which draws the file's own default instance, exactly as
    before.
    """
    try:
        got = (cfg.get("title_style") or {}).get("font_weight")
        return float(got) if got else None
    except (TypeError, ValueError):
        return None


def front_align(cfg, front_index):
    """How this front's title lines are aligned against each other.

    ``title_style.front_align["<n>"]`` when that front differs from the rest of
    the deck, else the deck-wide ``title_style.align``, else "center" — the step
    every title took before alignment was measured at all. Per front because a
    deck's fronts are separate artboards: טוקיו sets its two lines flush RIGHT on
    four of its eight fronts and flush LEFT on the other four, so one answer
    misprints half the deck. Same shape as ``front_offset``, and for the same
    reason.
    """
    ts = cfg.get("title_style") or {}
    per = ts.get("front_align") or {}
    got = per.get(str(front_index), per.get(front_index))
    return got or ts.get("align") or "center"


def is_single_card_recipe(recipe):
    """True when a recipe describes ONE card rather than a v1 8-up sheet.

    ``format: 2`` is the canonical marker (absent/1 = legacy 8-up sheet). The
    earlier ``layout: "single"`` marker and a bare ``card`` block are still
    accepted so a recipe detected before the rename keeps rendering. A v1 recipe
    is unambiguous either way: it carries ``cards`` (plural, a LIST of eight
    cells), never ``card``.
    """
    try:
        fmt = int(recipe.get("format") or 0)
    except (TypeError, ValueError):
        fmt = 0
    return fmt >= 2 or recipe.get("layout") == "single" or "card" in recipe


# ---- The owner's saved calibration (themes.json ``card_slots``) ------------
# TWO things write a single-card template's geometry, and they write to
# DIFFERENT files:
#
#   admin calibration form  -> themes.json  "card_slots"   (FRACTIONS of the card)
#   recipe_diff/calibrate   -> recipes/<t>.json "card"      (viewBox USER UNITS)
#
# Both are legitimate — one is the owner measuring by eye in the UI, the other is
# automatic clean<->filled detection — so the generator reads BOTH rather than
# declaring one of them wrong. The owner's saved calibration WINS, because it is
# the more deliberate act and because the admin route refuses to set
# ``calibrated: true`` on a single-card theme without it.
#
# Reading only the recipe (which is what this did until now) meant a template
# calibrated through the admin UI rendered with NO words and NO title — every
# measurement silently ignored. Reading only ``card_slots`` would mirror the same
# bug onto the auto-detection path. Hence: prefer, then fall back.
#
# ``card_slots`` is geometry ONLY (``{words: [4 fracs], titles: {"2": frac, …}}``);
# it carries no colour, so ink colour still comes from the detected recipe, and
# from the theme's title outline when there is no recipe to draw it from.
CARD_WORD_SLOTS = 4


def card_slots(cfg):
    """The owner's saved slot calibration, or None when they haven't saved one."""
    slots = cfg.get("card_slots")
    if not isinstance(slots, dict):
        return None
    words = slots.get("words")
    if not isinstance(words, list) or len(words) < CARD_WORD_SLOTS:
        return None
    return slots


def _box_from_frac(frac, cell):
    """A ``{x0,y0,x1,y1}`` fraction of the card as absolute viewBox units."""
    x0, y0, x1, y1 = cell
    w, h = x1 - x0, y1 - y0
    return {"x0": x0 + frac["x0"] * w, "y0": y0 + frac["y0"] * h,
            "x1": x0 + frac["x1"] * w, "y1": y0 + frac["y1"] * h}


def word_bold_w(cfg, default):
    """Synthetic-bold stroke for this theme's card WORDS, as a size fraction.

    ``0.0`` unless the theme opts in with ``word_bold: true`` — the shipped
    templates were all calibrated against the face's own weight, so bolding by
    default would silently re-weight nine live designs. ``word_bold_w`` overrides
    the house weight for a face that needs more or less.
    """
    if not cfg.get("word_bold"):
        return 0.0
    try:
        return float(cfg.get("word_bold_w") or default)
    except (TypeError, ValueError):
        return default


def _default_ink(cfg):
    """Fallback ink colour when no detected recipe supplies one.

    The title's outline is the template's dark ink, which is what card words are
    drawn in on every shipped design — a far better guess than black, and only
    ever reached when the owner calibrated by hand without running detection.
    """
    return (cfg.get("title_style") or {}).get("outline") or "#000000"


def card_word_boxes(cfg, recipe, cell):
    """The four word slots in viewBox units — owner calibration first.

    Colour is taken from the detected recipe slot at the same position when
    there is one, since ``card_slots`` records no colour.
    """
    detected = (recipe.get("card") or {}).get("words") or []
    slots = card_slots(cfg)
    if not slots:
        return detected
    out = []
    for i, frac in enumerate(slots["words"][:CARD_WORD_SLOTS]):
        box = _box_from_frac(frac, cell)
        was = detected[i] if i < len(detected) else None
        box["color"] = (was or {}).get("color") or _default_ink(cfg)
        out.append(box)
    return out


def card_title_boxes(cfg, recipe, front_index, cell):
    """The title box(es) for one front in viewBox units — owner calibration first.

    The owner's form records ONE box per front; the detector may record one box
    per title LINE. Either way the renderer fits the stacked title into their
    union, so a single box is returned as a one-item list.
    """
    slots = card_slots(cfg)
    titles = (slots or {}).get("titles") or {}
    frac = titles.get(str(front_index), titles.get(front_index))
    if frac:
        box = _box_from_frac(frac, cell)
        box["color"] = (cfg.get("title_style") or {}).get("fill") or _default_ink(cfg)
        return [box]
    return recipe_front_title(recipe, front_index)


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


# Sentinel: a key that is PRESENT and null is an answer ("no title here"), which
# has to stay distinguishable from a key that was never written at all.
_MISSING = object()


def recipe_back_title(recipe, back_index=None):
    """Title boxes for ONE card back — ``[]`` when it has no text slot.

    ``"back": null`` is a legitimate answer, not a gap in calibration:
    grapefruit's back is a full-bleed pattern with no text on it at all. So a
    null/absent back means "print no back title" and must NEVER fall through to
    another card's boxes — that would stamp the honoree's name onto artwork that
    was designed without room for it.

    A template whose eight styles each have their OWN back (#315) answers PER
    BACK, under ``backs`` keyed by the card file number — the same numbering
    ``cards.backs`` uses, so a key means one thing everywhere. Each back was
    drawn separately and may carry the name somewhere else, or nowhere; the
    shared ``back`` above is then the one-back deck's degenerate case.
    """
    backs = recipe.get("backs")
    if isinstance(backs, dict) and back_index is not None:
        entry = backs.get(str(back_index), _MISSING)
        if entry is not _MISSING:
            return entry.get("title") or [] if isinstance(entry, dict) else []
    back = recipe.get("back")
    if not isinstance(back, dict):
        return []
    return back.get("title") or []


def recipe_answered_back(recipe, back_index=None):
    """Whether the recipe says anything definite about this back's title slot.

    Detection writing ``back``/``backs`` is what separates "this surface has no
    text" from "nobody has looked yet" — only the first may print nothing.
    """
    backs = recipe.get("backs")
    if isinstance(backs, dict) and back_index is not None and str(back_index) in backs:
        return True
    return "back" in recipe


def theme_back_slot(cfg, back_index=None):
    """The calibrated title slot for ONE back — ``{frac, fill, outline}`` or None.

    Resolution is most-specific-first, and mirrors :func:`recipe_back_title`:

    * ``backs["<index>"]`` present -> that back's own calibration. An explicit
      ``null`` is an ANSWER ("this back carries no title"), never a gap;
    * otherwise the deck's shared ``back`` — every one-back template, which is
      every template that existed before per-front backs.
    """
    backs = cfg.get("backs")
    if isinstance(backs, dict) and back_index is not None:
        entry = backs.get(str(back_index), _MISSING)
        if entry is not _MISSING:
            return entry if isinstance(entry, dict) else None
    return cfg.get("back")


def has_back_calibration(cfg, back_index=None):
    """Whether this specific back carries its own calibration entry.

    A per-back entry is a more specific answer than the recipe's SHARED back, so
    it has to outrank one: a template converted to per-front backs keeps the
    shared ``back`` its old artwork was detected against, and that answer is no
    longer about the back now being printed.
    """
    backs = cfg.get("backs")
    return (isinstance(backs, dict) and back_index is not None
            and str(back_index) in backs)


def recipe_front_title(recipe, front_index):
    """Title boxes for one front — a list, possibly one box per title line.

    The title MOVES per front (the fronts differ by more than an icon layer), so
    the canonical home is ``card.title`` keyed by front number. Falls back, in
    order, to: that front's own legacy ``fronts["<n>"]`` entry; a shared
    ``card.title`` when it is a plain list rather than a per-front mapping; then
    the union of every other front's boxes. The last fallback keeps a partially
    calibrated template rendering a title in roughly the right place on an
    un-detected front instead of dropping the honoree's name entirely.
    Returns ``[]`` when the recipe records no title anywhere.
    """
    card = recipe.get("card") or {}
    titles = card.get("title")
    per_front = titles if isinstance(titles, dict) else {}
    entry = per_front.get(str(front_index), per_front.get(front_index))
    if entry:
        return entry
    legacy = (recipe.get("fronts") or {}).get(str(front_index))
    if isinstance(legacy, dict) and legacy.get("title"):
        return legacy["title"]
    if isinstance(titles, list) and titles:
        return titles
    boxes = []
    for other in per_front.values():
        if other:
            boxes.extend(other)
    for other in (recipe.get("fronts") or {}).values():
        if isinstance(other, dict) and other.get("title"):
            boxes.extend(other["title"])
    if not boxes:
        return []
    # The MEDIAN of the other fronts' boxes, not their union. A deck's fronts
    # carry the same title in different PLACES (קליפורניה's moves 130 units
    # across the card), so their union is a box far wider than any real title
    # box, and a title centred in it lands nowhere the design puts it. The
    # median is the shape and position a typical front actually uses, which is
    # the best available answer for a front that measured none of its own.
    import statistics
    box = {k: statistics.median([b[k] for b in boxes])
           for k in ("x0", "y0", "x1", "y1")}
    box["color"] = boxes[0].get("color", "#000000")
    return [box]


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


def calibration_gaps(cfg):
    """The measured values this theme is MISSING for a render, as phrases.

    Empty list = renderable. Exactly ONE value belongs here — ``title_style`` —
    because it is the only one with no guard further down: every render path
    dereferences ``cfg["title_style"]`` for the face, size and paints, and there
    is no fallback to reach.

    What is deliberately NOT here, and why:

    * ``board`` / ``back`` null — a real ANSWER, "no title on that surface".
      Shipped daniel-amit and grapefruit both render with board null. The old
      message named these as the failure, which is exactly why a theme whose
      board and back were fully populated read as "board/back are null".
    * ``card_slots`` / the detected recipe — missing card geometry is already
      caught, per surface and with a better message, by ``build.deck_document``
      ("no word-slot geometry ... זהה מחדש"). Refusing it here too would break
      the documented split that guard states: a PREVIEW may render a bare card,
      because the calibration screen is the very thing that fixes the geometry;
      an ORDER may not print 104 blank ones.

    This is also the same condition server/templates.js already enforces before
    it will let ``calibrated`` be flipped true, so nothing that could legally be
    marked calibrated is refused here.
    """
    gaps = []
    if not isinstance(cfg.get("title_style"), dict):
        gaps.append(
            "title_style — the face, size and colour every title renders with"
        )
    return gaps


def ensure_calibrated(cfg):
    """Raise a clear error when a theme lacks what a render actually consumes.

    This checks the VALUES, not the stored ``calibrated`` boolean. The boolean is
    the admin's "I have eyeballed this" badge and it DRIFTS from the values: two
    different writers set the geometry (the calibration form and automatic
    detection) while several admin actions reset the flag — switching a template's
    card_structure, front list or back mode each blank it deliberately, and the
    re-detection that follows writes fresh measurements back without ever
    restoring it. The result was eight of eleven live designs on staging carrying
    a full, correct title_style/board/back/card_slots behind ``calibrated:
    false``, refusing every name preview AND every order generation — while the
    error insisted those very fields were null.

    Reading the values removes the drift entirely: the gate is now the same
    condition the admin enforces before it will let the flag go true, so it is
    the flag that follows the geometry rather than the other way round.

    What this gives up, stated plainly: a template whose title_style was written
    by automatic detection and never eyeballed by the owner will now render
    instead of failing hard. That is the deliberate trade, and it is a narrow one
    — the deck's own geometry guard (``build.deck_document``) still refuses an
    ORDER with no word slots, so what this lets through is a card that may be
    mis-STYLED, never one that prints blank. The failure it replaces was not "we
    caught a bad-looking card": it was a total refusal on designs whose
    calibration was present and correct, under a message that sent everyone
    hunting for data that was already there.

    A PREVIEW carrying unsaved calibration knobs keeps its own exemption: it may
    render a template with NO stored geometry at all so the owner can see the look
    before saving. That still requires the knobs to supply a usable ``title_style``
    dict — otherwise the render only gets further before dying on a missing
    fill/outline.
    """
    if cfg.get(_PREVIEW_MARK) and isinstance(cfg.get("title_style"), dict):
        return
    gaps = calibration_gaps(cfg)
    if not gaps:
        return
    # The phrase "not calibrated" is load-bearing, not prose: server/index.js
    # classifies a generator failure by matching /not calibrated|unknown theme/i
    # to answer 400 rather than 500, so rewording the opening would turn an
    # actionable "measure this" into an opaque server error.
    raise RuntimeError(
        f"theme {cfg.get('slug', '?')!r} is not calibrated for rendering — "
        "it is missing: " + "; ".join(gaps)
        + ". Open the template's calibration form, measure what is listed above "
        "and save. (The stored calibrated flag is not what is checked here — "
        f"this theme's is {bool(cfg.get('calibrated'))!r} — so flipping it "
        "changes nothing until the values themselves are there.)"
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
