"""웹판(자바스크립트)을 대조할 기준 자료를 만든다.

파이썬판은 실제 영상으로 검증을 끝낸 구현이므로 이쪽을 '정답지'로 삼는다.
자막 파일과 영상을 만들고, 파이썬판이 해독한 그림을 픽셀 그대로 떠 놓는다.
웹 쪽 테스트가 같은 입력에서 같은 픽셀을 만들어 내는지 확인한다.

    python3 tests/make_web_fixtures.py

결과: web/test/fixtures/
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tests"))

from pgs_writer import quantize, render_text, write_sup          # noqa: E402
from vobsub_writer import write_vobsub                           # noqa: E402

from subex.pgs import parse_sup                                   # noqa: E402
from subex.vobsub import parse_vobsub                             # noqa: E402

FIXTURES = ROOT / "web/test/fixtures"
KOREAN_FONTS = [
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/Library/Fonts/AppleGothic.ttf",
    "C:/Windows/Fonts/malgun.ttf",
]
TEXTS = [
    "Hello world\nsecond line",
    "안녕하세요 자막입니다",
    "Mixed 한글 and English 2026",
]


def korean_font() -> str | None:
    for path in KOREAN_FONTS:
        if Path(path).exists():
            return path
    return None


def dump_cues(name: str, cues) -> list[dict]:
    """해독한 그림을 RGBA 원본 그대로 떠 놓는다."""
    records = []
    for index, cue in enumerate(cues):
        image = cue.image.convert("RGBA")
        blob = FIXTURES / f"{name}.{index}.rgba"
        blob.write_bytes(image.tobytes())
        records.append(
            {
                "startMs": cue.start,
                "endMs": cue.end,
                "width": image.width,
                "height": image.height,
                "rgba": blob.name,
            }
        )
    return records


def main() -> None:
    FIXTURES.mkdir(parents=True, exist_ok=True)
    font = korean_font()
    texts = TEXTS if font else [line for line in TEXTS if line.isascii()]

    # --- 자막 원본 만들기 ---
    srt = FIXTURES / "sample.srt"
    srt.write_text(
        "".join(
            f"{index + 1}\n"
            f"00:00:0{index * 3 + 1},000 --> 00:00:0{index * 3 + 3},500\n{text}\n\n"
            for index, text in enumerate(texts)
        ),
        encoding="utf-8",
    )

    pgs_entries = []
    vob_entries = []
    for index, text in enumerate(texts):
        start = 1000 + index * 3000
        pgs_entries.append((start, start + 2500, render_text(text, 44, font), (120, 900)))
        small = render_text(text, 28, font)
        plane, _ = quantize(small)
        vob_entries.append((start, start + 2500, plane, small.width, small.height, (40, 330)))

    sup = FIXTURES / "sample.sup"
    write_sup(sup, pgs_entries, canvas=(1920, 1080))
    idx, sub = FIXTURES / "sample.idx", FIXTURES / "sample.sub"
    write_vobsub(idx, sub, vob_entries, size=(720, 480))

    # --- 세 종류 자막이 든 영상 ---
    mkv = FIXTURES / "sample.mkv"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=c=0x203040:s=640x360:d=12:r=5",
            "-i", str(srt), "-i", str(sup), "-i", str(idx),
            "-map", "0:v", "-map", "1:s", "-map", "2:s", "-map", "3:s",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:s", "copy",
            "-metadata:s:s:0", "language=eng",
            "-metadata:s:s:1", "language=kor",
            "-metadata:s:s:2", "language=kor",
            "-disposition:s:2", "forced",
            str(mkv),
        ],
        check=True,
    )

    # --- 영상 안의 PGS 를 다시 뽑아 해독 (웹판이 보게 될 것과 같은 시각) ---
    muxed_sup = FIXTURES / "sample.muxed.sup"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-i", str(mkv), "-map", "0:s:1", "-c:s", "copy", str(muxed_sup)],
        check=True,
    )

    # --- 파이썬판이 이 영상에서 내는 SRT (웹 전체 흐름의 정답지) ---
    for stale in FIXTURES.glob("expected.*.srt"):
        stale.unlink()
    subprocess.run(
        [sys.executable, "-m", "subex", str(mkv), "--outdir", str(FIXTURES), "--overwrite", "-q"],
        check=True,
        cwd=ROOT,
    )
    expected_srt = {}
    for produced in sorted(FIXTURES.glob("sample.*.srt")):
        target = FIXTURES / f"expected.{produced.name.split('.', 1)[1]}"
        produced.replace(target)
        expected_srt[target.name] = target.read_text(encoding="utf-8")

    golden = {
        "texts": texts,
        "expectedSrt": sorted(expected_srt),
        "hasKorean": font is not None,
        "pgsFromSup": dump_cues("pgs_sup", parse_sup(sup)),
        "pgsFromMkv": dump_cues("pgs_mkv", parse_sup(muxed_sup)),
        "vobsubFromIdx": dump_cues("vobsub_idx", parse_vobsub(idx)),
        "vobsubFromMkv": dump_cues("vobsub_mkv", parse_vobsub(mkv, sub_index=2)),
    }
    muxed_sup.unlink()

    (FIXTURES / "bitmaps.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    total = sum(len(golden[key]) for key in golden if key.startswith(("pgs", "vobsub")))
    print(f"기준 자료 완료: 그림 {total}장, {FIXTURES}")


if __name__ == "__main__":
    main()
