#!/usr/bin/env python3
"""Tests for the owner's photo-card pawn overrides (DATA_DIR/photo-fallback.json).

The admin panel lets the owner replace any of the four fallback pawns without a
deploy. Before this was read, the owner could upload a pawn, see it on screen,
and it would never print — a silent no-op on a paid order. These pin the read
side and, just as importantly, that a BAD store degrades to the shipped pawns
rather than failing an order.

Run: python3 generator/test_photo_fallback_overrides.py   (or via pytest)
"""
import json
import os
import shutil
import tempfile

import config

UPLOAD = "0123456789abcdef.png"


class Store:
    """A throwaway DATA_DIR with an uploads dir, plus a fake shipped pawn set."""

    def __init__(self, slots=None, raw=None, upload_names=(UPLOAD,)):
        self.slots = slots
        self.raw = raw
        self.upload_names = upload_names

    def __enter__(self):
        self.tmp = tempfile.mkdtemp(prefix="dugri-pfb-")
        uploads = os.path.join(self.tmp, "content-uploads")
        os.makedirs(uploads)
        for name in self.upload_names:
            with open(os.path.join(uploads, name), "wb") as f:
                f.write(b"\x89PNG")
        if self.slots is not None or self.raw is not None:
            path = os.path.join(self.tmp, config.PHOTO_FALLBACK_STORE)
            with open(path, "w", encoding="utf-8") as f:
                if self.raw is not None:
                    f.write(self.raw)
                else:
                    json.dump({"slots": self.slots}, f)
        # A fake shipped set, so the test never depends on the real artwork.
        self.shipped = os.path.join(self.tmp, "_shared", "photo-fallback")
        os.makedirs(self.shipped)
        for i in range(1, config.PHOTO_FALLBACK_COUNT + 1):
            with open(os.path.join(self.shipped, f"{i}.svg"), "w", encoding="utf-8") as f:
                f.write("<svg/>")
        self._shared_prev = config.SHARED_TEMPLATES_DIR
        config.SHARED_TEMPLATES_DIR = os.path.join(self.tmp, "_shared")
        self._data_prev = os.environ.get("DATA_DIR")
        os.environ["DATA_DIR"] = self.tmp
        return self.tmp

    def __exit__(self, *exc):
        config.SHARED_TEMPLATES_DIR = self._shared_prev
        if self._data_prev is None:
            os.environ.pop("DATA_DIR", None)
        else:
            os.environ["DATA_DIR"] = self._data_prev
        shutil.rmtree(self.tmp, ignore_errors=True)


def _names(paths):
    return [os.path.basename(p) for p in paths]


# --- the happy path ---------------------------------------------------------

def test_an_override_replaces_only_its_own_slot():
    with Store(slots={"2": "/content-uploads/" + UPLOAD}) as tmp:
        got = config._photo_fallback_overrides()
        assert got == {2: os.path.join(tmp, "content-uploads", UPLOAD)}, got


def test_the_resolved_set_keeps_slot_order_and_mixes_extensions():
    # Overrides are rasters, shipped pawns are SVG (content.js refuses SVG
    # uploads on purpose), so a real set is routinely mixed — slot N still takes
    # pawn N.
    with Store(slots={"2": "/content-uploads/" + UPLOAD}) as tmp:
        paths = _resolve()
        assert _names(paths) == ["1.svg", UPLOAD, "3.svg", "4.svg"], _names(paths)


def _resolve():
    """photo_fallback_paths for a theme with no fallback of its own."""
    return config.photo_fallback_paths.__wrapped__(None) \
        if hasattr(config.photo_fallback_paths, "__wrapped__") else _resolve_via_theme()


def _resolve_via_theme():
    """Drive the real function through a minimal in-memory theme."""
    themes = {"demo": {"slug": "demo", "dir": "d", "recipe": "demo",
                       "cards": {"back": 1, "fronts": [2, 3]}}}
    path = os.path.join(os.environ["DATA_DIR"], "themes-for-test.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(themes, f)
    prev, config.THEMES_JSON = config.THEMES_JSON, path
    try:
        return config.photo_fallback_paths("demo")
    finally:
        config.THEMES_JSON = prev


# --- every way the store can be bad ----------------------------------------

def test_no_data_dir_means_no_overrides():
    prev = os.environ.pop("DATA_DIR", None)
    try:
        assert config._photo_fallback_overrides() == {}
    finally:
        if prev is not None:
            os.environ["DATA_DIR"] = prev


def test_a_missing_store_is_the_normal_state():
    with Store():                      # no photo-fallback.json written at all
        assert config._photo_fallback_overrides() == {}


def test_corrupt_json_degrades_to_the_shipped_pawns():
    with Store(raw="{not json at all"):
        assert config._photo_fallback_overrides() == {}
        assert _names(_resolve_via_theme()) == ["1.svg", "2.svg", "3.svg", "4.svg"]


def test_a_non_object_slots_value_is_ignored():
    with Store(raw=json.dumps({"slots": ["1.png"]})):
        assert config._photo_fallback_overrides() == {}


def test_an_override_pointing_at_a_missing_file_falls_back():
    with Store(slots={"2": "/content-uploads/aaaaaaaaaaaaaaaa.png"}):
        assert config._photo_fallback_overrides() == {}
        assert _names(_resolve_via_theme()) == ["1.svg", "2.svg", "3.svg", "4.svg"]


def test_a_traversal_value_is_refused():
    # basename() alone would reduce this to a real upload name, so the SHAPE
    # check is what actually stops a doctored value naming another file.
    with Store(slots={"2": "../../../etc/passwd"}):
        assert config._photo_fallback_overrides() == {}


def test_an_off_shape_filename_is_refused():
    with Store(slots={"2": "/content-uploads/evil.svg"},
               upload_names=(UPLOAD, "evil.svg")):
        assert config._photo_fallback_overrides() == {}


def test_a_slot_outside_one_to_four_is_ignored():
    with Store(slots={"0": "/content-uploads/" + UPLOAD,
                      "5": "/content-uploads/" + UPLOAD,
                      "x": "/content-uploads/" + UPLOAD}):
        assert config._photo_fallback_overrides() == {}


def test_every_slot_can_be_overridden_at_once():
    names = tuple(f"{i:016x}.png" for i in range(1, 5))
    slots = {str(i): "/content-uploads/" + n for i, n in enumerate(names, 1)}
    with Store(slots=slots, upload_names=names):
        assert _names(_resolve_via_theme()) == list(names)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print(f"  {fn.__name__}")
    print(f"all {len(fns)} tests passed")
