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
