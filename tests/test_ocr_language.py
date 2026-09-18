"""인식 언어 자동 선택. 웹판(web/src/ocr.js)과 규칙이 같아야 한다.

같은 입력에 같은 답을 내야 두 판의 결과가 갈리지 않는다. 아래 네 경우는
web/test/bitmap.test.js 의 같은 이름 시험과 값까지 똑같이 맞춰 두었다.
"""

from __future__ import annotations

import pytest

from subex.ocr import (
    LATIN_IS_REAL_CONFIDENCE,
    LATIN_IS_REAL_SHARE,
    LanguageChoice,
    decide_language,
    pick_language,
)


def test_decide_language_splits_the_three_measured_cases():
    # 실제로 재어 본 값이다. 여기가 어긋나면 자동 선택이 뒤집힌 것이다.
    assert decide_language(latin_words=0, total_words=31, latin_confidence=0)[0] == "kor", \
        "한글 전용(합성): 영문이 아예 없다"

    assert decide_language(latin_words=5, total_words=88, latin_confidence=54.8)[0] == "kor", \
        "한글 전용(실제 DVD 자막): 기울어진 노래 가사가 영문으로 잘못 읽히지만 몇 개뿐이다"

    assert decide_language(latin_words=7, total_words=13, latin_confidence=95.4)[0] == "kor+eng", \
        "한·영 혼합: 낱말의 절반이 영문이고 확신도도 높다"

    # 비율만 높고 확신도가 낮으면(한글을 통째로 영문으로 오독) 영어를 붙이지 않는다.
    assert decide_language(latin_words=20, total_words=30, latin_confidence=16.8)[0] == "kor", \
        "확신도가 낮으면 비율이 높아도 진짜 영문이 아니다"


def test_decide_language_needs_both_conditions():
    """확신도와 비율 둘 다 넘어야 영어를 붙인다. 하나만으로는 안 된다."""
    over_confidence = LATIN_IS_REAL_CONFIDENCE + 1
    over_share = LATIN_IS_REAL_SHARE + 0.1

    assert decide_language(1, 100, over_confidence)[0] == "kor", "확신도만 높고 비율이 낮다"
    assert decide_language(50, 100, LATIN_IS_REAL_CONFIDENCE - 1)[0] == "kor", "비율만 높고 확신도가 낮다"
    assert decide_language(round(over_share * 100), 100, over_confidence)[0] == "kor+eng"


def test_decide_language_handles_empty_input():
    """낱말이 하나도 없으면 0 으로 나누지 말고 안전한 'kor' 로 간다."""
    language, share = decide_language(0, 0, 0)
    assert (language, share) == ("kor", 0.0)


def test_pick_language_falls_back_when_there_is_nothing_to_look_at():
    choice = pick_language([])
    assert choice.language == "kor+eng"
    assert choice.sample_size == 0
    assert "볼 그림이 없어" in choice.describe()


@pytest.mark.parametrize("choice, expected", [
    (LanguageChoice("kor", sample_size=12), "영문이 보이지 않음"),
    (LanguageChoice("kor", latin_words=5, total_words=88, latin_confidence=54.8,
                    latin_share=5 / 88, sample_size=12), "5/88개 (5.7%), 확신도 54.8"),
])
def test_language_choice_explains_itself(choice, expected):
    """왜 그 언어를 골랐는지 사람이 읽을 수 있어야 한다."""
    assert expected in choice.describe()


def test_recognize_many_retries_only_the_blank_results():
    """빈 결과만 '한 낱말' 모드로 한 번 더 넣는다. 나머지는 손대지 않는다.

    '한 줄'(7) 모드는 줄을 아예 못 찾으면 아무것도 내놓지 않는다. 글자 두세
    개짜리 짧은 줄에서 그런 일이 생기고, 그러면 자막이 빈 채로 걸러져 통째로
    사라진다. 실측으로 블루레이 자막에서 `잠깐...` 한 줄이 그렇게 없어졌다.
    """
    from subex.ocr import RETRY_PAGE_SEG_MODE, recognize_many

    class FakeEngine:
        """첫 번째 그림만 '한 낱말' 모드에서 글자를 내는 인식기."""

        def __init__(self):
            self.calls = []

        def recognize(self, image, psm=None):
            self.calls.append((image, psm))
            if image == "짧은 줄":
                return "잠깐..." if psm == RETRY_PAGE_SEG_MODE else ""
            if image == "빈 그림":
                return ""
            return f"읽음:{image}"

    engine = FakeEngine()
    result = recognize_many(["짧은 줄", "보통 줄", "빈 그림"], engine, jobs=1)

    assert result == ["잠깐...", "읽음:보통 줄", ""], "빈 줄만 되살아나야 한다"

    # 첫 판은 셋 다 기본 모드로, 재시도는 빈 결과 둘만.
    first = [image for image, psm in engine.calls if psm is None]
    again = [image for image, psm in engine.calls if psm == RETRY_PAGE_SEG_MODE]
    assert first == ["짧은 줄", "보통 줄", "빈 그림"]
    assert again == ["짧은 줄", "빈 그림"], "글자를 낸 줄은 다시 읽지 않는다"


def test_recognize_many_skips_the_retry_when_nothing_is_blank():
    """빈 결과가 없으면 재시도 자체를 하지 않는다 — 공짜가 아니기 때문이다."""
    from subex.ocr import recognize_many

    class FakeEngine:
        def __init__(self):
            self.calls = 0

        def recognize(self, image, psm=None):
            self.calls += 1
            return f"읽음:{image}"

    engine = FakeEngine()
    assert recognize_many(["가", "나"], engine, jobs=1) == ["읽음:가", "읽음:나"]
    assert engine.calls == 2, "두 번만 불려야 한다"


def test_blank_positions_matches_the_web_rule():
    """다시 읽을 자리를 고르는 규칙. web/test/bitmap.test.js 와 값까지 같다."""
    from subex.ocr import blank_positions

    assert blank_positions(["잠깐", "", "왔어", ""]) == [1, 3]
    assert blank_positions(["가", "나"]) == [], "빈 것이 없으면 다시 읽지 않는다"
    assert blank_positions([]) == []
    assert blank_positions(["", "", ""]) == [0, 1, 2]
