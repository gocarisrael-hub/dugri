#!/usr/bin/env python3
"""Re-run a template's automatic detection and REPORT the drift. Never applies it.

Both detection passes we have only ever run ONCE, when a template is onboarded:
``recipe_diff.py`` finds the front card's word/title slots, and ``calibrate.py``
derives the board/back title slots and the title's paints. Nothing re-runs when
the artwork behind them is later replaced — the upload path just refuses to
overwrite a calibrated template's SVG until an admin confirms with ``force``, and
after that confirmation the stored recipe and calibration silently describe art
that no longer exists.

This module is the missing other half: point it at a theme key and it re-measures
BOTH passes against whatever art is on disk right now, then lines every measured
value up against what is currently stored and says how far apart they are::

    board.frac.y0   stored 0.885   detected 0.9137   drift 2.87% of the page

DETECTION PROPOSES, A HUMAN DISPOSES. This module writes NOTHING: not
``themes.json``, not ``generator/recipes/*.json``, and it never touches the
``calibrated`` flag. It only produces a report. That is deliberate — a re-detected
number is a measurement, not a decision, and a wrong measurement written
automatically over a hand-tuned value is exactly the failure the upload guard
exists to prevent. The point is to let someone SEE "the title box moved 3% — go
look at that" and then choose.

``recipe_diff.main()`` writes its recipe to disk as a side effect, so this module
drives its detection primitives directly rather than calling it, which is also
why the recipe half needs no temp-file juggling to stay read-only.

HONESTY ABOUT FAILURE, inherited from ``calibrate.py``: a value that cannot be
measured is reported as ``unmeasured`` and the stored value stands. It is never
silently rendered as "changed to null" — failing to see a title and a title
having moved look nothing alike, and only one of them is a reason to act.
Every row therefore carries one of four statuses:

  same         measured, and within tolerance of what is stored
  changed      measured, and beyond tolerance — this is the one worth looking at
  new          nothing stored yet; the measurement is the first value
  unmeasured   this pass produced no number, for the reason in ``note``

Geometry and colour are graded SEPARATELY (again as ``calibrate.py`` does): boxes
are measured far more reliably than paints, so a design whose colours could not be
read can still have its slots confirmed as unmoved, and the summary must not blend
the two into one meaningless score.

Knobs ``calibrate.py`` deliberately never measures — ``size``/``board_size``/
``back_size``, ``arch``, ``offset``, ``word_size`` — are listed under
``not_checked`` rather than compared, so their absence from the drift list is not
mistaken for "checked and unchanged".

  python3 generator/redetect.py <theme-key> [--out FILE]
"""
import argparse
import json
import os
import subprocess
import sys
import tempfile
from collections import Counter

from PIL import Image

import calibrate
import config
import recipe_diff

HERE = os.path.dirname(os.path.abspath(__file__))

# Below this, a geometry difference is render jitter, not movement. Both passes
# re-rasterize the SVGs through headless Chrome and threshold the diff, so a
# box's edge can land a pixel either way between two runs of the SAME art. Half a
# percent of the reference surface is comfortably above that and far below any
# drift a human would notice on a printed card.
GEOM_TOLERANCE = 0.005
# Same idea for paints, in summed per-channel RGB distance (the metric
# calibrate._rgb_dist uses). Flat vector fills re-render to the identical value,
# so anything past a nudge here is a genuinely different colour.
COLOR_TOLERANCE = 12

SAME, CHANGED, NEW, UNMEASURED = "same", "changed", "new", "unmeasured"
GEOMETRY, COLOR, FLAG, STRUCTURE = "geometry", "color", "flag", "structure"

# Calibration knobs no detection pass measures — see calibrate.py's docstring for
# why each is a visual call rather than something readable off the ink.
NOT_CHECKED = {
    "title_style.size": "the renderer auto-fits the title to its box; a pinned "
                        "size is a visual call",
    "title_style.board_size": "as size, for the board",
    "title_style.back_size": "as size, for the card backs",
    "title_style.arch": "only meaningful on a genuinely curved title",
    "title_style.offset": "a nudge that CORRECTS a mis-detected box — if "
                          "detection is right it is zero by definition",
    "word_size": "the words auto-fit their slots from the recipe",
}


