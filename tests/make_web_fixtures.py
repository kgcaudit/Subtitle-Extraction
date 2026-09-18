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
from pgs_writer import quantize_together                         # noqa: E402
from vobsub_writer import write_vobsub                           # noqa: E402

from subex.bitmap import prepare_for_ocr                          # noqa: E402
from subex.ocr import TesseractEngine, recognize_many              # noqa: E402
from subex.pgs import parse_sup                                    # noqa: E402
from subex.postprocess import tidy                                 # noqa: E402
from subex.srt import Cue, render_srt                              # noqa: E402
from subex.vobsub import parse_vobsub                              # noqa: E402

FIXTURES = ROOT / "web/test/fixtures"
KOREAN_FONTS = [
    "/usr/share/fonts/truetype/nanum/NanumGothic.ttf",
    "/Library/Fonts/AppleGothic.ttf",
    "C:/Windows/Fonts/malgun.ttf",
]
TEXTS = [
    "Hello world\nsecond line",
    "안녕하세요 자막입니다",
    "Mixed 한글 with English 2026",
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


def ocr_sup(path) -> list:
    """.sup 파일을 파이썬판으로 끝까지 처리한다(그림 해독 → 문자 인식 → 다듬기)."""
    cues = parse_sup(path)
    images = [prepare_for_ocr(cue.image) for cue in cues]
    texts = recognize_many(images, TesseractEngine(language="kor+eng"))
    return tidy([Cue(cue.start, cue.end, text) for cue, text in zip(cues, texts)],
                strip_styling=False)


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

    # --- 실제 블루레이 자막에 가까운 PGS ---
    # 글자 가장자리가 번진(안티에일리어싱) 여러 색, 노란 자막, 그리고 두 줄을
    # 각각 다른 객체로 얹는 경우까지 넣는다. 단순한 3색 자료로는 못 밟아 보는
    # 경로들이다.
    rich_entries = []
    rich_texts = [
        "이건 안티에일리어싱이 들어간 자막입니다",
        "노란 자막도 확인합니다",
        "두 줄을 따로 얹은 경우\n아래쪽 줄입니다",
    ]
    if font:
        for index, text in enumerate(rich_texts):
            start = 1000 + index * 3000
            if index == 2:
                top = render_text(text.split("\n")[0], 42, font)
                bottom = render_text(text.split("\n")[1], 42, font)
                rich_entries.append(
                    (start, start + 2500, [(top, (200, 890)), (bottom, (240, 975))], None)
                )
            else:
                color = (255, 235, 90) if index == 1 else (255, 255, 255)
                rich_entries.append(
                    (start, start + 2500, render_text(text, 44, font, fill=color), (160, 900))
                )

        rich = FIXTURES / "rich.sup"
        write_sup(rich, rich_entries, canvas=(1920, 1080))

    # --- MP4 (글자 자막 두 개) ---
    mp4 = FIXTURES / "sample.mp4"
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=c=0x402030:s=640x360:d=12:r=5",
            "-i", str(srt), "-i", str(srt),
            "-map", "0:v", "-map", "1:s", "-map", "2:s",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:s", "mov_text",
            "-metadata:s:s:0", "language=kor",
            "-metadata:s:s:1", "language=eng",
            str(mp4),
        ],
        check=True,
    )

    # --- 자막이 아예 없는 영상 (안내 문구를 시험하려고) ---
    subprocess.run(
        [
            "ffmpeg", "-v", "error", "-y",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:d=2:r=5",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            str(FIXTURES / "nosubs.mp4"),
        ],
        check=True,
    )

    # --- 파이썬판이 이 영상에서 내는 SRT (웹 전체 흐름의 정답지) ---
    for stale in FIXTURES.glob("expected.*.srt"):
        stale.unlink()
    expected_srt = {}
    for source, prefix in ((mkv, "expected"), (mp4, "expected.mp4")):
        subprocess.run(
            [sys.executable, "-m", "subex", str(source), "--outdir", str(FIXTURES),
             "--overwrite", "-q"],
            check=True,
            cwd=ROOT,
        )
        for produced in sorted(list(FIXTURES.glob("sample.*.srt")) + list(FIXTURES.glob("rich.*.srt"))):
            target = FIXTURES / f"{prefix}.{produced.name.split('.', 1)[1]}"
            produced.replace(target)
            expected_srt[target.name] = target.read_text(encoding="utf-8")

    if font:
        # .sup 을 명령줄로 돌리면 ffmpeg 이 시각을 0 부터로 옮겨 버린다. 웹은
        # 파일을 그대로 읽으므로, 정답지도 라이브러리로 바로 만들어 맞춘다.
        (FIXTURES / "expected.rich.srt").write_text(
            render_srt(ocr_sup(FIXTURES / "rich.sup")), encoding="utf-8", newline="\n"
        )

    golden = {
        "texts": texts,
        "expectedSrt": sorted(expected_srt),
        "hasKorean": font is not None,
        "pgsFromSup": dump_cues("pgs_sup", parse_sup(sup)),
        "pgsFromMkv": dump_cues("pgs_mkv", parse_sup(muxed_sup)),
        "vobsubFromIdx": dump_cues("vobsub_idx", parse_vobsub(idx)),
        "vobsubFromMkv": dump_cues("vobsub_mkv", parse_vobsub(mkv, sub_index=2)),
        "richTexts": rich_texts if font else [],
        "pgsRich": dump_cues("pgs_rich", parse_sup(FIXTURES / "rich.sup")) if font else [],
    }
    muxed_sup.unlink()

    (FIXTURES / "bitmaps.json").write_text(
        json.dumps(golden, ensure_ascii=False, indent=1), encoding="utf-8"
    )

    total = sum(len(golden[key]) for key in golden if key.startswith(("pgs", "vobsub")))
    print(f"기준 자료 완료: 그림 {total}장, {FIXTURES}")


if __name__ == "__main__":
    main()
