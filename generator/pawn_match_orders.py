#!/usr/bin/env python3
"""Does the pawn a buyer sees on the site match the pawn that prints? Order by order.

For every order in a directory of orders it renders each pawn card twice:

  * PRINT — what the generator hands the press. On a single-card template that is
    the real deck PDF (build.build_deck), rasterised; on a sheet template, which
    prints no deck of its own, it is the pawn card the deck composes
    (render_page.photo_card_svg), rendered by the same Chrome.
  * PAGE — what the collection page and the wizard draw: the live route's base
    card (preview.py --pawn-card --no-photos, dealt with build.card_photo_plan)
    with her photos painted over it by site/js/pawn-print.js — the page's own
    module, run in a real browser — plus each photo's editor tile.

…then crops every photo slot out of both at the same pixel size and reports how
many pixels differ, inside the cut-line (the sticker) and across the whole slot.

An order is a directory holding ``order.json``::

    {"theme": "grapefruit", "title": "...", "players": 8,
     "photos": [{"original": "a.jpg", "cutout": "a-cut.png" | null,
                 "view": {"zoom": 1.2, "dx": 0.1, "dy": 0, "bg": false} | null}]}

and the files it names. That is what an order carries on the server too
(pawn_images / pawn_cutouts / pawn_view), so a dump of real orders runs as is.

    python3 generator/pawn_match_orders.py ORDERS_DIR --out OUT_DIR

Needs Chrome, pdftoppm (for the PDF raster) and Playwright from node_modules.
"""
import argparse
import base64
import csv
import json
import math
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
sys.path.insert(0, HERE)

from PIL import Image, ImageChops  # noqa: E402

import build  # noqa: E402
import config  # noqa: E402
import preview  # noqa: E402
import render_page as rp  # noqa: E402

# Pixels per CSS pixel of the card — the scale the generator's own single-card
# render uses. The card is ~224 x 312 CSS px, so a pawn slot is ~132 px across:
# a 1% placement error is more than a pixel, and the white edge is ~3 px wide.
SCALE = 2
# A slot counts as matching when fewer than this share of its sticker pixels
# differ by more than DIFF_AT (out of 255, max channel). Anti-aliasing and
# resampling alone differ by a few levels, so the threshold looks past those.
DIFF_AT = 40
PASS_SHARE = 0.01


def _b64url(path, mime):
    with open(path, "rb") as f:
        return "data:%s;base64,%s" % (mime, base64.b64encode(f.read()).decode("ascii"))


def _mime(path):
    ext = os.path.splitext(path)[1].lower()
    return {".png": "image/png", ".webp": "image/webp"}.get(ext, "image/jpeg")