# ---------------------------------------------------------------------------
# row builders
# ---------------------------------------------------------------------------


def _row(path, kind, stored, detected, status, delta=None, delta_pct=None,
         note=None):
    row = {"path": path, "kind": kind, "stored": stored, "detected": detected,
           "status": status}
    if delta is not None:
        row["delta"] = delta
    if delta_pct is not None:
        row["delta_pct"] = delta_pct
    if note:
        row["note"] = note
    return row


def _num_row(path, stored, detected, ref=1.0, tol=GEOM_TOLERANCE,
             kind=GEOMETRY, note=None):
    """Compare one number. ``ref`` is the surface the drift is expressed against."""
    if detected is None:
        return _row(path, kind, stored, None, UNMEASURED,
                    note=note or ("this pass produced no value — the stored one "
                                  "stands until someone measures it by hand"))
    if stored is None:
        return _row(path, kind, None, detected, NEW,
                    note="nothing stored for this — the measurement is the first value")
    try:
        delta = abs(float(detected) - float(stored)) / (float(ref) or 1.0)
    except (TypeError, ValueError):
        return _row(path, kind, stored, detected,
                    SAME if stored == detected else CHANGED,
                    note="values are not numeric; compared for equality only")
    return _row(path, kind, stored, detected,
                SAME if delta <= tol else CHANGED,
                delta=round(delta, 5), delta_pct=round(delta * 100, 2))


def _rgb(value):
    """A #rrggbb string as an (r, g, b) tuple, or None if it isn't one."""
    if not isinstance(value, str):
        return None
    s = value.strip().lstrip("#")
    if len(s) != 6:
        return None
    try:
        return tuple(int(s[i:i + 2], 16) for i in (0, 2, 4))
    except ValueError:
        return None


def _color_row(path, stored, detected, tol=COLOR_TOLERANCE):
    if detected is None:
        return _row(path, COLOR, stored, None, UNMEASURED,
                    note="the ink's colour could not be read — the stored paint "
                         "stands; this is a measurement failure, not a change")
    if stored is None:
        return _row(path, COLOR, None, detected, NEW,
                    note="nothing stored for this paint")
    a, b = _rgb(stored), _rgb(detected)
    if not a or not b:
        return _row(path, COLOR, stored, detected,
                    SAME if stored == detected else CHANGED,
                    note="not a hex colour; compared for equality only")
    delta = calibrate._rgb_dist(a, b)
    return _row(path, COLOR, stored, detected,
                SAME if delta <= tol else CHANGED, delta=delta)


def _flag_row(path, stored, detected):
    """Compare a categorical/boolean knob (align, shadow, card counts)."""
    if detected is None:
        return _row(path, FLAG, stored, None, UNMEASURED,
                    note="no signal for this — the stored value stands")
    if stored is None:
        return _row(path, FLAG, None, detected, NEW)
    return _row(path, FLAG, stored, detected,
                SAME if stored == detected else CHANGED)


def _box_rows(prefix, stored, detected, ref_w, ref_h, tol=GEOM_TOLERANCE):
    """Rows for one x0/y0/x1/y1 box, drift expressed against ``ref_w``/``ref_h``."""
    rows = []
    for key, ref in (("x0", ref_w), ("y0", ref_h), ("x1", ref_w), ("y1", ref_h)):
        s = (stored or {}).get(key) if isinstance(stored, dict) else None
        d = (detected or {}).get(key) if isinstance(detected, dict) else None
        rows.append(_num_row(f"{prefix}.{key}", s, d, ref=ref, tol=tol))
    return rows


# ---------------------------------------------------------------------------
# recipe: re-detect without writing
# ---------------------------------------------------------------------------


