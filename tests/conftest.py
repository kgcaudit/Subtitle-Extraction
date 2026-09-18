"""테스트용 자막/영상 자료를 만들어 두는 픽스처.

ffmpeg 는 텍스트 자막을 비트맵 자막으로 바꾸지 못하므로, PGS/VobSub 자료는
tests/pgs_writer.py · tests/vobsub_writer.py 가 규격대로 직접 만든다.
"""

from __future__ import annotations

import shutil
import sys
import subprocess
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

from pgs_writer import quantize, render_text, write_sup       # noqa: E402
from vobsub_writer import write_vobsub                        # noqa: E402

KOREAN_FONTS = [
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/Library/Fonts/AppleGothic.ttf",
    "C:/Windows/Fonts/malgun.ttf",
]

SAMPLE_LINES = [
    "Hello world\nsecond line",
    "안녕하세요 자막입니다",
    "Mixed 한글 with English 2026",
]

needs_ffmpeg = pytest.mark.skipif(
    not (shutil.which("ffmpeg") and shutil.which("ffprobe")), reason="ffmpeg/ffprobe 없음"
)
needs_tesseract = pytest.mark.skipif(not shutil.which("tesseract"), reason="tesseract 없음")


def korean_font() -> str | None:
    for path in KOREAN_FONTS:
        if Path(path).exists():
            return path
    return None


@pytest.fixture(scope="session")
def font() -> str | None:
    return korean_font()


@pytest.fixture(scope="session")
def media(tmp_path_factory, font) -> dict:
    """테스트에서 쓰는 자막/영상 파일 모음."""
    root = tmp_path_factory.mktemp("media")
    texts = SAMPLE_LINES if font else [line for line in SAMPLE_LINES if line.isascii()]

    # --- SRT ---
    srt = root / "plain.srt"
    srt.write_text(
        "".join(
            f"{index + 1}\n"
            f"00:00:0{index * 3 + 1},000 --> 00:00:0{index * 3 + 3},500\n"
            f"{text}\n\n"
            for index, text in enumerate(texts)
        ),
        encoding="utf-8",
    )

    # --- PGS ---
    entries = []
    vob_entries = []
    for index, text in enumerate(texts):
        image = render_text(text, 44, font)
        start = 1000 + index * 3000
        entries.append((start, start + 2500, image, (120, 900)))

        small = render_text(text, 28, font)
        plane, _ = quantize(small)
        vob_entries.append((start, start + 2500, plane, small.width, small.height, (40, 330)))

    sup = root / "sample.sup"
    write_sup(sup, entries, canvas=(1920, 1080))

    idx, sub = root / "sample.idx", root / "sample.sub"
    write_vobsub(idx, sub, vob_entries, size=(720, 480))

    result = {"root": root, "srt": srt, "sup": sup, "idx": idx, "sub": sub, "texts": texts}

    if shutil.which("ffmpeg"):
        mkv = root / "multi.mkv"
        subprocess.run(
            [
                "ffmpeg", "-v", "error", "-y",
                "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:d=12:r=5",
                "-i", str(srt), "-i", str(sup), "-i", str(idx),
                "-map", "0:v", "-map", "1:s", "-map", "2:s", "-map", "3:s",
                "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
                "-c:s", "copy",
                "-metadata:s:s:0", "language=eng",
                "-metadata:s:s:1", "language=kor",
                "-metadata:s:s:2", "language=kor",
                "-disposition:s:2", "forced",
                str(mkv),
            ],
            check=True,
        )
        result["mkv"] = mkv

    return result
