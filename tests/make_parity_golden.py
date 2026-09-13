"""파이썬판과 웹판(자바스크립트)의 결과가 같은지 대조할 기준 파일을 만든다.

파이썬판은 실제 영상으로 검증을 끝낸 구현이므로 이쪽을 '정답지'로 삼는다.
여기서 만든 파일을 웹(자바스크립트) 쪽 테스트가 그대로 읽어서 같은 답이 나오는지 본다.

    python3 tests/make_parity_golden.py

결과: web/test/fixtures/parity.txt
"""

from __future__ import annotations

from pathlib import Path

from subex.postprocess import tidy
from subex.srt import parse_srt, render_srt

#: (이름, 설명, SRT 원문) — 까다로운 경우만 골라 모았다.
CASES: list[tuple[str, str, str]] = [
    (
        "plain",
        "평범한 두 줄짜리",
        "1\n00:00:01,000 --> 00:00:04,000\nHello\nworld\n\n"
        "2\n00:00:05,500 --> 00:00:08,000\n안녕하세요\n",
    ),
    (
        "text-ending-with-digits",
        "본문이 숫자로 끝나는 경우 (다음 큐 번호와 헷갈리기 쉬움)",
        "1\n00:00:01,000 --> 00:00:02,000\nMixed 한글 and English 2026\n\n"
        "2\n00:00:03,000 --> 00:00:04,000\n2026\n\n"
        "3\n00:00:05,000 --> 00:00:06,000\n끝\n",
    ),
    (
        "bom-crlf-dot",
        "BOM + CRLF 줄바꿈 + 소수점 구분자",
        "﻿1\r\n00:00:01.500 --> 00:00:02.5\r\n점 구분자\r\n",
    ),
    (
        "ass-styling",
        "ASS 스타일 태그와 줄바꿈 태그",
        "1\n00:00:01,000 --> 00:00:03,000\n{\\an8}위쪽\\N아래쪽\n\n"
        "2\n00:00:04,000 --> 00:00:06,000\n{\\i1}기울임{\\i0} 보통\n",
    ),
    (
        "overlap",
        "앞뒤 자막이 겹치는 경우",
        "1\n00:00:01,000 --> 00:00:04,000\n앞\n\n"
        "2\n00:00:02,500 --> 00:00:05,000\n뒤\n",
    ),
    (
        "repeat",
        "같은 글자가 연달아 나와 합쳐져야 하는 경우",
        "1\n00:00:01,000 --> 00:00:02,000\n같은 말\n\n"
        "2\n00:00:02,100 --> 00:00:03,000\n같은 말\n\n"
        "3\n00:00:03,050 --> 00:00:04,000\n같은 말\n",
    ),
    (
        "too-short",
        "최소 길이보다 짧은 자막",
        "1\n00:00:01,000 --> 00:00:01,050\n짧다\n",
    ),
    (
        "unsorted",
        "시간 순서가 뒤섞인 경우",
        "1\n00:00:05,000 --> 00:00:06,000\n나중\n\n"
        "2\n00:00:01,000 --> 00:00:02,000\n먼저\n",
    ),
    (
        "blank-body",
        "본문이 비어 있는 자막이 섞인 경우",
        "1\n00:00:01,000 --> 00:00:02,000\n   \n\n"
        "2\n00:00:03,000 --> 00:00:04,000\n내용\n",
    ),
    (
        "whitespace",
        "군더더기 공백과 빈 줄",
        "1\n00:00:01,000 --> 00:00:03,000\n  두   칸  \n\n  다음 줄 \n",
    ),
    (
        "long-timecode",
        "한 시간이 넘어가는 타임코드",
        "1\n01:01:01,234 --> 01:01:05,678\n오래된 자막\n",
    ),
]

SEPARATOR = "=" * 8


def build() -> str:
    blocks = []
    for name, note, source in CASES:
        expected = render_srt(tidy(parse_srt(source)))
        blocks.append(
            f"{SEPARATOR} case {name}\n"
            f"{SEPARATOR} note {note}\n"
            f"{SEPARATOR} input\n{source}"
            f"{SEPARATOR} expected\n{expected}"
        )
    return f"{SEPARATOR} end\n".join(blocks) + f"{SEPARATOR} end\n"


def main() -> None:
    target = Path(__file__).resolve().parent.parent / "web/test/fixtures/parity.txt"
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(build(), encoding="utf-8", newline="\n")
    print(f"{len(CASES)}개 경우를 {target} 에 기록했습니다.")


if __name__ == "__main__":
    main()