def detect_recipe(theme_key, workdir):
    """Re-run ``recipe_diff``'s front-card detection IN MEMORY.

    Returns ``(recipe_dict, None)`` or ``(None, reason)``. The reason is a plain
    sentence, because "could not measure" has to be reportable — a caller must
    never receive an empty recipe that looks like "the art has no slots".
    """
    tdir = config.theme_dir(theme_key)
    filled = os.path.join(tdir, "filled", "fronts.svg")
    clean = os.path.join(tdir, "clean", "fronts.svg")
    for path in (filled, clean):
        if not os.path.exists(path):
            return None, (f"missing {config.display_path(path)} — "
                          f"detection subtracts the clean sheet from the filled "
                          f"one, so without both there is nothing to measure")
    try:
        w, h, vb = recipe_diff.dims(clean)
    except (OSError, AttributeError) as exc:
        return None, f"could not read the clean fronts SVG header ({exc})"

    ppu = (w * recipe_diff.SCALE) / vb[2]
    tpng = os.path.join(workdir, "redetect_filled.png")
    cpng = os.path.join(workdir, "redetect_clean.png")
    try:
        recipe_diff.render(filled, tpng, w, h)
        recipe_diff.render(clean, cpng, w, h)
    except (OSError, subprocess.SubprocessError) as exc:
        return None, (f"headless render failed ({exc}) — set CHROME to a Chrome "
                      f"binary to re-detect the recipe")
    if not (os.path.exists(tpng) and os.path.exists(cpng)):
        return None, "headless Chrome produced no screenshot"

    tim = Image.open(tpng).convert("RGB")
    cim = Image.open(cpng).convert("RGB")
    if tim.size != cim.size:
        cim = cim.resize(tim.size)
    mask = recipe_diff.diff_mask(tim, cim)
    page_bg = Counter(cim.crop((0, 0, 40, 40)).getdata()).most_common(1)[0][0]
    cells, _cols, _rows = recipe_diff.grid_cells(cim, page_bg)
    if not cells:
        return None, ("could not find the card grid on the fronts sheet — the "
                      "clean export may not match the filled one")

    out = {"theme": theme_key, "viewBox": vb, "cards": []}
    for cell in cells:
        cx0, cy0, cx1, cy1 = cell
        grouped = recipe_diff.group_words(
            recipe_diff.rows_in_cell(mask, cell), cy1 - cy0)
        if not grouped:
            out["cards"].append(None)
            continue

        def to_units(f, _cx0=cx0, _cy0=cy0):
            return {"x0": (_cx0 + f["x0"]) / ppu, "y0": (_cy0 + f["y0"]) / ppu,
                    "x1": (_cx0 + f["x1"]) / ppu, "y1": (_cy0 + f["y1"]) / ppu}

        entry = {"cell": [cx0 / ppu, cy0 / ppu, cx1 / ppu, cy1 / ppu],
                 "words": [], "title": []}
        for slot_key in ("words", "title"):
            for f in grouped[slot_key]:
                unit = to_units(f)
                unit["color"] = recipe_diff.color_of(tim, cell, f)
                entry[slot_key].append(unit)
        out["cards"].append(entry)
    empty = empty_recipe_reason(len(cells), out["cards"])
    if empty:
        return None, empty
    return out, None


def empty_recipe_reason(cell_count, cards):
    """Why an all-empty detection is a FAILURE and not a recipe, or None.

    Cells found but not one of them yielding slots must be reported as "could not
    measure". Returning the all-empty recipe instead would diff against the stored
    one as "every card lost its slots" — which reads like the artwork was gutted,
    when in truth nothing was measured at all. Observed for real on the shipped
    ``football-boys``, whose fronts sheet splits into 2 cells and reads none.
    """
    if any(cards):
        return None
    return (f"the fronts sheet split into {cell_count} cell(s) but no card "
            f"yielded word slots — the clean export may not match the filled one")


def stored_recipe(theme_key):
    """``(recipe_dict_or_None, absolute_path)`` for the theme's stored recipe."""
    cfg = config.theme(theme_key)
    path = config.recipe_path(cfg["recipe"])
    if not os.path.exists(path):
        return None, path
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f), path
    except (OSError, ValueError):
        return None, path


