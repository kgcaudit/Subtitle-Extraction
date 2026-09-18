"""추출된 자막을 다듬는다."""

from __future__ import annotations

import re

from subex.srt import Cue

__all__ = ["clean_text", "tidy"]

#: ASS/SSA 의 스타일 지시자와 그리기 태그.
_ASS_OVERRIDE = re.compile(r"\{\\[^}]*\}")
_ASS_NEWLINE = re.compile(r"\\[Nnh]")
#: OCR 이 자주 흘리는 제어문자 / 특수 공백.
_JUNK = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f​﻿]")

#: 줄 첫머리의 대화 표시(-). 숫자 앞(-5도)은 음수일 수 있으므로 글자 앞에서만 본다.
_DIALOGUE_DASH = re.compile(r"^([-\u2013\u2014])(?=[^\s\d])")
_DIALOGUE_DASH_SPACED = re.compile(r"^[-\u2013\u2014] ")

#: 자막 한 트랙에서 대화 표시 뒤를 띄어쓴 줄이 이 비율을 넘으면 '띄어쓰는 자막'
#: 으로 보고, 붙어 있는 나머지는 인식기가 띄어쓰기를 흘린 것으로 본다.
#:
#: 자막마다 관습이 다르다. 실측으로 한쪽은 184줄 중 179줄(97%)이 띄어쓰고,
#: 다른 쪽은 49줄 모두(0%) 붙여 쓴다. 그래서 무조건 띄우면 붙여 쓰는 자막을
#: 원본과 다르게 만든다. 트랙 전체를 보고 그 자막의 관습을 따른다.
_DASH_SPACING_MAJORITY = 0.7


def clean_text(text: str, strip_styling: bool = True) -> str:
    if strip_styling:
        text = _ASS_OVERRIDE.sub("", text)
        text = _ASS_NEWLINE.sub("\n", text)
    text = _JUNK.sub("", text).replace(" ", " ")

    lines = []
    for line in text.splitlines():
        line = re.sub(r"[ \t]+", " ", line).strip()
        if line:
            lines.append(line)
    return "\n".join(lines)


def _restore_dash_spacing(cues: list[Cue]) -> None:
    """대화 표시(-) 뒤 띄어쓰기를, 그 자막의 관습에 맞춰 되살린다.

    인식기가 가끔 띄어쓰기를 흘린다. 다만 애초에 붙여 쓰는 자막도 있으므로,
    트랙 전체에서 어느 쪽이 관습인지 본 다음 소수 쪽만 맞춘다. 띄어쓰기를
    없애지는 않는다 — 인식기가 없는 띄어쓰기를 만들어 내는 일은 드물다.
    """
    lines = [line for cue in cues for line in cue.text.split("\n")]
    dashed = [line for line in lines if _DIALOGUE_DASH.match(line) or _DIALOGUE_DASH_SPACED.match(line)]
    if not dashed:
        return

    spaced = sum(1 for line in dashed if _DIALOGUE_DASH_SPACED.match(line))
    if spaced / len(dashed) < _DASH_SPACING_MAJORITY:
        return      # 붙여 쓰는 자막이다. 그대로 둔다.

    for cue in cues:
        cue.text = "\n".join(
            _DIALOGUE_DASH.sub(r"\1 ", line) for line in cue.text.split("\n")
        )


def tidy(cues: list[Cue], strip_styling: bool = True,
         min_duration: int = 200, merge_repeats: bool = True) -> list[Cue]:
    """빈 자막 제거 → 시간 보정 → 겹침 정리 → 연속 중복 병합.

    이미지 자막은 같은 문장을 여러 화면으로 나눠 표시하는 경우가 흔해서,
    글자가 똑같고 시간이 맞닿아 있으면 한 덩어리로 합친다.
    """
    cleaned: list[Cue] = []
    for cue in cues:
        text = clean_text(cue.text, strip_styling=strip_styling)
        if not text:
            continue
        start = max(0, cue.start)
        end = max(cue.end, start + min_duration)
        cleaned.append(Cue(start, end, text))

    _restore_dash_spacing(cleaned)
    cleaned.sort(key=lambda cue: (cue.start, cue.end))

    merged: list[Cue] = []
    for cue in cleaned:
        if merged:
            previous = merged[-1]
            if merge_repeats and previous.text == cue.text and cue.start - previous.end <= 250:
                previous.end = max(previous.end, cue.end)
                continue
            if cue.start < previous.end:
                # 앞 자막을 잘라 겹침을 없앤다. 그래도 남으면 시작을 밀어낸다.
                if previous.start < cue.start:
                    previous.end = cue.start
                else:
                    cue.start = previous.end
                    cue.end = max(cue.end, cue.start + min_duration)
        merged.append(cue)

    return [cue for cue in merged if cue.end > cue.start]
