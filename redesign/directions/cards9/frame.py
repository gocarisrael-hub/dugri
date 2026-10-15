# measure each card's frame: from the card edge to its inner panel, on all four sides
import sys, numpy as np
from PIL import Image
def panel_colour(a):
    h,w,_=a.shape
    # the panel is the most common colour in a central band that avoids the words (lower-middle area)
    reg=a[int(h*.62):int(h*.78), int(w*.3):int(w*.7)].reshape(-1,3)//12*12
    vals,counts=np.unique(reg,axis=0,return_counts=True)
    return vals[counts.argmax()].astype(float)+6
def frame(path):
    a=np.asarray(Image.open(path).convert('RGB')).astype(float); h,w,_=a.shape
    pc=panel_colour(a)
    near=np.linalg.norm(a-pc,axis=2)<34
    out={}
    for side in 'ltrb':
        res=[]
        lines=[int((h if side in 'lr' else w)*f) for f in (.4,.5,.6,.7)]
        for L in lines:
            seq=near[L,:] if side=='l' else near[L,::-1] if side=='r' else near[:,L] if side=='t' else near[::-1,L]
            # first run of 8 panel-coloured pixels
            run=0
            for i,v in enumerate(seq[:int(len(seq)*.4)]):
                run=run+1 if v else 0
                if run>=8: res.append(i-7); break
            else: res.append(None)
        good=[r for r in res if r is not None]
        out[side]=int(np.median(good)) if len(good)>=2 else None
    return out, pc
if __name__=='__main__':
    for f in sys.argv[1:]:
        o,pc=frame(f); print(f, o, pc.astype(int).tolist())