def compare_recipe(stored, detected, tol=GEOM_TOLERANCE, color_tol=COLOR_TOLERANCE):
    """Diff a stored recipe against a freshly detected one, slot by slot.

    Card cells are compared against the PAGE (they are page-level furniture);
    word and title slots against their own CARD CELL, because "this word slot
    moved 3% of the card" is the number that decides whether a printed card looks
    wrong, while the same movement as a fraction of the page reads as nothing.
    """
    rows = []
    scards = (stored or {}).get("cards") or []
    dcards = (detected or {}).get("cards") or []
    rows.append(_flag_row("recipe.cards", len(scards) or None,
                          len(dcards) or None))

    svb = (stored or {}).get("viewBox") or [0, 0, 1, 1]
    page_w, page_h = (svb[2] or 1), (svb[3] or 1)

    for i in range(max(len(scards), len(dcards))):
        sc = scards[i] if i < len(scards) else None
        dc = dcards[i] if i < len(dcards) else None
        tag = f"recipe.card{i + 1}"
        if not sc and not dc:
            rows.append(_row(tag, STRUCTURE, None, None, UNMEASURED,
                             note="no slots stored and none detected"))
            continue
        if not dc:
            rows.append(_row(tag, STRUCTURE, "slots", None, UNMEASURED,
                             note="detection found no slots on this card — the "
                                  "stored ones stand"))
            continue
        if not sc:
            rows.append(_row(tag, STRUCTURE, None, "slots", NEW))
            continue

        scell, dcell = sc.get("cell") or [], dc.get("cell") or []
        for k, key in enumerate(("x0", "y0", "x1", "y1")):
            rows.append(_num_row(
                f"{tag}.cell.{key}",
                scell[k] if len(scell) > k else None,
                dcell[k] if len(dcell) > k else None,
                ref=page_w if key in ("x0", "x1") else page_h, tol=tol))

        cell_w = (scell[2] - scell[0]) if len(scell) == 4 else page_w
        cell_h = (scell[3] - scell[1]) if len(scell) == 4 else page_h
        for slot_key, label in (("words", "word"), ("title", "title")):
            sslots = sc.get(slot_key) or []
            dslots = dc.get(slot_key) or []
            if len(sslots) != len(dslots):
                rows.append(_flag_row(f"{tag}.{slot_key}", len(sslots), len(dslots)))
            for j in range(max(len(sslots), len(dslots))):
                s = sslots[j] if j < len(sslots) else None
                d = dslots[j] if j < len(dslots) else None
                prefix = f"{tag}.{label}{j + 1}"
                rows.extend(_box_rows(prefix, s, d, cell_w, cell_h, tol=tol))
                rows.append(_color_row(f"{prefix}.color",
                                       (s or {}).get("color"),
                                       (d or {}).get("color"), tol=color_tol))
    return rows


# ---------------------------------------------------------------------------
# calibration: compare the fresh blob against what themes.json holds
# ---------------------------------------------------------------------------