def load_order(path):
    with open(os.path.join(path, "order.json"), encoding="utf-8") as f:
        o = json.load(f)
    players = int(o.get("players") or 4)
    entries = []
    for p in o.get("photos") or []:
        view = p.get("view") or None
        cut = p.get("cutout")
        # pawnPhotoEntries: her cutout, unless she kept the background or there is none.
        use_cut = bool(cut) and not (view and view.get("bg"))
        file = os.path.join(path, cut if use_cut else p["original"])
        frame = None
        if view:
            z, dx, dy = float(view.get("zoom", 1)), float(view.get("dx", 0)), float(view.get("dy", 0))
            if (z, dx, dy) != (1.0, 0.0, 0.0):
                frame = (z, dx, dy)
        entries.append({"file": file, "cutout": use_cut, "view": frame})
    # …and only as many as the deck has slots.
    return {"theme": o["theme"], "title": o.get("title") or "", "players": players,
            "cards": max(1, players // 4), "entries": entries[:players]}


def title_lines(order):
    cfg = config.theme(order["theme"])
    config.ensure_calibrated(cfg)
    return config.title_lines(cfg, order["title"], {}, custom_title=order["title"] or None)


# --- PRINT ---------------------------------------------------------------------

def print_cards(order, lines, work):
    """One PNG per pawn card, as printed."""
    theme = order["theme"]
    e = order["entries"]
    photos = [x["file"] for x in e]
    views = [x["view"] for x in e]
    cuts = [x["cutout"] for x in e]
    w, h = rp.dims(config.photo_card_path(theme))
    out = []
    if config.is_single_card(config.theme(theme)):
        # The real deck: photo cards first, one word card so the deck is a deck.
        csvp = os.path.join(work, "deck.csv")
        with open(csvp, "w", encoding="utf-8", newline="") as f:
            wr = csv.writer(f)
            wr.writerow(["kind", "front", "w1", "w2", "w3", "w4"])
            for _ in range(order["cards"]):
                wr.writerow(["photo", "", "", "", "", ""])
            wr.writerow(["word", 0, "אחת", "שתיים", "שלוש", "ארבע"])
        pdf = os.path.join(work, "deck.pdf")
        build.build_deck(theme, csvp, order["title"], pdf, custom_title=order["title"] or None,
                         photos=photos, photo_views=views, photo_cutouts=cuts,
                         workdir=os.path.join(work, "deck"), progress=False)
        for card in range(order["cards"]):
            page = 2 * card + 2  # [back, photo card] per card
            stem = os.path.join(work, "print-%d" % card)
            subprocess.run(["pdftoppm", "-f", str(page), "-l", str(page), "-png", "-singlefile",
                            "-scale-to-x", str(w * SCALE), "-scale-to-y", str(h * SCALE),
                            pdf, stem], check=True)
            out.append(stem + ".png")
        return out
    # A sheet template: the pawn card the deck composes (photo_card_svg on the
    # front's paper), through the same single-card render the live preview uses.
    paths = build.resolve_photos(theme, photos, workdir=os.path.join(work, "sq"), views=views,
                                 cutouts=cuts, slots=build.PHOTO_SLOTS * order["cards"])
    for card in range(order["cards"]):
        group = paths[card * 4:(card + 1) * 4]
        png = os.path.join(work, "print-%d.png" % card)
        rp.render_single_card(theme, config.photo_card_path(theme), [], lines, png,
                              kind="photo", photos=group)
        out.append(png)
    return out


# --- PAGE ----------------------------------------------------------------------

def base_card(order, card, lines, work):
    """The live route's base card for one card, plus its sticker spec."""
    theme = order["theme"]
    plan = build.card_photo_plan(theme, 4)  # every disc bare, as the live route asks
    png = os.path.join(work, "base-%d.png" % card)
    rp.render_single_card(theme, config.photo_card_path(theme), [], lines, png,
                          kind="photo", photos=plan)
    preview._downscale(png, preview.CARD_MAX_W)
    return png, preview.sticker_spec(theme, png)


PAGE_JS = r"""
const SPEC = __SPEC__, BASE = __BASE__, PHOTOS = __PHOTOS__, DEAL = __DEAL__;
document.getElementById('cardimg').src = BASE;
const stickers = [];
for (const p of PHOTOS) {
  const photo = await preparePhoto(p.url, { cutout: p.cutout });
  const view = p.view && { zoom: p.view[0], dx: p.view[1], dy: p.view[2] };
  stickers.push(photo && { photo, crop: viewCrop(photo.crop, view) });
}
const fallbacks = fallbackDeal(SPEC.fallbacks.length, DEAL.filled, DEAL.cards, DEAL.card).map(
  (i) => (i == null ? null : SPEC.fallbacks[i]));
paintCard(document.getElementById('live'), {
  spec: SPEC, slots: SPEC.slots, idPrefix: 'card', stickers, fallbacks,
});
stickers.forEach((s, i) => {
  paintTile(document.getElementById('tile' + i), {
    spec: SPEC, base: BASE, slot: slotRect(SPEC.slots[i], SPEC.viewBox), id: 'pawn-pad-' + i,
    photo: s && s.photo, crop: s && s.crop,
  });
});
await new Promise((r) => document.getElementById('cardimg').decode().then(r, r));
window.__ready = true;
"""


def page_html(order, card, base_png, spec, w, h):
    per = order["entries"][card * 4:(card + 1) * 4]
    photos = [{"url": _b64url(x["file"], _mime(x["file"])), "cutout": x["cutout"],
               "view": list(x["view"]) if x["view"] else None} for x in per]
    module = open(os.path.join(REPO, "site", "js", "pawn-print.js"), encoding="utf-8").read()
    js = (PAGE_JS.replace("__SPEC__", json.dumps(spec))
          .replace("__BASE__", json.dumps(_b64url(base_png, "image/png")))
          .replace("__PHOTOS__", json.dumps(photos))
          .replace("__DEAL__", json.dumps({"filled": len(order["entries"]),
                                           "cards": order["cards"], "card": card})))
    # The tiles sit below the card, each a slot-sized square (plus the tile's own
    # margin) so a crop of its middle is directly comparable to the card's slot.
    slot_px = spec["slots"][0]["w"] * w
    tile_px = slot_px * (spec["slots"][0]["w"] * spec["viewBox"][2] + 6) / (
        spec["slots"][0]["w"] * spec["viewBox"][2])
    tiles = "".join(
        '<svg id="tile%d" class="tile" style="left:%.3fpx"></svg>' % (i, i * (tile_px + 10))
        for i in range(len(per)))
    return f"""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#808080}}
#card{{position:absolute;left:0;top:0;width:{w}px;height:{h}px}}
#card img,#live{{position:absolute;left:0;top:0;width:100%;height:100%;display:block}}
.tile{{position:absolute;top:{h + 10}px;width:{tile_px:.3f}px;height:{tile_px:.3f}px;display:block}}
</style></head><body>
<div id="card"><img id="cardimg"><svg id="live"></svg></div>{tiles}
<script type="module">
{module}
{js}
</script></body></html>""", tile_px


SHOOT_JS = r"""
import { chromium } from '__PW__';
const jobs = JSON.parse(process.argv[2]);
const browser = await chromium.launch();
for (const j of jobs) {
  const page = await browser.newPage({ viewport: { width: j.w, height: j.h }, deviceScaleFactor: j.scale });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  await page.goto('file://' + j.html);
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 60000 }).catch(() => {});
  if (errs.length) console.error(j.html, errs.join(' | '));
  await page.screenshot({ path: j.png, clip: { x: 0, y: 0, width: j.w, height: j.h } });
  await page.close();
}
await browser.close();
"""


def shoot(jobs, work):
    js = os.path.join(work, "shoot.mjs")
    pw = os.path.join(REPO, "node_modules", "playwright", "index.mjs")
    with open(js, "w", encoding="utf-8") as f:
        f.write(SHOOT_JS.replace("__PW__", pw))
    subprocess.run(["node", js, json.dumps(jobs)], check=True)


# --- COMPARE -------------------------------------------------------------------

def slot_diff(a, b, inner_share):
    """Share of pixels differing by > DIFF_AT, inside the circle and in the square."""
    d = ImageChops.difference(a.convert("RGB"), b.convert("RGB"))
    px = d.load()
    n = a.width
    c = (n - 1) / 2.0
    r_in = n / 2.0 * inner_share
    tot = bad = tin = bin_ = 0
    for y in range(n):
        for x in range(n):
            v = max(px[x, y])
            tot += 1
            if v > DIFF_AT:
                bad += 1
            if math.hypot(x - c, y - c) <= r_in:
                tin += 1
                if v > DIFF_AT:
                    bin_ += 1
    return bin_ / tin, bad / tot, d


FAILED = []


def run(orders_dir, out):
    """Every order, each one on its own: a failure is recorded and the run goes on,
    and an order already measured (its rows.json exists) is not measured again."""
    os.makedirs(out, exist_ok=True)
    rows = []
    names = sorted(n for n in os.listdir(orders_dir)
                   if os.path.isfile(os.path.join(orders_dir, n, "order.json")))
    for name in names:
        done = os.path.join(out, name, "rows.json")
        if os.path.isfile(done):
            with open(done, encoding="utf-8") as f:
                rows.extend(json.load(f))
            continue
        try:
            got = run_order(orders_dir, out, name)
        except Exception as exc:  # noqa: BLE001 - one order must not end the run
            FAILED.append((name, "%s: %s" % (type(exc).__name__, str(exc)[:200])))
            print("%s FAILED: %s" % FAILED[-1], flush=True)
            continue
        with open(done, "w", encoding="utf-8") as f:
            json.dump(got, f)
        rows.extend(got)
    with open(os.path.join(out, "results.json"), "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=1)
    return rows


def run_order(orders_dir, out, name):
    """Render and compare one order; returns its rows."""
    rows = []
    order = load_order(os.path.join(orders_dir, name))
    work = os.path.join(out, name)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    lines = title_lines(order)
    w, h = rp.dims(config.photo_card_path(order["theme"]))
    prints = print_cards(order, lines, work)
    jobs, pages = [], []
    for card in range(order["cards"]):
        n_here = len(order["entries"][card * 4:(card + 1) * 4])
        base, spec = base_card(order, card, lines, work)
        html, tile_px = page_html(order, card, base, spec, w, h)
        hp = os.path.join(work, "page-%d.html" % card)
        with open(hp, "w", encoding="utf-8") as f:
            f.write(html)
        png = os.path.join(work, "page-%d.png" % card)
        # Playwright takes whole CSS pixels for a viewport.
        jobs.append({"html": hp, "png": png, "w": math.ceil(w + 4 * (tile_px + 10)),
                     "h": math.ceil(h + 20 + tile_px), "scale": SCALE})
        pages.append((card, png, spec, tile_px, n_here))
    shoot(jobs, work)
    for (card, png, spec, tile_px, n_here), printed in zip(pages, prints):
        P = Image.open(printed).convert("RGB")
        Q = Image.open(png).convert("RGB")
        # Every slot of the card: her photos, and the shipped pawns the deck
        # deals into the rest.
        for i in range(4):
            s = spec["slots"][i]
            box = tuple(round(v * SCALE) for v in (s["x"] * w, s["y"] * h,
                                                   (s["x"] + s["w"]) * w, (s["y"] + s["h"]) * h))
            side = box[2] - box[0]
            p = P.crop(box).resize((side, side))
            q = Q.crop(box).resize((side, side))
            # The sticker: everything inside the cut-line stroke (r = 33 of 33).
            sticker, square, dimg = slot_diff(p, q, 0.97)
            # The editor tile of the same photo, its middle square — photos only;
            # an empty slot has no row of its own to edit.
            entry = order["entries"][card * 4 + i] if i < n_here else None
            t = None
            tile_sticker = None
            if entry:
                m = tile_px * 3 / (s["w"] * spec["viewBox"][2] + 6)
                tbox = tuple(round(v * SCALE) for v in (
                    i * (tile_px + 10) + m, h + 10 + m,
                    i * (tile_px + 10) + tile_px - m, h + 10 + tile_px - m))
                t = Q.crop(tbox).resize((side, side))
                tile_sticker, _, _ = slot_diff(p, t, 0.97)
            row = {"order": name, "theme": order["theme"], "players": order["players"],
                   "card": card, "slot": i, "kind": "photo" if entry else "pawn",
                   "cutout": bool(entry and entry["cutout"]),
                   "view": bool(entry and entry["view"]),
                   "card_sticker": sticker, "card_square": square, "tile_sticker": tile_sticker}
            rows.append(row)
            strip = Image.new("RGB", (side * 4, side), "white")
            for k, im in enumerate((p, q, t, dimg.point(lambda v: min(255, v * 4)))):
                if im is not None:
                    strip.paste(im, (k * side, 0))
            strip.save(os.path.join(work, "slot-c%d-s%d.png" % (card, i)))
    print("%s done (%s, %d players, %d photos)" % (name, order["theme"], order["players"],
                                                   len(order["entries"])), flush=True)
    return rows


def summary(rows):
    if not rows:
        return "no photo slots found"
    def score(r):
        return max(r["card_sticker"], r["tile_sticker"] or 0.0)

    worst = sorted(rows, key=lambda r: -score(r))
    passed = sum(1 for r in rows if score(r) < PASS_SHARE)
    photos = [r for r in rows if r["tile_sticker"] is not None]
    pct = lambda v: "%.2f%%" % (100 * v)
    lines = ["%d slots across %d orders: %d within %s differing pixels (> %d/255)"
             % (len(rows), len({r["order"] for r in rows}), passed, pct(PASS_SHARE), DIFF_AT),
             "mean differing: card sticker %s, tile sticker %s, whole slot incl. cut-line %s"
             % (pct(sum(r["card_sticker"] for r in rows) / len(rows)),
                pct(sum(r["tile_sticker"] for r in photos) / max(1, len(photos))),
                pct(sum(r["card_square"] for r in rows) / len(rows))),
             "worst five:"]
    for r in worst[:5]:
        lines.append("  %s card %d slot %d (%s %s, cut=%s, view=%s): card %s, tile %s"
                     % (r["order"], r["card"], r["slot"], r["theme"], r["kind"], r["cutout"],
                        r["view"], pct(r["card_sticker"]),
                        "-" if r["tile_sticker"] is None else pct(r["tile_sticker"])))
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("orders")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    print(summary(run(args.orders, args.out)))
    for name, why in FAILED:
        print("FAILED %s: %s" % (name, why))


if __name__ == "__main__":
    main()
