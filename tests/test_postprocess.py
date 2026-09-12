from subex.postprocess import clean_text, tidy
from subex.srt import Cue


def test_clean_text_strips_ass_overrides():
    assert clean_text(r"{\an8}위쪽\N아래쪽") == "위쪽\n아래쪽"


def test_clean_text_keeps_styling_when_asked():
    assert clean_text(r"{\i1}기울임", strip_styling=False) == r"{\i1}기울임"


def test_clean_text_collapses_whitespace_and_drops_blank_lines():
    assert clean_text("  두   칸  \n\n  다음 줄 ") == "두 칸\n다음 줄"


def test_tidy_drops_empty_and_enforces_minimum_duration():
    cues = tidy([Cue(0, 100, "   "), Cue(1000, 1050, "짧다")])
    assert cues == [Cue(1000, 1200, "짧다")]


def test_tidy_merges_repeated_text():
    cues = tidy([Cue(1000, 2000, "같은 말"), Cue(2100, 3000, "같은 말")])
    assert cues == [Cue(1000, 3000, "같은 말")]


def test_tidy_resolves_overlap():
    cues = tidy([Cue(1000, 4000, "앞"), Cue(2500, 5000, "뒤")])
    assert cues[0].end == 2500 and cues[1].start == 2500


def test_tidy_sorts_by_time():
    cues = tidy([Cue(5000, 6000, "나중"), Cue(1000, 2000, "먼저")])
    assert [cue.text for cue in cues] == ["먼저", "나중"]