def compare_calibration(cfg, blob, tol=GEOM_TOLERANCE, color_tol=COLOR_TOLERANCE):
    """Diff the stored theme entry against a freshly derived calibration blob.

    ``cfg`` is the themes.json entry, ``blob`` whatever ``calibrate.calibrate``
    returned. Only the knobs calibration actually measures are compared; the rest
    are reported separately as unchecked.
    """
    rows = []
    sts = cfg.get("title_style") or {}
    dts = blob.get("title_style") or {}
    rows.append(_color_row("title_style.fill", sts.get("fill"), dts.get("fill"),
                           tol=color_tol))
    rows.append(_color_row("title_style.outline", sts.get("outline"),
                           dts.get("outline"), tol=color_tol))
    # outline_w is a fraction of one title line's height, so it is already
    # dimensionless — compared against 1.0 with the same tolerance.
    rows.append(_num_row("title_style.outline_w", sts.get("outline_w"),
                         dts.get("outline_w"), ref=1.0, tol=tol))
    rows.append(_flag_row("title_style.align", sts.get("align"), dts.get("align")))
    rows.append(_flag_row("title_style.shadow", sts.get("shadow"),
                          dts.get("shadow")))

    for surface in ("board", "back"):
        s = cfg.get(surface) or {}
        d = blob.get(surface) or {}
        if not s and not d:
            rows.append(_row(surface, STRUCTURE, None, None, UNMEASURED,
                             note=f"no {surface} title stored and none detected"))
            continue
        if not d:
            rows.append(_row(surface, STRUCTURE, "slot", None, UNMEASURED,
                             note=f"the {surface} title could not be isolated — "
                                  f"the stored slot stands"))
            continue
        if not s:
            rows.append(_row(surface, STRUCTURE, None, "slot", NEW))
        # Board fractions are of the PAGE, back fractions of the CARD CELL; both
        # are already normalized to 0..1, so drift is a straight difference.
        rows.extend(_box_rows(f"{surface}.frac", s.get("frac"), d.get("frac"),
                              1.0, 1.0, tol=tol))
        rows.append(_color_row(f"{surface}.fill", s.get("fill"), d.get("fill"),
                               tol=color_tol))
        rows.append(_color_row(f"{surface}.outline", s.get("outline"),
                               d.get("outline"), tol=color_tol))
    return rows


# ---------------------------------------------------------------------------
# grading
# ---------------------------------------------------------------------------


def summarize(rows):
    """Counts and the worst drift, graded SEPARATELY per kind.

    Geometry and colour are measured with very different reliability, so folding
    them into one score would let an unreadable paint mask a slot that did not
    move — or the reverse.
    """
    out = {}
    for row in rows:
        bucket = out.setdefault(row["kind"], {
            SAME: 0, CHANGED: 0, NEW: 0, UNMEASURED: 0, "worst": None})
        bucket[row["status"]] += 1
        if row["status"] != CHANGED:
            continue
        delta = row.get("delta")
        if delta is None:
            if bucket["worst"] is None:
                bucket["worst"] = {"path": row["path"], "delta": None}
            continue
        if bucket["worst"] is None or (bucket["worst"].get("delta") or -1) < delta:
            bucket["worst"] = {"path": row["path"], "delta": delta,
                               "delta_pct": row.get("delta_pct")}
    return out


def verdict(rows):
    """One word for the whole report."""
    statuses = {row["status"] for row in rows}
    if CHANGED in statuses:
        return "drifted"
    if statuses & {SAME, NEW}:
        return "in-sync"
    return "unmeasured"


# ---------------------------------------------------------------------------
# the entry point
# ---------------------------------------------------------------------------


def redetect(theme_key, workdir=None, tol=GEOM_TOLERANCE, color_tol=COLOR_TOLERANCE):
    """Re-measure one theme's recipe + calibration and report the drift.

    Pure read: nothing on disk is modified. Returns a report dict; see the module
    docstring for the row shape and what each status means.
    """
    cfg = config.theme(theme_key)
    own = workdir is None
    workdir = workdir or tempfile.mkdtemp(prefix="dugri-redetect-")
    try:
        stored, recipe_path = stored_recipe(theme_key)
        detected, recipe_error = detect_recipe(theme_key, workdir)
        recipe_rows = ([] if recipe_error
                       else compare_recipe(stored, detected, tol, color_tol))
        recipe_note = None
        if stored is None and not recipe_error:
            recipe_note = ("no recipe stored for this theme — every slot below "
                           "is new, so nothing here has drifted")

        try:
            blob = calibrate.calibrate(theme_key, workdir=workdir)
            calib_error = None
        except Exception as exc:  # noqa: BLE001 - any failure must be reportable
            blob, calib_error = None, f"{type(exc).__name__}: {exc}"
        calib_rows = [] if blob is None else compare_calibration(
            cfg, blob, tol, color_tol)

        report = {
            "theme": theme_key,
            "tolerance": {"geometry": tol, "color": color_tol},
            "recipe": {
                "path": config.display_path(recipe_path),
                "stored": stored is not None,
                "error": recipe_error,
                "note": recipe_note,
                "rows": recipe_rows,
                "summary": summarize(recipe_rows),
            },
            "calibration": {
                "error": calib_error,
                "rows": calib_rows,
                "summary": summarize(calib_rows),
                "confidence": (blob or {}).get("confidence") or {},
                "notes": (blob or {}).get("notes") or [],
                "not_checked": [
                    {"path": path, "why": why,
                     "stored": _stored_at(cfg, path)}
                    for path, why in sorted(NOT_CHECKED.items())
                ],
            },
            "detected": {"recipe": detected, "calibration": blob},
            "applied": False,
        }
        report["verdict"] = verdict(recipe_rows + calib_rows)
        return report
    finally:
        if own:
            import shutil
            shutil.rmtree(workdir, ignore_errors=True)


