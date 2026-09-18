"""Tesseract 를 이용한 자막 비트맵 문자 인식."""

from __future__ import annotations

import csv
import io
import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from PIL import Image

from subex.ffmpeg import ToolMissing, require, run

__all__ = [
    "TesseractEngine", "LanguageChoice", "available_languages",
    "decide_language", "pick_language", "recognize_many",
]

#: 아무것도 정하지 않았을 때의 인식 언어.
DEFAULT_LANGUAGE = "kor+eng"

#: 언어를 자동으로 고를 때 들여다볼 표본 수. 12장이면 1초 남짓이면 끝난다.
AUTO_SAMPLE_SIZE = 12

#: '진짜 영문이 섞여 있다' 고 인정하는 두 조건. 둘 다 맞아야 한다.
#:
#: 하나만 보면 놓친다. 실측값:
#:
#:   자료                      영문 낱말 비율   확신도
#:   한글 전용(합성)                  0.0%       —
#:   한글 전용(실제 DVD 자막)         5.7%      54.8   ← 확신도만 보면 속는다
#:   한·영 혼합(합성)                53.8%      95.4
#:
#: 실제 자막에서는 기울어진 노래 가사처럼 읽기 어려운 줄이 영문 낱말로 잘못
#: 읽히는데, 그 확신도가 어중간하게 높다. 다만 그런 것은 '몇 개뿐' 이다.
#: 진짜 영문이 섞인 자막이라면 낱말의 상당수가 영문이다. 그래서 비율도 함께 본다.
LATIN_IS_REAL_CONFIDENCE = 50
LATIN_IS_REAL_SHARE = 0.2

#: 한글이 한 자도 없고 로마자가 든 낱말.
_LATIN_WORD = re.compile(r"^[^\uAC00-\uD7A3]*[A-Za-z][^\uAC00-\uD7A3]*$")


def available_languages(binary: str = "tesseract") -> set[str]:
    try:
        proc = run([binary, "--list-langs"])
    except (ToolMissing, RuntimeError):
        return set()
    # 첫 줄은 "List of available languages..." 안내문이다.
    lines = (proc.stdout or b"").decode("utf-8", "replace").splitlines()
    return {line.strip() for line in lines[1:] if line.strip()}


class TesseractEngine:
    """이미지 한 장을 받아 글자를 돌려준다."""

    def __init__(self, language: str = "kor+eng", psm: int = 6, binary: str = "tesseract"):
        self.binary = require(binary)
        self.language = language
        self.psm = psm

        installed = available_languages(binary)
        missing = [code for code in language.split("+") if installed and code not in installed]
        if missing:
            raise RuntimeError(
                f"Tesseract 에 언어 데이터가 없습니다: {', '.join(missing)}\n"
                f"  설치된 언어: {', '.join(sorted(installed)) or '(없음)'}\n"
                f"  Ubuntu: sudo apt install tesseract-ocr-{missing[0]} / "
                f"macOS: brew install tesseract-lang"
            )

    def recognize(self, image: Image.Image) -> str:
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        # Tesseract 는 OpenMP 로 코어 수만큼 스레드를 띄운다. 우리가 프로세스를
        # 여러 개 돌리는 상황에서는 그게 서로 겹쳐 오히려 수십 배 느려지므로 1로 묶는다.
        env = {**os.environ, "OMP_THREAD_LIMIT": "1"}
        proc = subprocess.run(
            [
                self.binary, "stdin", "stdout",
                "--psm", str(self.psm),
                "-l", self.language,
                "--dpi", "300",
                "-c", "preserve_interword_spaces=1",
            ],
            input=buffer.getvalue(),
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            check=False,
        )
        if proc.returncode != 0:
            return ""
        return proc.stdout.decode("utf-8", "replace").strip()


@dataclass
class LanguageChoice:
    """자동으로 고른 인식 언어와, 그렇게 고른 근거."""

    language: str
    latin_words: int = 0
    total_words: int = 0
    latin_confidence: float = 0.0
    latin_share: float = 0.0
    sample_size: int = 0

    def describe(self) -> str:
        if not self.sample_size:
            return "볼 그림이 없어 기본값을 씀"
        if not self.latin_words:
            return f"표본 {self.sample_size}장에서 영문이 보이지 않음"
        return (f"표본 {self.sample_size}장에서 영문 낱말 "
                f"{self.latin_words}/{self.total_words}개 ({self.latin_share * 100:.1f}%), "
                f"확신도 {self.latin_confidence:.1f}")


