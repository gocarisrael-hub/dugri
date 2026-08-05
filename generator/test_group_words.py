"""Picking the four WORD rows out of a filled card's detected ink bands.

Regression for a whole deck printing its words one line too low. The detector
used to take the four most EVENLY SPACED bands. That is ambiguous the moment a
template's filled sample has an entry long enough to WRAP: the wrap adds a fifth
evenly spaced band, and dropping the real first word scores just as evenly as
dropping the wrap. On staging's סנטוריני it dropped the first word, adopted the
wrap as a slot, and every calibrated slot moved down one line.

The signal that settles it is the number marker. ``render_page.word_lines`` pins
each entry's "N." to its slot's right edge, so the four word rows share a right
edge — a title (set wider) and a wrap (no marker, so a marker-width short) do
not.

Bands are ``[y0, y1, x0, x1]`` in render pixels, as ``rows_in_cell`` returns
them. The numbers below are the real measurements off that template.
"""
import recipe_diff as R

H = 832  # render height of the card these rows were measured from

# The סנטוריני front: title, three entries, the wrap of the third, then the
# fourth entry. Six bands for four words.
TITLE = [108, 186, 119, 480]
W1 = [302, 332, 254, 412]
W2 = [375, 414, 288, 419]
W3 = [455, 498, 163, 416]
WRAP = [546, 579, 276, 378]   # no marker → right edge falls short
W4 = [623, 666, 126, 415]


def centres(group):
    return [round(f["cy"], 4) for f in group["words"]]


def test_a_wrapped_entry_does_not_steal_a_slot():
    got = R.group_words([TITLE, W1, W2, W3, WRAP, W4], H)
    assert got is not None
    # The four NUMBERED rows, with the wrap skipped — not rows 2..5.
    assert centres(got) == [
        round((W1[0] + W1[1]) / 2 / H, 4),
        round((W2[0] + W2[1]) / 2 / H, 4),
        round((W3[0] + W3[1]) / 2 / H, 4),
        round((W4[0] + W4[1]) / 2 / H, 4),
    ]
    # ...and the wrap is not silently promoted to the title either.
    assert [round(t["cy"], 4) for t in got["title"]] == [round((TITLE[0] + TITLE[1]) / 2 / H, 4)]


def test_the_first_word_is_never_the_one_dropped():
    # The specific failure: slots shifted DOWN by one line. Guard the symptom
    # directly, so a future change that reintroduces it fails loudly.
    got = R.group_words([TITLE, W1, W2, W3, WRAP, W4], H)
    assert got["words"][0]["cy"] == W1[0] / H + (W1[1] - W1[0]) / 2 / H
    assert all(f["cy"] != (WRAP[0] + WRAP[1]) / 2 / H for f in got["words"])


def test_a_card_with_no_wrap_is_unchanged():
    got = R.group_words([TITLE, W1, W2, W3, W4], H)
    assert centres(got) == [
        round((r[0] + r[1]) / 2 / H, 4) for r in (W1, W2, W3, W4)
    ]
    assert len(got["title"]) == 1


def test_exactly_four_bands_are_all_words():
    got = R.group_words([W1, W2, W3, W4], H)
    assert centres(got) == [round((r[0] + r[1]) / 2 / H, 4) for r in (W1, W2, W3, W4)]
    assert got["title"] == []


def test_a_two_line_title_still_leaves_four_words():
    t2 = [200, 260, 130, 470]  # second title line, also wider than the markers
    got = R.group_words([TITLE, t2, W1, W2, W3, W4], H)
    assert centres(got) == [round((r[0] + r[1]) / 2 / H, 4) for r in (W1, W2, W3, W4)]
    assert len(got["title"]) == 2


def test_fewer_than_four_bands_is_no_answer():
    assert R.group_words([TITLE, W1, W2], H) is None


def test_falls_back_to_even_spacing_when_no_marker_column_reads():
    # Ragged right edges (nothing aligns) must still produce an answer rather
    # than crashing — the old heuristic remains the floor.
    ragged = [
        [302, 332, 254, 400],
        [375, 414, 288, 430],
        [455, 498, 163, 370],
        [546, 579, 276, 445],
        [623, 666, 126, 395],
    ]
    got = R.group_words(ragged, H)
    assert got is not None and len(got["words"]) == 4


def test_a_title_UNDER_the_words_is_title_not_a_wrap():
    # מרקאנה's front 9 carries its title at the FOOT of the card. It is below the
    # words, like a wrap of the last entry would be, but it is not interleaved
    # with them and it is not marker-aligned — so it is the title.
    LOW = [720, 800, 119, 480]
    got = R.group_words([W1, W2, W3, W4, LOW], H, whole_card=True)
    assert centres(got) == [round((b[0] + b[1]) / 2 / H, 4)
                            for b in (W1, W2, W3, W4)]
    assert [round(t["cy"], 4) for t in got["title"]] == [
        round((LOW[0] + LOW[1]) / 2 / H, 4)]


def test_a_wrap_is_still_dropped_when_the_title_is_underneath():
    # Both at once: a wrapped entry mid-list AND a low title. The wrap must be
    # discarded and the title kept — the two are told apart by position relative
    # to the word block, not by being above or below it.
    LOW = [720, 800, 119, 480]
    got = R.group_words([W1, W2, W3, WRAP, W4, LOW], H, whole_card=True)
    assert centres(got) == [round((b[0] + b[1]) / 2 / H, 4)
                            for b in (W1, W2, W3, W4)]
    assert [round(t["cy"], 4) for t in got["title"]] == [
        round((LOW[0] + LOW[1]) / 2 / H, 4)], "the wrap must not reach the title"


def test_a_sheet_cell_never_adopts_ink_below_its_words():
    # A v1 cell is a CROP out of an 8-up sheet, so the card below bleeds over the
    # cut line: every cell of טיימס סקוור's front sheet carries a full-width band
    # at its very bottom edge. That is the neighbour, not this card's title, and
    # adopting it would inflate the title box on all eight cards.
    BLEED = [700, 730, 0, 507]
    got = R.group_words([TITLE, W1, W2, W3, W4, BLEED], H)
    assert [round(t["cy"], 4) for t in got["title"]] == [
        round((TITLE[0] + TITLE[1]) / 2 / H, 4)], "the bleed must not be title"
    # ...and the same bands read as a WHOLE CARD do keep the low band, because
    # there is no neighbour to bleed: that is the v2 single-card case.
    whole = R.group_words([TITLE, W1, W2, W3, W4, BLEED], H, whole_card=True)
    assert len(whole["title"]) == 2
