#!/usr/bin/env python3
"""
POC: fill the svglue template with sample values and render PNG + PDF.

  python3 fill_card.py

Reads  poc/svglue/template.svg
Writes poc/svglue/out.svg  (filled, self-contained)
       poc/svglue/out.png
       poc/svglue/out.pdf
"""
import os
import subprocess

import svglue

HERE = os.path.dirname(os.path.abspath(__file__))
TEMPLATE = os.path.join(HERE, "template.svg")
OUT_SVG = os.path.join(HERE, "out.svg")
OUT_PNG = os.path.join(HERE, "out.png")
OUT_PDF = os.path.join(HERE, "out.pdf")

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# sample fill values (honoree title + the 4 words)
VALUES = {
    "title": "Ziv's",          # honoree; the fixed "Bachelorette" line follows
    "word1": "שנילב תירס",
    "word2": "שופינג",
    "word3": "ברוליית",
    "word4": "הכנסת חשמל",
}


def fill():
    tpl = svglue.load(file=TEMPLATE)
    for tid, text in VALUES.items():
        tpl.set_text(tid, text)
    # svglue's __str__ returns bytes (lxml tostring); write them directly.
    data = bytes(tpl.__str__())
    with open(OUT_SVG, "wb") as f:
        f.write(data)
    print("wrote", OUT_SVG, len(data), "bytes")


def render():
    subprocess.run(
        [
            CHROME, "--headless", "--disable-gpu",
            "--force-device-scale-factor=2",
            "--default-background-color=00000000",
            f"--screenshot={OUT_PNG}",
            "--window-size=576,831",
            OUT_SVG,
        ],
        check=True, stderr=subprocess.DEVNULL,
    )
    print("wrote", OUT_PNG)
    # Tight, card-sized PDF: wrap the SVG in HTML with a matching @page so the
    # card fills the page (Chrome would otherwise drop it onto a letter sheet).
    # card aspect 192:277 -> 96mm x 138.5mm
    out_html = os.path.join(HERE, "out.html")
    with open(OUT_SVG, "r", encoding="utf-8") as f:
        svg_markup = f.read()
    html = (
        "<!doctype html><html><head><meta charset='utf-8'><style>"
        "@page{size:96mm 138.5mm;margin:0}"
        "html,body{margin:0;padding:0}"
        "svg{display:block;width:96mm;height:138.5mm}"
        "</style></head><body>" + svg_markup + "</body></html>"
    )
    with open(out_html, "w", encoding="utf-8") as f:
        f.write(html)
    subprocess.run(
        [
            CHROME, "--headless", "--disable-gpu",
            "--no-pdf-header-footer",
            f"--print-to-pdf={OUT_PDF}",
            out_html,
        ],
        check=True, stderr=subprocess.DEVNULL,
    )
    os.remove(out_html)
    print("wrote", OUT_PDF)


if __name__ == "__main__":
    fill()
    render()