def decide_language(latin_words: int = 0, total_words: int = 0,
                    latin_confidence: float = 0.0) -> tuple[str, float]:
    """세어 본 결과로 인식 언어를 정한다. 인식기 없이도 시험할 수 있게 따로 두었다.

    한쪽으로 치우쳐 판단한다. 한글 전용 자막을 '한국어+영어' 로 읽으면 멀쩡한
    한글 낱말이 영문으로 뭉개진다(실측: 300줄 중 83줄, 28%). 반대로 영문이 조금
    섞인 자막을 '한국어만' 으로 읽으면 그 영문 몇 낱말만 깨진다. 그래서 '영문이
    진짜로 섞여 있다' 는 증거가 뚜렷할 때만 영어를 함께 쓴다.

    돌려주는 값은 (언어, 영문 낱말 비율).
    """
    latin_share = latin_words / total_words if total_words else 0.0
    has_real_latin = (
        latin_words > 0
        and latin_confidence >= LATIN_IS_REAL_CONFIDENCE
        and latin_share >= LATIN_IS_REAL_SHARE
    )
    return (DEFAULT_LANGUAGE if has_real_latin else "kor"), latin_share


def _count_words(image: Image.Image, binary: str, psm: int) -> tuple[int, int, float]:
    """그림 한 장을 '한국어+영어' 로 읽고 (낱말 수, 영문 낱말 수, 확신도 합)."""
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    proc = subprocess.run(
        [binary, "stdin", "stdout", "--psm", str(psm), "-l", DEFAULT_LANGUAGE,
         "--dpi", "300", "-c", "preserve_interword_spaces=1", "tsv"],
        input=buffer.getvalue(), stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        env={**os.environ, "OMP_THREAD_LIMIT": "1"}, check=False,
    )
    if proc.returncode != 0:
        return 0, 0, 0.0

    total = latin = 0
    confidence = 0.0
    rows = csv.DictReader(
        io.StringIO(proc.stdout.decode("utf-8", "replace")),
        delimiter="\t", quoting=csv.QUOTE_NONE,
    )
    for row in rows:
        text = (row.get("text") or "").strip()
        if not text:
            continue
        total += 1
        if _LATIN_WORD.match(text):
            latin += 1
            confidence += float(row.get("conf") or 0)
    return total, latin, confidence


def pick_language(images, binary: str = "tesseract", psm: int = 7,
                  jobs: int | None = None) -> LanguageChoice:
    """인식 언어를 자동으로 고른다. 웹판(pickLanguage)과 같은 규칙을 쓴다.

    자막이 한글만 있으면 '한국어만' 이, 영문이 섞여 있으면 '한국어+영어' 가
    낫다(실측: 한글 전용에서 98.0% 대 89.7%, 한·영 혼합에서 반대로 39% 대 100%).

    두 설정의 전체 신뢰도를 견주는 방법은 차이가 너무 작아 못 믿는다
    (400장에서 89.8 대 89.5 로 뒤집혔다). 대신 안전한 쪽('한국어+영어')으로
    표본을 읽어 **영문 낱말이 진짜인지**를 본다. 진짜 영어면 자신 있게 읽고,
    한글을 영문으로 잘못 읽은 것이면 자신 없어 하기 때문에 확실히 갈린다.
    """
    images = list(images)
    if not images:
        return LanguageChoice(language=DEFAULT_LANGUAGE)

    step = max(1, len(images) // AUTO_SAMPLE_SIZE)
    sample = images[::step][:AUTO_SAMPLE_SIZE]

    workers = max(1, min(len(sample), jobs or os.cpu_count() or 4))
    with ThreadPoolExecutor(max_workers=workers) as pool:
        counted = list(pool.map(lambda image: _count_words(image, binary, psm), sample))

    total_words = sum(row[0] for row in counted)
    latin_words = sum(row[1] for row in counted)
    confidence_sum = sum(row[2] for row in counted)

    latin_confidence = confidence_sum / latin_words if latin_words else 0.0
    language, latin_share = decide_language(latin_words, total_words, latin_confidence)
    return LanguageChoice(
        language=language, latin_words=latin_words, total_words=total_words,
        latin_confidence=latin_confidence, latin_share=latin_share, sample_size=len(sample),
    )


def recognize_many(images, engine, jobs: int | None = None, progress=None) -> list[str]:
    """여러 장을 병렬로 인식한다. 순서는 입력 순서 그대로 유지된다.

    Tesseract 는 호출마다 초기화 비용이 붙으므로 코어 수만큼 굴리는 편이
    체감 속도 차이가 크다.
    """
    images = list(images)
    if not images:
        return []

    results: list[str] = [""] * len(images)
    done = 0
    workers = max(1, jobs or os.cpu_count() or 4)
    with ThreadPoolExecutor(max_workers=workers) as pool:
        for position, text in zip(range(len(images)), pool.map(engine.recognize, images)):
            results[position] = text
            done += 1
            if progress:
                progress(done, len(images))
    return results
