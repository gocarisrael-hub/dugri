# normalise every card's visible frame (card edge -> inner panel) to טריפה's: T px on a 400 x 564 card, every side
import sys, os, json, numpy as np
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from frame import frame
D = '/Users/hadar/projects/dugri-redesign/redesign/directions/'
SRC, OUT = D + 'cards8/', D + 'cards9/'
W, H, T = 400, 564, 42
# where each image came from: the print-template renders carry a ~45 px frame, the deck-sheet cuts ~24 px
TEMPLATE = {'birthday-f1', 'birthday-b1', 'marriage-f1', 'marriage-b1', 'japanese-f1', 'kids-f1', 'tarifa-f1', 'tarifa-b1', 'bachelorette-b1'}
DEFAULT = {'template': 45, 'sheet': 24}
log = {}
for f in sorted(os.listdir(SRC)):
    if not f.endswith('.webp') or f.startswith('pawn'):
        continue
    name = f[:-5]
    kind = 'template' if name in TEMPLATE else 'sheet'
    m, _ = frame(SRC + f)
    ok = {s: v for s, v in m.items() if v is not None and 6 <= v <= 80}
    # an unreliable side takes its opposite side, else the source's typical frame
    opp = {'l': 'r', 'r': 'l', 't': 'b', 'b': 't'}
    meas = {s: ok.get(s, ok.get(opp[s], DEFAULT[kind])) for s in 'ltrb'}
    # the measured sides of one card must agree within 10 px, or the measurement caught the art: use the source default
    if max(meas.values()) - min(meas.values()) > 10:
        meas = {s: DEFAULT[kind] for s in 'ltrb'}
        how = 'default'
    else:
        how = 'measured'
    a = np.asarray(Image.open(SRC + f).convert('RGB'))
    h, w, _ = a.shape
    pw, ph = w - meas['l'] - meas['r'], h - meas['t'] - meas['b']
    # the new canvas keeps the panel and gives it a T-wide frame on every side (in final-size terms)
    Wf, Hf = pw * W / (W - 2 * T), ph * H / (H - 2 * T)
    nl, nt = T * Wf / W, T * Hf / H
    pads = {'l': round(nl - meas['l']), 'r': round(nl - meas['r']), 't': round(nt - meas['t']), 'b': round(nt - meas['b'])}
    # crop the sides that are too wide; widen the ones too thin
    a = a[max(0, -pads['t']): h - max(0, -pads['b']), max(0, -pads['l']): w - max(0, -pads['r'])]
    # the card sits on a uniform card shape: each added band is that side's own frame colour (the median of its outer 6 px), never a
    # mirror of the art, which would bring the panel's edge back out
    ring = {'t': a[:6].reshape(-1, 3), 'b': a[-6:].reshape(-1, 3), 'l': a[:, :6].reshape(-1, 3), 'r': a[:, -6:].reshape(-1, 3)}
    col = {k: np.median(v, axis=0).astype(np.uint8) for k, v in ring.items()}
    hh, ww, _ = a.shape
    pt, pb, pl, pr = (max(0, pads[k]) for k in 'tblr')
    canvas = np.zeros((hh + pt + pb, ww + pl + pr, 3), np.uint8)
    canvas[:pt + 1, :] = col['t']; canvas[-(pb + 1):, :] = col['b']
    canvas[:, :pl + 1] = col['l']; canvas[:, -(pr + 1):] = col['r']
    canvas[pt:pt + hh, pl:pl + ww] = a
    a = canvas
    Image.fromarray(a).resize((W, H), Image.LANCZOS).save(OUT + f, quality=88)
    log[name] = {'source': kind, 'frame_in': meas, 'how': how, 'pad(+)/crop(-)': pads}
json.dump(log, open(OUT + 'frames.json', 'w'), ensure_ascii=False, indent=1)
for k, v in log.items():
    if k.endswith(('f1', 'b1')): print(k, v)
