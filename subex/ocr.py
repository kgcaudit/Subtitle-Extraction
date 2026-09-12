"""Tesseract 를 이용한 자막 비트맵 문자 인식."""

from __future__ import annotations

import io
import os
import subprocess
from concurrent.futures import ThreadPoolExecutor

from PIL import Image

from subex.ffmpeg import ToolMissing, require, run

__all__ = ["TesseractEngine", "available_languages", "recognize_many"]


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
