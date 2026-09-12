"""SRT 자막의 자료구조 / 파서 / 직렬화."""

from __future__ import annotations

import re
from dataclasses import dataclass

__all__ = ["Cue", "format_timestamp", "parse_srt", "render_srt", "write_srt"]


@dataclass
class Cue:
    """자막 한 덩어리. 시각은 밀리초 단위."""

    start: int
    end: int
    text: str

    @property
    def duration(self) -> int:
        return self.end - self.start


def format_timestamp(ms: int) -> str:
    """밀리초를 ``HH:MM:SS,mmm`` 으로 만든다. 음수는 0으로 잘라낸다."""
    ms = max(0, int(ms))
    hours, ms = divmod(ms, 3_600_000)
    minutes, ms = divmod(ms, 60_000)
    seconds, ms = divmod(ms, 1_000)
    return f"{hours:02d}:{minutes:02d}:{seconds:02d},{ms:03d}"


_TIMECODE = re.compile(
    r"(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})"
    r"\s*-->\s*"
    r"(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})"
)


def _to_ms(hours: str, minutes: str, seconds: str, fraction: str) -> int:
    # ``.5`` 처럼 자리수가 모자란 소수부도 밀리초로 맞춰 준다.
    millis = int(fraction.ljust(3, "0"))
    return ((int(hours) * 60 + int(minutes)) * 60 + int(seconds)) * 1000 + millis


def parse_srt(text: str) -> list[Cue]:
    """SRT 문서를 Cue 목록으로 읽는다.

    번호 줄이 없거나 어긋나 있어도 타임코드 줄을 기준으로 잘라내므로,
    ffmpeg 가 만든 SRT 든 손으로 쓴 SRT 든 똑같이 처리된다.
    """
    text = text.lstrip("﻿").replace("\r\n", "\n").replace("\r", "\n")
    cues: list[Cue] = []
    matches = list(_TIMECODE.finditer(text))

    for position, match in enumerate(matches):
        body_start = text.find("\n", match.end())
        if body_start < 0:
            continue

        has_next = position + 1 < len(matches)
        if has_next:
            # 다음 타임코드가 있는 '줄의 시작'까지가 이번 큐의 몫이다.
            body_end = text.rfind("\n", 0, matches[position + 1].start()) + 1
        else:
            body_end = len(text)

        lines = text[body_start + 1 : body_end].split("\n")
        while lines and not lines[-1].strip():
            lines.pop()
        # 마지막에 남은 한 줄짜리 숫자는 다음 큐의 번호다. 자막 본문이 숫자로
        # 끝나는 경우와 헷갈리지 않도록 '그 줄 전체가 숫자일 때'만 걷어낸다.
        if has_next and lines and lines[-1].strip().isdigit():
            lines.pop()
        while lines and not lines[-1].strip():
            lines.pop()

        body = "\n".join(lines).strip()
        if body:
            cues.append(Cue(_to_ms(*match.group(1, 2, 3, 4)),
                            _to_ms(*match.group(5, 6, 7, 8)),
                            body))

    return cues


def render_srt(cues: list[Cue]) -> str:
    blocks = []
    for number, cue in enumerate(cues, start=1):
        blocks.append(
            f"{number}\n"
            f"{format_timestamp(cue.start)} --> {format_timestamp(cue.end)}\n"
            f"{cue.text}\n"
        )
    return "\n".join(blocks)


def write_srt(path, cues: list[Cue], encoding: str = "utf-8", bom: bool = False) -> None:
    """SRT 파일로 저장한다.

    cp949 처럼 한글 일부를 담지 못하는 인코딩을 골랐을 때 예외로 죽는 대신
    해당 글자만 '?' 로 바꾼다. 구형 플레이어 대응용 선택지이기 때문이다.
    """
    body = render_srt(cues)
    if bom and encoding.lower().replace("-", "") in {"utf8", "utf_8"}:
        body = "﻿" + body
    with open(path, "w", encoding=encoding, errors="replace", newline="\n") as handle:
        handle.write(body)