def _stored_at(cfg, dotted):
    """Look up a dotted path in the theme entry (None when absent)."""
    node = cfg
    for part in dotted.split("."):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def _section_text(name, section):
    lines = [f"{name}:"]
    if section.get("error"):
        lines.append(f"  could not measure — {section['error']}")
        return lines
    if section.get("note"):
        lines.append(f"  {section['note']}")
    for kind, counts in sorted(section["summary"].items()):
        worst = counts.get("worst")
        tail = ""
        if worst:
            pct = worst.get("delta_pct")
            tail = (f"   worst: {worst['path']}"
                    + (f" {pct}%" if pct is not None else ""))
        lines.append(f"  {kind:9} same {counts[SAME]}  changed {counts[CHANGED]}"
                     f"  new {counts[NEW]}  unmeasured {counts[UNMEASURED]}{tail}")
    changed = [r for r in section["rows"] if r["status"] == CHANGED]
    changed.sort(key=lambda r: r.get("delta") or 0, reverse=True)
    for row in changed[:20]:
        pct = row.get("delta_pct")
        drift = f"  drift {pct}%" if pct is not None else (
            f"  delta {row['delta']}" if row.get("delta") is not None else "")
        lines.append(f"    {row['path']}: stored {row['stored']!r} -> "
                     f"detected {row['detected']!r}{drift}")
    if len(changed) > 20:
        lines.append(f"    ... and {len(changed) - 20} more changed values")
    unmeasured = [r for r in section["rows"] if r["status"] == UNMEASURED]
    for row in unmeasured[:10]:
        lines.append(f"    {row['path']}: UNMEASURED — {row.get('note', '')}")
    if len(unmeasured) > 10:
        lines.append(f"    ... and {len(unmeasured) - 10} more unmeasured values")
    return lines


def report_text(report):
    """The report as a human-readable block — what someone actually reads."""
    lines = [f"{report['theme']}: {report['verdict']}"]
    lines += _section_text("recipe", report["recipe"])
    lines += _section_text("calibration", report["calibration"])
    for note in report["calibration"]["notes"]:
        lines.append(f"  note: {note}")
    lines.append("  nothing was written — this is a proposal, not a change")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(
        description="Re-run a template's recipe + calibration detection and "
                    "report how far the result has drifted from what is stored. "
                    "Writes nothing.")
    ap.add_argument("theme", help="a key in generator/themes.json")
    ap.add_argument("--out", default=None, metavar="FILE",
                    help="write the report here as JSON (default: stdout as JSON)")
    ap.add_argument("--tolerance", type=float, default=GEOM_TOLERANCE,
                    metavar="FRAC",
                    help=f"geometry drift below this fraction of the reference "
                         f"surface counts as unchanged (default {GEOM_TOLERANCE})")
    args = ap.parse_args()

    try:
        report = redetect(args.theme, tol=args.tolerance)
    except KeyError as exc:
        print(str(exc).strip("'\""), file=sys.stderr)
        return 2

    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(json.dumps(report, ensure_ascii=False, indent=1))
        print(report_text(report))
        print(f"-> {args.out}")
    else:
        print(json.dumps(report, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
