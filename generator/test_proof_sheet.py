"""The proof is made FROM the deck, so these tests build a real PDF and read it.

Nothing here mocks ghostscript. The whole point of rendering the proof out of the
PDF is that it cannot drift from the artefact; a test that faked the render would
be testing the one thing that isn't the risk.
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

proof_sheet = pytest.importorskip("proof_sheet")
PIL = pytest.importorskip("PIL")
from PIL import Image  # noqa: E402

pytestmark = pytest.mark.skipif(
    shutil.which(os.environ.get("GHOSTSCRIPT", "gs")) is None,
    reason="ghostscript is in the image; skip where it is not installed",
)

CARD_W, CARD_H = 224, 312  # points: the real card box, 79x110mm


def _pdf(tmp_path, pages=4, size=(CARD_W, CARD_H), fill="#fdf6e6"):
    """A stand-in deck at the real card proportions."""
    px = (size[0] * 4, size[1] * 4)
    ims = []
    for i in range(pages):
        im = Image.new("RGB", px, fill)
        for x in range(20, px[0] - 20):          # a mark that differs per page
            im.putpixel((x, 30 + i * 12), (120, 30, 40))
        ims.append(im)
    out = str(tmp_path / "deck.pdf")
    ims[0].save(out, "PDF", save_all=True, append_images=ims[1:], resolution=288)
    return out


def test_every_page_of_the_deck_becomes_a_picture(tmp_path):
    pdf = _pdf(tmp_path, pages=7)
    m = proof_sheet.build(pdf, str(tmp_path / "proof"), width=300)
    assert m["pages"] == 7
    assert len(m["files"]) == 7
    for name in m["files"]:
        assert (tmp_path / "proof" / name).exists()


def test_the_pages_come_back_in_order(tmp_path):
    """Page 3 of the proof must be page 3 of the deck.

    ghostscript writes p0001..p0010 and a plain sort of THAT is fine — but a
    sort of "1,2,...,10" is not, and the zero-padding is the only reason it
    holds. Ten pages is the smallest deck that would catch losing it.
    """
    m = proof_sheet.build(_pdf(tmp_path, pages=11), str(tmp_path / "proof"), width=200)
    assert m["files"] == ["%04d.webp" % i for i in range(1, 12)]


def test_a_card_keeps_its_shape(tmp_path):
    """No cropping. A card comes back at the card's proportions, not at whatever
    shape trimming its background would have left."""
    m = proof_sheet.build(_pdf(tmp_path, pages=2), str(tmp_path / "proof"), width=320)
    im = Image.open(tmp_path / "proof" / m["files"][0])
    assert im.width == 320
    assert abs(im.height / im.width - CARD_H / CARD_W) < 0.02


def test_a_pale_card_is_not_trimmed_to_its_ink(tmp_path):
    """The trap this design exists to avoid: a front whose art runs white to the
    trim must come back the same shape as its neighbours, not cropped to the few
    dark pixels on it."""
    pdf = _pdf(tmp_path, pages=2, fill="#ffffff")
    m = proof_sheet.build(pdf, str(tmp_path / "proof"), width=320)
    im = Image.open(tmp_path / "proof" / m["files"][0])
    assert im.width == 320
    assert abs(im.height / im.width - CARD_H / CARD_W) < 0.02


def test_the_manifest_lands_beside_the_pictures(tmp_path):
    out = tmp_path / "proof"
    proof_sheet.build(_pdf(tmp_path, pages=3), str(out), width=260)
    m = json.load(open(out / "proof.json", encoding="utf-8"))
    assert m["pages"] == 3 and m["width"] == 260


def test_a_missing_deck_is_refused_not_guessed(tmp_path):
    with pytest.raises(FileNotFoundError):
        proof_sheet.build(str(tmp_path / "nope.pdf"), str(tmp_path / "proof"))


def test_the_cli_answers_in_json(tmp_path):
    pdf = _pdf(tmp_path, pages=2)
    r = subprocess.run(
        [sys.executable, os.path.join(HERE, "proof_sheet.py"), pdf,
         str(tmp_path / "p"), "--width", "180"],
        capture_output=True, text=True,
    )
    assert r.returncode == 0, r.stderr
    assert json.loads(r.stdout.strip().split("\n")[-1])["pages"] == 2


def test_a_failure_is_reported_not_raised(tmp_path):
    """The route reads stdout. A traceback on stderr would reach it as a blank
    answer, so the CLI has to say what went wrong in the channel being read."""
    r = subprocess.run(
        [sys.executable, os.path.join(HERE, "proof_sheet.py"),
         str(tmp_path / "absent.pdf"), str(tmp_path / "p")],
        capture_output=True, text=True,
    )
    assert "error" in json.loads(r.stdout.strip().split("\n")[-1])


def test_no_temporary_files_are_left_on_the_volume(tmp_path):
    """The PNGs are transient and big; the orders volume is not a scratch disk."""
    out = tmp_path / "proof"
    m = proof_sheet.build(_pdf(tmp_path, pages=3), str(out), width=200)
    left = set(os.listdir(out)) - set(m["files"]) - {"proof.json"}
    assert left == set()


def test_a_board_page_is_narrowed_to_the_same_width(tmp_path):
    """A deck's pages are not all one size — the board is A4. Every page still
    comes back at the grid's width, or the grid is ragged."""
    pdf = _pdf(tmp_path, pages=2, size=(595, 842))
    m = proof_sheet.build(pdf, str(tmp_path / "proof"), width=300)
    assert Image.open(tmp_path / "proof" / m["files"][0]).width == 300
