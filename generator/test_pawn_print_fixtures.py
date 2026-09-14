"""build.py still gives the answers site/js/pawn-print.js is held to.

tests/unit/pawn-print.test.js checks the browser against
tests/unit/fixtures/pawn-print/expected.json. That file is only worth checking
against while it is what the GENERATOR says — so this recomputes every answer
from build.py and fails the moment the two part. The fix is then deliberate:
regenerate (python3 generator/pawn_print_fixtures.py) and let the browser test
say whether the port kept up.
"""
import json
import os

import pawn_print_fixtures as fx


def _stored():
    with open(os.path.join(fx.OUT, "expected.json"), encoding="utf-8") as f:
        return json.load(f)


def test_every_fixture_image_is_committed():
    stored = _stored()
    for name in fx.images():
        assert os.path.isfile(os.path.join(fx.OUT, name + ".png")), name
        assert name in stored["images"], name


def test_the_generator_still_frames_every_fixture_as_recorded():
    assert fx.compute()["images"] == _stored()["images"]


def test_pillow_still_resamples_as_recorded():
    assert fx.resample_expected() == _stored()["resample"]


def test_the_fixtures_cover_every_branch_of_the_crop():
    images = _stored()["images"]
    assert any(i["framed"] and i["erased"] for i in images.values()), "bystander erase"
    assert any(i["framed"] and not i["erased"] for i in images.values()), "single subject"
    assert any(not i["framed"] and i["cutout"] for i in images.values()), "cutout with no silhouette"
    assert any(not i["cutout"] for i in images.values()), "original"
    assert any(max(i["width"], i["height"]) <= fx.build.PHOTO_BLOB_MASK_PX
               for i in images.values() if i["framed"]), "no downscale"
