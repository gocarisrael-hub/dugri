#!/usr/bin/env python3
"""What each choice of clear air around an icon costs, rendered and counted.

    python3 scripts/icon-clearance-proof.py [outdir] [mm ...]

``_ICON_CLEAR_MM`` (render_page) is how much empty paper the fit leaves between a
word's ink and an icon's edge. It is NOT carrying the keep-out guarantee — the
fit measures real ink on both axes and clears the icon on the arithmetic alone
(see CLEAR AIR AROUND AN ICON in render_page) — it is there for the rasterizer's
antialiased rim and, mostly, because a word that stops a hair short of a
champagne glass still LOOKS printed on it.

The rim's part is measured: the keep-out test counts 9 stray pixels at 0 mm, 4 at
0.25 and none at 0.5, so 0.5 is the default. Everything above that is a judgement
about a printed card, and it is the owner's to make — the same way she picked
``_BOTTOM_RESERVE_MM`` off a rendered 0/4/8/12 proof.

This is that proof. For each candidate it prints the type size every deck sets
with worst-case entries, and renders the sheets so the air can be seen.

Not part of the render path: a tool, run by hand.
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GEN = os.path.join(HERE, "generator")

# The same four the keep-out test uses: a phrase that can wrap, one that must
# wrap twice, a single word with nowhere to break, and a Latin one.
WORST = ["ההופעה של הכלה במסיבת הרווקות",
         "אלכסנדרה מרגריטה בת חמישים ואחת",
         "אינטרנציונליזציה",
         "ALEXANDRINA POPPYLDE THE THIRD"]

# Run in a SUBPROCESS per candidate: the clearance is read once at import and the
# obstacle scan memoises per theme, so one process cannot answer for two values.
_WORKER = r"""
import json, os, sys
sys.path.insert(0, %(gen)r)
import chrome, config, render_page as rp
themes, words, out_dir = %(themes)r, %(words)r, %(out)r
sizes = {}
for t in themes:
    cfg = config.theme(t)
    clean = os.path.join(config.theme_dir(t), "clean", "fronts.svg")
    rec = config.recipe_or_empty(cfg)
    svg = rp.build_page(t, clean, [list(words) for _ in rec["cards"]], [])
    if out_dir:
        p = os.path.join(out_dir, cfg["slug"] + ".svg")
        open(p, "w", encoding="utf-8").write(svg)
        w, h = rp.dims(clean)
        chrome.screenshot(p, p[:-4] + ".png", w, h, scale=2,
                          what="the clearance proof for " + t)
    f, ref = rp._word_metrics(config.resolve_word_font(t, None))
    bw = config.word_bold_w(cfg, rp._WORD_BOLD_W)
    row = []
    for ci, card in enumerate(rec["cards"]):
        if not card or not card.get("cell") or not card.get("words"):
            row.append(None)
            continue
        cell = card["cell"]
        icons = rp.card_obstacles(svg_text=open(clean, encoding="utf-8").read(),
                                  cell=cell).rects
        sb = cell[3] - (cell[3] - cell[1]) * rp._CARD_SAFE
        room = rp.room_bottom(t, ci + 1, open(clean, encoding="utf-8").read(),
                              cell, sb) if icons else None
        lay = rp._word_layouts(card["words"], words, f, ref, cell=cell,
                               word_size=cfg.get("word_size"), bold_w=bw,
                               obstacles=icons, room_bottom=room)
        row.append(next((l.size for l in lay if l), None))
    sizes[t] = row
print("<<<" + json.dumps(sizes) + ">>>")
"""


def run(mm, themes, out_dir):
    src = _WORKER % {"gen": GEN, "themes": themes, "words": WORST,
                     "out": out_dir or ""}
    env = dict(os.environ, DUGRI_ICON_CLEAR_MM=str(mm))
    res = subprocess.run([sys.executable, "-c", src], capture_output=True,
                         text=True, env=env, cwd=HERE)
    if res.returncode:
        raise SystemExit(res.stderr or res.stdout)
    body = res.stdout.split("<<<")[-1].split(">>>")[0]
    return json.loads(body)


def main():
    args = sys.argv[1:]
    out_dir = args[0] if args else os.path.join(HERE, "icon-clearance-proof")
    cands = [float(v) for v in args[1:]] or [0.0, 0.25, 0.5, 1.0]
    themes = [t for t, e in sorted(json.load(open(
        os.path.join(GEN, "themes.json"), encoding="utf-8")).items())
        if not (e.get("card_slots") or {}).get("words")]

    table = {}
    for mm in cands:
        d = os.path.join(out_dir, f"clear-{mm}mm")
        os.makedirs(d, exist_ok=True)
        table[mm] = run(mm, themes, d)

    print("\nType size the WORST card of each deck sets, per clearance:\n")
    print(f"{'deck':28s}" + "".join(f"{mm:>7}mm" for mm in cands))
    for t in themes:
        row = f"{t:28s}"
        for mm in cands:
            got = [v for v in table[mm][t] if v]
            row += f"{(min(got) if got else 0):9.2f}"
        print(row)
    first = cands[0]
    print(f"\nCost against {first}mm, worst card of each deck:")
    for t in themes:
        b = [v for v in table[first][t] if v]
        if not b:
            continue
        print(f"  {t:28s} " + "   ".join(
            f"{mm}mm: {(min([v for v in table[mm][t] if v]) / min(b) - 1):+.2%}"
            for mm in cands[1:]))
    print(f"\nsheets rendered under {out_dir}")


if __name__ == "__main__":
    main()
