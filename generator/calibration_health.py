#!/usr/bin/env python3
"""Check whether a theme's stored calibration still matches its CURRENT assets.

``calibrate.py`` derives a template's calibration once, from its artwork. This
module is the other half: it re-checks a calibration that was saved earlier and
asks whether it is still true today. Nothing else does — the upload guard in
``server/templates.js`` only re-validates a replaced SVG, so the geometry is
watched and the FONTS are not.

Why fonts are the dangerous half. Swapping a template's title font leaves the
detected geometry perfectly valid: the artwork never moved, so the title box is
still in the right place. What changes is the FIT — a different typeface fills
the same box differently. Any pinned ``size`` / ``board_size`` / ``back_size``
in ``title_style`` bypasses ``render_page.title_block``'s auto-fit and paints at
that exact number, so after a font swap the pin is silently wrong and the title
prints too large (spilling onto the artwork) or too small on the customer's
print-ready PDF. There is no error, no crash, and no warning — just a bad file.

What is checked (each independently; one unmeasurable item never hides another):

  structure   ``calibrated: true`` really does carry everything the renderer
              indexes — a missing ``title_style["arch"]`` is a KeyError mid-order
  assets      the title font, the word font, the recipe and the clean artwork
              are all actually on disk under the names themes.json gives
  title fit   for every PINNED size, what ``title_block`` would paint at that
              size with the CURRENT font, measured against the calibrated box
  font drift  whether the title font file changed on disk AFTER the calibration
              was last saved (read out of git history — no new state stored)
  word slots  whether the theme's own wordlist still fits its word slots with
              the current word font, or is being silently shrunk word by word
  front title whether EVERY front has a title box of its own, or is silently
              borrowing the median of its siblings' — which is wrong wherever
              that front's title sits somewhere they do not

Read-only, always: this module never writes ``themes.json`` and never flips
``calibrated``. It reports; a human decides.

Honest about uncertainty. Every threshold below is anchored either to a constant
the RENDERER itself uses, or to a value measured across all eight shipped themes
(quoted inline). Anything that cannot be measured — a font PIL cannot open, a
board SVG with no viewBox, a git history that isn't there — is reported in
``unknown`` rather than guessed at, the same way ``calibrate.py`` reports "could
not measure" instead of inventing a value.

  python3 generator/calibration_health.py <theme-key> [--out FILE] [--name NAME]

``<theme-key>`` may be the literal ``all`` to check every theme. Without
``--out`` a human-readable report is printed; with it the same findings are
written as JSON. Exit status is 1 when any problem was found (so it can gate a
script), 0 when everything checked out.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile

import build
import config
import render_page as rp
import topup

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- Thresholds ------------------------------------------------------------
# A pinned title that paints past its calibrated box by more than this — on
# either axis — is too big. Deliberately the renderer's OWN tolerance
# (``title_block`` keeps a size whose ink overruns the box by up to
# _TITLE_OVERFLOW_TOL and only then falls back to the metric ink-fit), so this
# flags what the renderer itself already considers past acceptable, rather than
# a number invented here. Measured over the eight shipped themes (worst case
# across all their pinned sizes and every reference name): 1.086 of the box on
# height and 0.978 on width, so every known-good pin clears it with room.
_OVERFLOW = 1.0 + rp._TITLE_OVERFLOW_TOL

# ...and painting SHORTER than this share of the box is too small. This one has
# to be loose, because a calibrated box is not a tight bound on the intended
# title: a detected box can be much larger than the title that sits in it, and
# an ``offset`` nudges the box rather than resizing it. Measured over the same
# eight themes the smallest genuine fill is birthday-girls-neon's front title at
# 0.525 of its box, so the floor sits well below every known-good value and still
# catches a font swap that halves the ink.
_TOO_SMALL = 0.35

# Share of a theme's own wordlist that may be shrunk by the per-word clamp
# before the card stops looking uniform. Measured: with their shipped word fonts
# ALL eight themes clamp 0 of 200 words, with at least 1.39x width headroom on
# the tightest — so any clamping at all is already a change from today.
_WORD_CLAMP_WARN = 0.05
_WORD_CLAMP_FAIL = 0.25

# How many words of the theme's wordlist to measure against its slots.
_WORD_SAMPLE = 200

# Keys ``render_page.build_page`` / ``build.render_*`` index directly on
# ``title_style``. A missing one is a KeyError in the middle of an order.
_TITLE_STYLE_REQUIRED = ("fill", "outline", "outline_w", "arch", "shadow")
# ...and on a board/back slot.
_SLOT_REQUIRED = ("fill", "outline", "frac")
_FRAC_KEYS = ("x0", "y0", "x1", "y1")

# Reference honorees used to build sample titles when the caller names none.
#
# A title's painted size depends on the honoree, and BOTH axes depend on it in
# ways that would otherwise produce false alarms:
#   width   is set by how long the name is, and a pinned size never shrinks to
#           fit, so every shipped theme already overflows its box sideways for a
#           long enough name (measured: birthday-girls runs 52% past its box on
#           an 8-letter name and is correct as shipped)
#   height  is set by which glyphs the name happens to contain — measured on
#           bachelorette's script face, a name with a descender ("Gaby") paints
#           19% taller than one without ("Michelle") at the very same size
#
# So the theme is measured against a SPREAD of names — none, one, and both of an
# ascender and a descender — and a verdict is only reached where the whole
# spread agrees (see ``_fit``). That makes the verdict name-independent by
# construction: "too big even for the most compact name", "too small even for
# the tallest". A name the caller passes explicitly replaces the spread, because
# then the question is about one real order rather than the theme as a whole.
_REF_NAMES = {
    "hebrew": ["נעמה", "לירן", "יונתן", "לירון"],
    "english": ["Noa", "Bill", "Joy", "Gaby"],
}
_REF_EXTRA = {
    "hebrew": {"AGE": "30", "YEARS": "30", "NAME2": "דני"},
    "english": {"AGE": "30", "YEARS": "30", "NAME2": "Dan"},
}

# Owner-facing names for the three surfaces a title renders on, each naming the
# themes.json key that pins it so the message points at what to edit.
_SURFACE_HE = {
    "front": 'הכותרת על הקלף (title_style."size")',
    "back": 'הכותרת על גב הקלף (title_style."back_size")',
    "board": 'הכותרת על הלוח (title_style."board_size")',
}


def _surface_label(surface):
    """Owner-facing name for a surface, including a paired ``back <n>``.

    Each of a paired template's backs is its own surface, so the message has to
    name WHICH back is mis-pinned — "the card back" would send the owner looking
    at eight of them.
    """
    if surface in _SURFACE_HE:
        return _SURFACE_HE[surface]
    number = surface.split()[-1]
    return f'הכותרת על גב הקלף {number} (backs."{number}"."size")'


def _lang(cfg):
    return "hebrew" if cfg.get("language") == "hebrew" else "english"


def sample_titles(cfg, names=None):
    """The sample titles to measure this theme with, as ``[(lines, name), ...]``.

    Built from the theme's OWN ``title_lines`` template, so what gets measured is
    the real title this design renders rather than a stand-in string.
    """
    lang = _lang(cfg)
    out = []
    for honoree in names or _REF_NAMES[lang]:
        extra = dict(_REF_EXTRA[lang])
        extra["NAME1"] = honoree
        lines = config.title_lines(cfg, honoree, extra)
        if lines:
            out.append((lines, honoree))
    return out


def _metrics(font_path):
    """``(font, ref)`` for a title font, or None when PIL cannot open it."""
    try:
        return rp._title_metrics(font_path)
    except (OSError, ValueError):
        return None


def _drawn(lines):
    """The lines ``title_block`` will actually draw (it drops blank ones first).

    Measuring the blanks would be measuring a line the renderer never paints —
    and on a title whose every line resolved to "" there is nothing to measure at
    all, which is a None here rather than a crash inside the font metrics.
    """
    return [ln for ln in (lines or []) if ln and ln.strip()]


def _paint_ratio(font_path, lines, outline_w, shadow, leading=None, arch=0.0,
                 bold=False, bold_w=None, one_block=False):
    """Painted title height per unit of font size, for these lines and font.

    This is the whole fit calculation in one number: ``title_block`` stacks the
    lines at the theme's own leading (its fixed default when the design's was
    never measured) and reserves headroom for the outline ring and the drop
    shadow, so the painted footprint of a title rendered at size S is exactly
    ``ratio * S``. Returns None when the font cannot be measured.

    The spacing has to come through here, not be assumed: a theme calibrated at
    a wide leading paints a block visibly taller than the default step predicts,
    and a health check that predicted a different footprint from the one the
    card prints would pass a pin that overflows (or flag one that does not).
    """
    got = _metrics(font_path)
    drawn = _drawn(lines)
    if not got or not drawn:
        return None
    f, ref = got
    pitch = rp.title_pitch(f, ref, drawn, leading,
                           rp.title_paint_pad(outline_w, arch, shadow, bold,
                                              bold_w),
                           one_block=one_block)
    stack = rp._title_ink_stack(f, ref, drawn, pitch)
    pad = 2 * (outline_w or 0) + (0.06 if shadow else 0.0)
    return stack / ref + pad


def _width_ratio(font_path, lines):
    """Painted width of the WIDEST line per unit of font size (None if unread)."""
    got = _metrics(font_path)
    drawn = _drawn(lines)
    if not got or not drawn:
        return None
    f, ref = got
    return max(f.getlength(ln) for ln in drawn) / ref


def _span(values):
    """``(min, min_name, max, max_name)`` over ``[(value, name), ...]``, or None."""
    vals = [(v, n) for v, n in values if v and v > 0]
    if not vals:
        return None
    lo, lo_n = min(vals)
    hi, hi_n = max(vals)
    return lo, lo_n, hi, hi_n


def _fit(surface, pinned, box, font_path, font_name, samples, named, ts,
         leading=None):
    """Judge ONE pinned size against ONE calibrated box. -> (problems, notes, m).

    A verdict is only reached where the WHOLE spread of reference names agrees —
    "too big even for the most compact name", "too small even for the tallest" —
    so it can never turn on which honoree happened to be measured. ``named`` is
    an optional extra sample for a caller-supplied honoree; it produces NOTES
    about that one order and never a verdict, because a pinned size does not
    shrink to fit and so a long enough name overflows the box on every shipped
    theme (measured: birthday-girls runs 52% past its box on an 8-letter name and
    is correct as shipped).

    Both axes are judged, against the same tolerance, because they fail in
    different ways. HEIGHT moves relatively little when the face changes — the
    0.78-per-line baseline spacing scales with the pinned SIZE, not the font, so
    on a 3-line title it is most of the stack (measured on 'trip comeback': four
    very different faces span 1.02-1.20 of the box). WIDTH is where a swapped
    face really shows (the same four span 1.03-1.39 against a shipped 0.98). The
    honest limit of both: a box-fit test catches a pin that is now plainly wrong,
    not every swap — that is what the git check below is for.
    """
    bw = box["x1"] - box["x0"]
    bh = box["y1"] - box["y0"]
    problems, notes = [], []
    if bh <= 0 or bw <= 0:
        return problems, notes, None
    hs = _span([(_paint_ratio(font_path, ln, ts.get("outline_w"),
                              ts.get("shadow"), leading,
                              ts.get("arch"), ts.get("bold"), ts.get("bold_w"),
                              bool(ts.get("one_block"))),
                 n) for ln, n in samples])
    ws = _span([(_width_ratio(font_path, ln), n) for ln, n in samples])
    if not hs:
        return problems, notes, None
    h_lo, _h_lo_n, h_hi, h_hi_n = hs
    fh_lo, fh_hi = h_lo * pinned / bh, h_hi * pinned / bh
    fw_lo = ws[0] * pinned / bw if ws else None
    fw_hi = ws[2] * pinned / bw if ws else None
    label = _surface_label(surface)
    over = []
    if fh_lo > _OVERFLOW:
        over.append(f"גבוה ב-{(fh_lo - 1) * 100:.0f}% לפחות מהתיבה "
                    f"({h_lo * pinned:.1f} מול {bh:.1f})")
    if fw_lo is not None and fw_lo > _OVERFLOW:
        over.append(f"רחב ב-{(fw_lo - 1) * 100:.0f}% לפחות מהתיבה "
                    f"({ws[0] * pinned:.1f} מול {bw:.1f})")
    if over:
        # Even the most forgiving sample overflows -> the pin is wrong for any name.
        problems.append(
            f"{label}: הגודל הנעול {pinned:g} גדול מדי עבור פונט הכותרת הנוכחי "
            f"({font_name}) — הכותרת יוצאת {' וגם '.join(over)} ותגלוש על העיצוב. "
            f"גודל שנכנס לגובה התיבה: כ-{bh / h_hi:.1f}. זה בדיוק מה שקורה "
            f"כשמחליפים את פונט הכותרת בלי לכייל מחדש את הגודל.")
    elif fh_hi < _TOO_SMALL:
        # Even the tallest sample barely marks the box -> the pin is far too small.
        problems.append(
            f"{label}: הגודל הנעול {pinned:g} קטן מדי עבור פונט הכותרת הנוכחי "
            f'({font_name}) — גם עם השם הארוך שנבדק ("{h_hi_n}") הכותרת נצבעת '
            f"בגובה {h_hi * pinned:.1f} בלבד בתוך תיבה בגובה {bh:.1f} "
            f"({fh_hi * 100:.0f}% מהתיבה). התיבה יכולה להכיל כ-{bh / h_hi:.1f}. "
            f"זה בדיוק מה שקורה כשמחליפים את פונט הכותרת בלי לכייל מחדש.")
    if named:
        nlines, nname = named
        nw = _width_ratio(font_path, nlines)
        nh = _paint_ratio(font_path, nlines, ts.get("outline_w"),
                          ts.get("shadow"), leading, ts.get("arch"),
                          ts.get("bold"), ts.get("bold_w"),
                          bool(ts.get("one_block")))
        if nw and nw * pinned > bw:
            notes.append(
                f'{label}: עם השם "{nname}" הכותרת רחבה מהתיבה '
                f"({nw * pinned:.1f} מול {bw:.1f}) וגולשת הצידה. גודל נעול לא "
                f"מתכווץ לשם ארוך — אפשר לקצר את הכותרת או להסיר את הגודל הנעול "
                f"ולתת לכותרת להתאים את עצמה.")
        if nh and nh * pinned > bh * _OVERFLOW:
            notes.append(
                f'{label}: עם השם "{nname}" הכותרת גבוהה מהתיבה '
                f"({nh * pinned:.1f} מול {bh:.1f}) וגולשת מעלה/מטה.")
    return problems, notes, {
        "pinned": pinned, "box_w": round(bw, 2), "box_h": round(bh, 2),
        "fills_box_h_min": round(fh_lo, 3), "fills_box_h_max": round(fh_hi, 3),
        "fills_box_w_min": round(fw_lo, 3) if fw_lo is not None else None,
        "fills_box_w_max": round(fw_hi, 3) if fw_hi is not None else None,
        "fitting_size": round(bh / h_hi, 2),
    }


# ---- git: has the title font moved under the calibration? ------------------

def _git(args, binary=False):
    """Run git in the repo; returns stdout, or None when git cannot answer.

    Every failure mode — no git binary, no repository, a path git has never
    seen — collapses to None, which callers turn into "could not determine"
    rather than into a verdict.
    """
    try:
        r = subprocess.run(["git", "-C", config.REPO] + args,
                           capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode != 0:
        return None
    return r.stdout if binary else r.stdout.decode("utf-8", "replace")


def _last_commit(rel):
    """``(unix_time, sha)`` of the last commit touching ``rel``, or None."""
    out = _git(["log", "-1", "--format=%ct %H", "--", rel])
    if not out or not out.strip():
        return None
    ct, sha = out.split()[:2]
    return int(ct), sha


def _dirty(rel):
    """Whether ``rel`` has uncommitted changes (None when git cannot say)."""
    out = _git(["status", "--porcelain", "--", rel])
    if out is None:
        return None
    return bool(out.strip())


def _is_ancestor(older, newer):
    """Whether commit ``older`` is reachable from ``newer``. None if git can't say."""
    try:
        r = subprocess.run(
            ["git", "-C", config.REPO, "merge-base", "--is-ancestor", older, newer],
            capture_output=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return None
    if r.returncode not in (0, 1):
        return None
    return r.returncode == 0


def _committed_after(earlier, later):
    """Was ``later`` committed AFTER ``earlier``? -> True / False / None.

    Deliberately answered from history ORDER, not from commit timestamps: two
    commits made in the same second carry the same ``%ct`` and a clock comparison
    would call the second one "not newer" — which is precisely how a font swap
    landing right after a calibration would slip through unseen.
    """
    if earlier == later:
        return False                     # the same commit changed both -> together
    if _is_ancestor(earlier, later):
        return True
    if _is_ancestor(later, earlier):
        return False
    return None                          # diverged history — no honest answer


def _font_drift(cfg, font_abs, font_name, lines, ts, pinned_any):
    """Did the title font change AFTER the calibration was last saved?

    No fingerprint of the font is stored anywhere (and storing one would mean
    writing to themes.json, which this module must not do), so the question is
    answered from history instead: themes.json's last commit is when the
    calibration was last written, and if the font file was committed LATER then
    every pinned size predates the typeface it is supposed to fit.

    Returns ``(problems, warnings, unknown, measurements)``. The comparison is
    by history ORDER, not by commit date (see ``_committed_after``), and
    deliberately one-directional — a font OLDER than the calibration proves the
    pin was set against it, which is the healthy case — so it cannot fire on a
    template whose font and calibration landed together. Verified: on all eight
    shipped themes the title font's last commit is the calibration's commit or an
    ancestor of it, so none of them is flagged.
    """
    problems, warnings, unknown = [], [], {}
    rel_font = os.path.relpath(font_abs, config.REPO)
    rel_themes = os.path.relpath(config.THEMES_JSON, config.REPO)
    font_c, themes_c = _last_commit(rel_font), _last_commit(rel_themes)
    if not font_c or not themes_c:
        unknown["font_drift"] = (
            "לא ניתן לבדוק אם פונט הכותרת הוחלף מאז הכיול — אין היסטוריית git "
            "לקובץ הפונט או ל-themes.json כאן.")
        return problems, warnings, unknown, {}
    if _dirty(rel_themes):
        # The calibration has unsaved edits, so it is by definition newer than
        # anything committed. Nothing to compare against; say so rather than
        # comparing a stale commit date and calling the result an answer.
        unknown["font_drift"] = (
            "ל-themes.json יש שינויים שלא נשמרו ב-git, ולכן אי אפשר להשוות את "
            "תאריך הכיול לתאריך הפונט.")
        return problems, warnings, unknown, {}
    font_dirty = _dirty(rel_font)
    newer = _committed_after(themes_c[1], font_c[1])
    m = {"font_last_commit": font_c[0], "calibration_last_commit": themes_c[0],
         "font_commit_is_newer": newer, "font_uncommitted": font_dirty}
    if newer is None:
        unknown["font_drift"] = (
            "היסטוריית ה-git של קובץ הפונט ושל themes.json מסועפת, ולכן אי אפשר "
            "לקבוע מה עודכן אחרי מה.")
        return problems, warnings, unknown, m
    if not newer and not font_dirty:
        return problems, warnings, unknown, m
    when = ("יש לו שינויים שלא נשמרו ב-git" if font_dirty and not newer
            else "הוא עודכן אחרי הכיול")
    head = (f"פונט הכותרת ({font_name}) — {when}, כך שהגדלים הנעולים כויילו מול "
            f"פונט אחר.")
    # Quantify it when we can actually read the OLD font: how much taller or
    # shorter the same title paints now tells the owner what to re-pin to.
    hint = ""
    if newer:
        old = _git(["show", f"{themes_c[1]}:{rel_font}"], binary=True)
        now = _paint_ratio(font_abs, lines, ts.get("outline_w"),
                           ts.get("shadow"), ts.get("leading"), ts.get("arch"),
                           ts.get("bold"), ts.get("bold_w"),
                           bool(ts.get("one_block")))
        if old and now:
            tmp = tempfile.NamedTemporaryFile(
                suffix=os.path.splitext(rel_font)[1], delete=False)
            try:
                tmp.write(old)
                tmp.close()
                before = _paint_ratio(tmp.name, lines, ts.get("outline_w"),
                                      ts.get("shadow"), ts.get("leading"),
                                      ts.get("arch"), ts.get("bold"),
                                      ts.get("bold_w"),
                                      bool(ts.get("one_block")))
            finally:
                os.unlink(tmp.name)
            if before and before > 0:
                m["paint_ratio_before"] = round(before, 4)
                m["paint_ratio_now"] = round(now, 4)
                m["suggested_scale"] = round(before / now, 3)
                pct = (now / before - 1) * 100
                verb = "גבוהה" if pct >= 0 else "נמוכה"
                hint = (f" עם הפונט החדש אותה כותרת נצבעת {abs(pct):.0f}% יותר "
                        f"{verb}; כדי לשמור על המראה הקודם צריך להכפיל כל גודל "
                        f"נעול ב-{before / now:.2f}.")
        elif not old:
            unknown["font_drift_before"] = (
                "הפונט הקודם לא נמצא בהיסטוריה, ולכן אי אפשר לכמת כמה השתנה "
                "הגודל.")
    if pinned_any:
        problems.append(head + hint)
    else:
        # Nothing is pinned, so the renderer auto-fits to the box and absorbs
        # the swap on its own. Worth knowing, not worth blocking on.
        warnings.append(head + " אין כאן גודל נעול, ולכן הכותרת מותאמת אוטומטית "
                        "לתיבה — כדאי בכל זאת להסתכל על התוצאה.")
    return problems, warnings, unknown, m


# ---- word slots ------------------------------------------------------------

def _word_health(theme_key, cfg, recipe):
    """Do the theme's own words still fit its word slots with the word font?

    ``_word_sizes`` gives every word on a card ONE size (the origin's look), and
    then shrinks any single word that would otherwise run past the card's left
    edge. That clamp is a safety net, not a design: once it starts firing the
    card stops being uniform. So the health question is how much of the theme's
    real wordlist it fires on — which moves the moment the word FONT changes,
    because a wider face needs more room for the same word.
    """
    problems, warnings, unknown, m = [], [], {}, {}
    font_path = config.resolve_word_font(theme_key)
    if not os.path.exists(font_path):
        return problems, warnings, unknown, m
    try:
        f, ref = rp._word_metrics(font_path)
    except (OSError, ValueError):
        unknown["word_font"] = (
            f"לא ניתן לקרוא את פונט המילים ({os.path.basename(font_path)}), ולכן "
            f"לא נבדק אם המילים נכנסות למשבצות.")
        return problems, warnings, unknown, m
    cards = [c for c in recipe.get("cards") or [] if c and c.get("words")]
    if not cards:
        return problems, warnings, unknown, m
    heights = [s["y1"] - s["y0"] for c in cards for s in c["words"]]
    uniform = cfg.get("word_size") or statistics.median(heights) * rp._WORD_SIZE_K
    # The theme's OWN wordlist, read the way the generator reads it — these are
    # the words that will actually be printed, so they are what the slots have to
    # hold. A generic sample would test a card nobody orders.
    try:
        words = [w for w in topup._read_wordlist(
            cfg.get("wordlist") or "generic-350.txt") if w][:_WORD_SAMPLE]
    except (OSError, ValueError):
        words = []
    if not words:
        unknown["word_slots"] = (
            "רשימת המילים של התבנית לא נמצאה, ולכן לא נבדק אם המילים נכנסות "
            "למשבצות.")
        return problems, warnings, unknown, m
    clamped, tightest = 0, None
    for i, word in enumerate(words):
        card = cards[i % len(cards)]
        slot = card["words"][i % len(card["words"])]
        cell = card.get("cell")
        if not cell:
            continue
        left = cell[0] + (cell[2] - cell[0]) * 0.02
        avail = rp._line_right_edge(slot["x1"], cell) - left
        line_w = rp._line_width_at(f, ref, (i % len(card["words"])) + 1, word)
        if line_w <= 0 or avail <= 0:
            continue
        cap = avail * ref / line_w
        headroom = cap / uniform
        tightest = headroom if tightest is None else min(tightest, headroom)
        if cap < uniform:
            clamped += 1
    if tightest is None:
        return problems, warnings, unknown, m
    share = clamped / len(words)
    m["word_size"] = round(uniform, 2)
    m["word_size_pinned"] = bool(cfg.get("word_size"))
    m["words_shrunk_share"] = round(share, 3)
    m["tightest_word_headroom"] = round(tightest, 3)
    if share or tightest < 1:
        msg = (f"מילים על הקלף: עם פונט המילים הנוכחי "
               f"({os.path.basename(font_path)}) בגודל {uniform:.1f}, "
               f"{share * 100:.0f}% מהמילים ברשימת התבנית לא נכנסות למשבצת "
               f"ומוקטנות אוטומטית — הכיתוב על הקלף לא יישאר בגודל אחיד.")
        if share >= _WORD_CLAMP_FAIL:
            problems.append(msg)
        elif share >= _WORD_CLAMP_WARN:
            warnings.append(msg)
    return problems, warnings, unknown, m


# ---- structure + assets ----------------------------------------------------

def _slot_problems(slot, label):
    """Missing/implausible keys on a board or back slot, as owner-facing text."""
    out = []
    missing = [k for k in _SLOT_REQUIRED if slot.get(k) in (None, "")]
    if missing:
        out.append(f"{label}: חסרים שדות ({', '.join(missing)}) — ההפקה תיכשל.")
        return out
    frac = slot["frac"]
    if not isinstance(frac, dict) or any(
            not isinstance(frac.get(k), (int, float)) for k in _FRAC_KEYS):
        out.append(f"{label}: ה-frac אינו תקין (צריך x0/y0/x1/y1 מספריים).")
        return out
    if frac["x0"] >= frac["x1"] or frac["y0"] >= frac["y1"]:
        out.append(f"{label}: ה-frac הפוך או ריק (x0 חייב להיות קטן מ-x1, "
                   f"y0 קטן מ-y1).")
    if any(not 0 <= frac[k] <= 1 for k in _FRAC_KEYS):
        out.append(f"{label}: ה-frac חורג מהתחום 0..1 ולכן הכותרת תיפול מחוץ "
                   f"לעיצוב.")
    return out


def _structure(cfg):
    """Whether a ``calibrated: true`` theme carries everything the renderer needs."""
    problems = []
    if not cfg.get("calibrated"):
        return problems
    ts = cfg.get("title_style")
    if not isinstance(ts, dict):
        problems.append("התבנית מסומנת כמכוילת (calibrated: true) אבל אין לה "
                        "title_style — ההפקה תיכשל.")
        return problems
    missing = [k for k in _TITLE_STYLE_REQUIRED if k not in ts]
    if missing:
        problems.append(
            f"התבנית מסומנת כמכוילת (calibrated: true) אבל חסרים ב-title_style "
            f"השדות: {', '.join(missing)} — ההפקה תיכשל באמצע ההזמנה.")
    if isinstance(cfg.get("board"), dict):
        problems += _slot_problems(cfg["board"], "הכותרת על הלוח (board)")
    if isinstance(cfg.get("back"), dict):
        problems += _slot_problems(cfg["back"], "הכותרת על גב הקלף (back)")
    # A paired template's backs are eight separate answers, so each is checked on
    # its own — a good back must never vouch for a malformed one beside it.
    backs = cfg.get("backs")
    if isinstance(backs, dict):
        for key in sorted(backs, key=_as_int):
            if isinstance(backs[key], dict):
                problems += _slot_problems(
                    backs[key], f"הכותרת על גב הקלף {key} (backs.{key})")
    return problems


def _as_int(key):
    """Sort a back key numerically — '10' comes after '9', not before it."""
    try:
        return int(key)
    except (TypeError, ValueError):
        return 0


def _assets(theme_key, cfg):
    """Files themes.json names that must actually exist. -> (problems, paths)."""
    problems, paths = [], {}
    tdir = config.theme_dir(theme_key)
    title_font = config.font_path(theme_key, cfg.get("title_font") or "")
    word_font = config.font_path(theme_key, cfg.get("word_font") or "")
    paths["title_font"] = title_font
    paths["word_font"] = word_font
    for kind, named, path in (("הכותרת", cfg.get("title_font"), title_font),
                              ("המילים", cfg.get("word_font"), word_font)):
        if not named or not os.path.exists(path):
            problems.append(
                f"קובץ פונט {kind} חסר: {named or '(לא הוגדר)'} — ההפקה תיכשל. "
                f"הנתיב שנבדק: {path}")
    recipe_path = config.recipe_path(cfg.get("recipe"))
    paths["recipe"] = recipe_path
    if not os.path.exists(recipe_path):
        problems.append(f"קובץ המתכון (recipe) של התבנית חסר: {recipe_path} — "
                        f"ההפקה תיכשל.")
    # WHICH artwork must exist depends on the template's LAYOUT. A v1 sheet ships
    # clean/fronts.svg + clean/backs.svg; a single-card deck ships numbered cards
    # (clean/1.svg = the back, clean/2..9.svg = the fronts) and has no sheet at
    # all. Checking for fronts.svg on a card template reported a missing file for
    # artwork that is not supposed to exist — a false alarm on EVERY migrated
    # theme, which is exactly the noise this checker exists to avoid.
    if config.is_single_card(cfg):
        required = [(f"{n}.svg", config.card_path(theme_key, n))
                    for n in config.fronts(cfg)]
        # Every DISTINCT back the deck prints. A paired template ships eight and
        # no shared 1.svg at all, so asking for `back_path` here reported a
        # missing file for artwork it was never supposed to have.
        required += [(f"{n}.svg", config.card_path(theme_key, n))
                     for n in dict.fromkeys(config.back_indices(cfg))]
        required.append(("board.svg", config.clean_path(theme_key, "board")))
        for label, p in required:
            paths[f"clean_{label}"] = p
            if not os.path.exists(p):
                problems.append(f"קובץ הרקע הנקי חסר: clean/{label} בתיקיית "
                                f"{config.display_path(tdir)} — ההפקה תיכשל.")
        return problems, paths
    for which, needed in (("fronts", True), ("board", True),
                          ("backs", bool(cfg.get("back")))):
        p = config.clean_path(theme_key, which)
        paths[f"clean_{which}"] = p
        if needed and not os.path.exists(p):
            problems.append(f"קובץ הרקע הנקי חסר: clean/{which}.svg בתיקיית "
                            f"{config.display_path(tdir)} — ההפקה תיכשל.")
    return problems, paths


# ---- boxes -----------------------------------------------------------------

def _front_boxes(recipe, ts):
    """Every front-card title box, exactly as ``build_page`` computes them."""
    boxes = []
    for card in recipe.get("cards") or []:
        if not card or not card.get("title"):
            continue
        tb = card["title"]
        box = {"x0": min(b["x0"] for b in tb), "y0": min(b["y0"] for b in tb),
               "x1": max(b["x1"] for b in tb), "y1": max(b["y1"] for b in tb)}
        off, cell = ts.get("offset"), card.get("cell")
        if off and cell:
            dx = off[0] * (cell[2] - cell[0])
            dy = off[1] * (cell[3] - cell[1])
            box = {"x0": box["x0"] + dx, "x1": box["x1"] + dx,
                   "y0": box["y0"] + dy, "y1": box["y1"] + dy}
        boxes.append(box)
    return boxes


def _front_title_coverage(cfg, recipe):
    """Fronts that carry no title of their own, as ``(warnings, measurements)``.

    A v2 deck's title is the ONE thing that moves per front, so every front needs
    its own box. When one is missing, ``config.recipe_front_title`` substitutes
    the median of the fronts that have one and says nothing — a fallback that is
    right only while the missing front's title sits roughly where its siblings'
    do. On מרקאנה it does not: front 9 carries ``Ben's B-day`` at the FOOT of the
    card while fronts 2-8 carry it at the top, so the substitute put the honoree's
    name on empty artwork, and the owner found it by eye because no check looked.

    Both places a title can be recorded are counted — ``card_slots.titles`` in
    themes.json (what the admin form saves and the renderer prefers) and
    ``card.title`` in the recipe (what detection wrote) — because a front covered
    by either one is not the gap this is looking for.

    A WARNING, never a problem: the deck still renders, and on a design whose
    title genuinely does not move the substitute is correct. It is exactly the
    "worth a look" this report exists to raise.
    """
    if not isinstance(recipe, dict):
        return [], {}
    card = recipe.get("card") if isinstance(recipe.get("card"), dict) else {}
    titles = card.get("title")
    if isinstance(titles, list) and titles:
        # A plain LIST means "the same slot on every front" — a deck whose title
        # does not move. Nothing is missing by construction.
        return [], {}
    recorded = set()
    if isinstance(titles, dict):
        recorded |= {str(k) for k, v in titles.items() if v}
    saved = (cfg.get("card_slots") or {}).get("titles")
    if isinstance(saved, dict):
        recorded |= {str(k) for k, v in saved.items() if v}
    if not recorded:
        # Nothing recorded anywhere is a different fault (an uncalibrated or
        # sheet-format template), already reported by the structure/asset checks.
        return [], {}
    wanted = [str(n) for n in config.fronts(cfg)]
    missing = [n for n in wanted if n not in recorded]
    measurements = {"fronts": len(wanted), "with_own_title": len(wanted) - len(missing)}
    if not missing:
        return [], measurements
    measurements["missing"] = missing
    return ([
        "לקלפים הבאים אין מיקום כותרת משלהם: "
        + ", ".join(f"{n}.svg" for n in missing)
        + f" (מתוך {len(wanted)}). הכותרת שלהם תודפס לפי המיקום החציוני של שאר "
        "הקלפים — נכון רק אם הכותרת לא זזה בין הקלפים. בדקו את הקלפים האלה "
        "בתצוגה המקדימה; אם הכותרת שלהם במקום אחר, הריצו זיהוי מחדש ובדקו את "
        "ההודעות שלו."
    ], measurements)


def _back_boxes(recipe, frac):
    """Every card-back title box, exactly as ``build.render_backs`` computes them."""
    boxes = []
    for card in recipe.get("cards") or []:
        if not card or not card.get("cell"):
            continue
        cx0, cy0, cx1, cy1 = card["cell"]
        cw, ch = cx1 - cx0, cy1 - cy0
        boxes.append({"x0": cx0 + frac["x0"] * cw, "x1": cx0 + frac["x1"] * cw,
                      "y0": cy0 + frac["y0"] * ch, "y1": cy0 + frac["y1"] * ch})
    return boxes


def _board_box(theme_key, frac):
    """The board title box, or None when the board SVG cannot be measured."""
    p = config.clean_path(theme_key, "board")
    if not os.path.exists(p):
        return None
    try:
        _w, _h, vb = build.svg_dims(p)
    except (OSError, AttributeError, ValueError):
        return None
    return {k: (frac[k] * vb[2] if "x" in k else frac[k] * vb[3]) for k in _FRAC_KEYS}


def _pinned_surfaces(theme_key, cfg, ts, recipe):
    """``[(surface, pinned_size, boxes)]`` plus what could not be measured.

    Each surface is judged against ITS OWN box, because they are different boxes
    pinned by different keys — a bad ``back_size`` must not be able to hide
    behind a fine ``size``. ``back_size`` falls back to ``size`` exactly as
    ``build.render_backs`` does, so what is checked is what will be rendered.

    Each surface carries its own LEADING for the same reason: the painted height
    a pinned size produces depends on how far apart the lines are stacked, and
    the surfaces are separately spaced text boxes in the design. Resolved
    through the same fallbacks the renderer uses, so the block measured here is
    the block the card prints.
    """
    surfaces, unknown = [], {}
    if recipe:
        surfaces.append(("front", ts.get("size"), _front_boxes(recipe, ts),
                         ts.get("leading")))
        if isinstance(cfg.get("back"), dict) and cfg["back"].get("frac"):
            surfaces.append(("back", ts.get("back_size") or ts.get("size"),
                             _back_boxes(recipe, cfg["back"]["frac"]),
                             rp.back_leading(ts, cfg["back"])))
        # Each of a paired template's backs is its own surface with its own box
        # and its own pin, so each is judged separately — exactly the reason the
        # back is not judged against the front's box above.
        backs = cfg.get("backs")
        if isinstance(backs, dict):
            for key in sorted(backs, key=_as_int):
                slot = backs[key]
                if not isinstance(slot, dict) or not slot.get("frac"):
                    continue
                surfaces.append((
                    f"back {key}",
                    slot.get("size") or ts.get("back_size") or ts.get("size"),
                    _back_boxes(recipe, slot["frac"]),
                    rp.back_leading(ts, slot)))
    if isinstance(cfg.get("board"), dict) and cfg["board"].get("frac"):
        box = _board_box(theme_key, cfg["board"]["frac"])
        if ts.get("board_size") and box is None:
            unknown["board_fit"] = (
                "לא ניתן למדוד את תיבת הכותרת על הלוח (חסר clean/board.svg או "
                "שאין בו viewBox), ולכן board_size לא נבדק.")
        surfaces.append(("board", ts.get("board_size"), [box] if box else [],
                         rp.board_leading(ts)))
    return surfaces, unknown


def _title_fit(theme_key, cfg, ts, recipe, paths, font_name, samples, named):
    """Judge every pinned title size. -> (problems, notes, unknown, measurements)."""
    problems, notes, fits = [], [], {}
    surfaces, unknown = _pinned_surfaces(theme_key, cfg, ts, recipe)
    for surface, pinned, boxes, leading in surfaces:
        if not pinned or not boxes:
            continue
        # A pinned size has to survive EVERY box on the sheet (the eight cards of
        # a backs sheet are not identical), so the worst one is what decides.
        worst, worst_m, keep = None, None, ([], [])
        for box in boxes:
            probs, note, m = _fit(surface, pinned, box, paths["title_font"],
                                  font_name, samples, named, ts, leading)
            if m is None:
                continue
            score = max(m["fills_box_h_max"] - 1, 1 - m["fills_box_h_min"],
                        (m["fills_box_w_max"] or 0) - 1)
            if worst is None or score > worst:
                worst, worst_m, keep = score, m, (probs, note)
        if worst_m is None:
            continue
        problems += keep[0]
        notes += keep[1]
        fits[surface] = worst_m
    return problems, notes, unknown, fits


# ---- the check itself ------------------------------------------------------

def check(theme_key, name=None):
    """Report on one theme's calibration. Never writes anything.

    Returns ``{theme, ok, problems, warnings, notes, unknown, measurements}``:
    ``problems`` are things that will produce a wrong or failed order and
    ``warnings`` things worth a look; ``unknown`` records, per check, what could
    NOT be determined here — an empty ``problems`` list with a populated
    ``unknown`` means "nothing found, but I could not see everything".
    """
    cfg = config.theme(theme_key)
    report = {"theme": theme_key, "ok": True, "problems": [], "warnings": [],
              "notes": [], "unknown": {}, "measurements": {}}

    report["problems"] += _structure(cfg)
    asset_problems, paths = _assets(theme_key, cfg)
    report["problems"] += asset_problems

    ts = cfg.get("title_style")
    recipe = None
    if os.path.exists(paths["recipe"]):
        try:
            with open(paths["recipe"], encoding="utf-8") as f:
                recipe = json.load(f)
        except ValueError:
            report["problems"].append(
                f"קובץ המתכון (recipe) לא ניתן לקריאה: {paths['recipe']}")

    if isinstance(ts, dict) and os.path.exists(paths["title_font"]):
        # Verdicts always come from the built-in spread; a caller-supplied name
        # is measured alongside it and only ever adds notes about that order.
        samples = sample_titles(cfg)
        named = (sample_titles(cfg, [name]) or [None])[0] if name else None
        report["measurements"]["title_samples"] = [
            {"name": n, "lines": ln} for ln, n in samples]
        if named:
            report["measurements"]["named_title"] = {"name": named[1],
                                                     "lines": named[0]}
        font_name = os.path.basename(paths["title_font"])
        if not _metrics(paths["title_font"]):
            report["unknown"]["title_font"] = (
                f"לא ניתן לקרוא את קובץ פונט הכותרת ({font_name}) — הגדלים "
                f"הנעולים לא נבדקו.")
        elif not samples:
            report["unknown"]["title_fit"] = (
                "לא ניתן להרכיב כותרת לדוגמה מהתבנית, ולכן הגדלים הנעולים לא "
                "נבדקו.")
        else:
            fp, fn_, fu, fits = _title_fit(theme_key, cfg, ts, recipe, paths,
                                           font_name, samples, named)
            report["problems"] += fp
            report["notes"] += fn_
            report["unknown"].update(fu)
            if fits:
                report["measurements"]["title_fit"] = fits
        # Font drift is asked whether or not the fit looked fine: a swap that
        # happens to still fit is still a swap the owner did not verify.
        pinned_any = any(ts.get(k) for k in ("size", "board_size", "back_size"))
        dp, dw, du, dm = _font_drift(cfg, paths["title_font"], font_name,
                                     samples[0][0] if samples else ["Aa"], ts,
                                     pinned_any)
        report["problems"] += dp
        report["warnings"] += dw
        report["unknown"].update(du)
        if dm:
            report["measurements"]["title_font"] = dm

    if recipe:
        cw, cm = _front_title_coverage(cfg, recipe)
        report["warnings"] += cw
        if cm:
            report["measurements"]["front_titles"] = cm

        wp, ww, wu, wm = _word_health(theme_key, cfg, recipe)
        report["problems"] += wp
        report["warnings"] += ww
        report["unknown"].update(wu)
        if wm:
            report["measurements"]["words"] = wm

    report["ok"] = not report["problems"]
    return report


def check_all(name=None):
    """``{theme_key: report}`` for every theme in themes.json."""
    return {k: check(k, name=name) for k in config.load_themes()}


# ---- CLI -------------------------------------------------------------------

def _render(report):
    """The human-readable form of one report."""
    out = [f"=== {report['theme']} ==="]
    if report["ok"] and not report["warnings"]:
        out.append("  תקין — הכיול מתאים לפונטים ולעיצוב הנוכחיים.")
    for p in report["problems"]:
        out.append("  בעיה:   " + p)
    for w in report["warnings"]:
        out.append("  אזהרה:  " + w)
    for n in report["notes"]:
        out.append("  לידיעה: " + n)
    for v in report["unknown"].values():
        out.append("  לא נבדק: " + v)
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(
        description="Check a template's stored calibration against its current "
                    "fonts and artwork (read-only)")
    ap.add_argument("theme", help="a key in generator/themes.json, or 'all'")
    ap.add_argument("--out", default=None, metavar="FILE",
                    help="write the findings here as JSON (default: a readable "
                         "report on stdout)")
    ap.add_argument("--name", default=None, metavar="NAME",
                    help="check with this honoree name instead of the built-in "
                         "reference one")
    args = ap.parse_args()

    if args.theme == "all" and "all" not in config.load_themes():
        reports = check_all(name=args.name)
    else:
        reports = {args.theme: check(args.theme, name=args.name)}

    bad = [k for k, r in reports.items() if not r["ok"]]
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(json.dumps(reports, ensure_ascii=False, indent=1))
        print(f"checked {len(reports)} theme(s): "
              f"{len(reports) - len(bad)} ok, {len(bad)} with problems "
              f"-> {args.out}")
    else:
        print("\n\n".join(_render(r) for r in reports.values()))
        if bad:
            print(f"\n{len(bad)} theme(s) need attention: {', '.join(bad)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
