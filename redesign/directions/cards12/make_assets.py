# r12's cards and boards (cards12/, boards12/): r9's evened set with the owner's corrections of 2026-10-15.
#  boards: the live shop's deck boards (/api/design-images deckBoard): real backgrounds, no personal title; ברוקלין untouched;
#          דני's board carries "Bride in One Pot", painted out with its own horizontal stripes.
#  טוקיו back: its black panel and red outline laid on its own black, not on white (the outline shows again).
#  דני fronts: the frame is the sheet's real vertical stripes, continued outward at the sheet's period and phase.
#  אואזיס front: exactly what the live shop shows: the print template's front ("יום הולדת לדנה", slice frame).
import shutil, os
import numpy as np
from PIL import Image

DIR = '/Users/hadar/projects/dugri-redesign/redesign/directions/'
LIVE = '/private/tmp/claude-501/-Users-hadar-projects-dugri/969d6d92-74a7-4d84-a9a5-a49e3f54ea96/scratchpad/r7/live/di/'
HERE = '/private/tmp/claude-501/-Users-hadar-projects-dugri/969d6d92-74a7-4d84-a9a5-a49e3f54ea96/scratchpad/r12/assets/'
C9, B9, C12, B12 = DIR + 'cards9/', DIR + 'boards9/', DIR + 'cards12/', DIR + 'boards12/'
for src, dst in [(C9, C12), (B9, B12)]:
    shutil.rmtree(dst, ignore_errors=True); shutil.copytree(src, dst)
W, H = 400, 564
FRAME = .1078  # the preview's evened frame: 10.78% of the card width

# ---- boards ----
SRC = {'bachelorette': 'bachelorette', 'birthday': 'birthday', 'grapefruit': 'grapefruit', 'marriage': 'marriage', 'daniel': 'daniel-amit',
       'japanese': 'japanese', 'posttrip': 'posttrip', 'football': 'football-boys', 'tarifa': 'tarifa'}  # kids: untouched
for k, f in SRC.items():
    im = Image.open(LIVE + f + '-deckBoard.png').convert('RGB')
    if k == 'daniel':
        # the title sits bottom left (x 0-380, y 1325-1385 of 2000x1414; the circles above end at y 1295); the stripes are horizontal, so the same rows a little to the right
        # (clear of the bottom row of circles) carry exactly the pattern that belongs under the title
        a = np.asarray(im).copy()
        y0, y1, x0, x1 = 1305, 1400, 0, 390
        a[y0:y1, x0:x1] = a[y0:y1, x1 + 40:x1 + 40 + (x1 - x0)]
        im = Image.fromarray(a)
    im.resize((1200, 849), Image.LANCZOS).save(B12 + k + '.webp', quality=88)

# ---- טוקיו back: the white around the panel becomes the card's own black ----
def frame_to(path, colour, tol=26):
    im = Image.open(path).convert('RGB'); a = np.asarray(im).astype(int)
    h, w, _ = a.shape
    base = a[2, w // 2]
    near = (np.abs(a - base).sum(axis=2) < tol)
    # flood from the edges through the near-white frame only
    from collections import deque
    seen = np.zeros((h, w), bool); q = deque()
    for x in range(w): q += [(0, x), (h - 1, x)]
    for y in range(h): q += [(y, 0), (y, w - 1)]
    while q:
        y, x = q.popleft()
        if seen[y, x] or not near[y, x]: continue
        seen[y, x] = True
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx]: q.append((ny, nx))
    out = a.copy(); out[seen] = colour
    return Image.fromarray(out.astype(np.uint8)), seen
jb, _ = frame_to(C9 + 'japanese-b1.webp', (34, 34, 32))
jb.save(C12 + 'japanese-b1.webp', quality=90)

# ---- דני fronts: the flat frame becomes the sheet's real stripes ----
sheet = np.asarray(Image.open(LIVE + 'daniel-amit-deckFronts.png').convert('RGB')).astype(int)
row = sheet[5].copy(); row[497] = row[496]  # one background row (vertical stripes), the cut line removed
# the stripe period, by autocorrelation of the row's brightness
g = row.sum(axis=1).astype(float); g -= g.mean()
ac = [np.dot(g[:-p], g[p:]) / (len(g) - p) for p in range(20, 300)]
period = 20 + int(np.argmax(ac))
one = row[100:100 + period]  # a clean period, away from the cut lines
# scale sheet -> card: the panel is 456 px wide in the sheet (outline x 21..477 of a 500 px cell) and 400*(1-2*FRAME) px on the card
panel_sheet = 456.0; scale = W * (1 - 2 * FRAME) / panel_sheet
x_panel_card = W * FRAME; x_panel_sheet = 21
def stripes():
    xs = np.arange(W)
    sx = (x_panel_sheet + (xs - x_panel_card) / scale - 100) % period  # the same phase as the sheet, measured from the clean period
    line = one[sx.astype(int)]
    return np.repeat(line[None, :, :], H, axis=0)
st = stripes()
for n in range(1, 9):
    _, mask = frame_to(C9 + f'daniel-f{n}.webp', (0, 0, 0), tol=18)
    a = np.asarray(Image.open(C9 + f'daniel-f{n}.webp').convert('RGB')).astype(int)
    a[mask] = st[mask]
    Image.fromarray(a.astype(np.uint8)).save(C12 + f'daniel-f{n}.webp', quality=90)

# ---- אואזיס front: the live shop's card (the print template's front), as it is ----
gf = Image.open(HERE + 'tpl-grapefruit-front.png').convert('RGB').resize((W, H), Image.LANCZOS)
gf.save(C12 + 'grapefruit-f1.webp', quality=90)
for n in range(2, 9):
    if os.path.exists(C12 + f'grapefruit-f{n}.webp'): os.remove(C12 + f'grapefruit-f{n}.webp')

# טוקיו's colour for the panel and the flood: the koi red of its own art
a = np.asarray(Image.open(C9 + 'japanese-f1.webp').convert('RGB')).astype(int).reshape(-1, 3)
red = a[(a[:, 0] > 150) & (a[:, 1] < 90) & (a[:, 2] < 90)]
print('period', period, 'scale', round(scale, 3), 'japanese red', '#%02x%02x%02x' % tuple(np.median(red, axis=0).astype(int)))
