"""VobSub(.idx/.sub, dvd_subtitle) 파서 검증."""

import subprocess

import pytest
from PIL import Image

from conftest import needs_ffmpeg, needs_tesseract
from pgs_writer import quantize, render_text
from subex.bitmap import prepare_for_ocr
from subex.vobsub import decode_spu, parse_idx_palette, parse_vobsub
from vobsub_writer import build_spu


def test_parse_idx_palette():
    text = "size: 720x480\npalette: 000000, ffffff, ff0000, 0000ff\n"
    palette = parse_idx_palette(text)
    assert palette[:4] == [(0, 0, 0), (255, 255, 255), (255, 0, 0), (0, 0, 255)]
    assert len(palette) == 16          # 모자란 자리는 채워 준다


def test_parse_idx_palette_without_line_falls_back():
    assert len(parse_idx_palette("size: 720x480\n")) == 16


def test_spu_roundtrip_preserves_shape():
    width, height = 40, 12
    plane = bytearray(width * height)
    for row in range(2, height - 2):
        for column in range(5, width - 5):
            plane[row * width + column] = 1          # 가운데 사각형

    spu = build_spu(bytes(plane), width, height, (10, 20), 2000)
    decoded = decode_spu(spu, [(0, 0, 0), (255, 255, 255), (0, 0, 0)] + [(0, 0, 0)] * 13)
    assert decoded is not None

    image, start_delay, stop_delay = decoded
    assert start_delay == 0
    assert abs(stop_delay - 2000) <= 12              # delay 단위(1024/90ms) 반올림 오차
    assert image.size == (width - 10, height - 4)    # 투명 여백은 잘려 나간다


def test_decode_spu_rejects_garbage():
    assert decode_spu(b"", []) is None
    assert decode_spu(b"\x00\x04\xff\xff", []) is None


@needs_ffmpeg
def test_fixture_is_readable_by_ffmpeg(media, tmp_path):
    """픽스처가 규격에 맞는지 ffmpeg 의 dvdsub 디코더로 교차 확인한다."""
    burned = tmp_path / "burned.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=c=black:s=720x480:d=12:r=5",
         "-i", str(media["idx"]),
         "-filter_complex", "[0:v][1:s]overlay[v]", "-map", "[v]",
         "-ss", "2", "-frames:v", "1", str(burned)],
        check=True,
    )
    assert Image.open(burned).convert("L").getextrema()[1] > 200


@needs_ffmpeg
def test_parse_from_idx_file(media):
    cues = parse_vobsub(media["idx"])
    assert len(cues) == len(media["texts"])
    assert [cue.start for cue in cues] == [1000 + index * 3000 for index in range(len(cues))]
    assert all(cue.end > cue.start for cue in cues)


@needs_ffmpeg
def test_parse_from_container_matches_standalone(media):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    from_idx = parse_vobsub(media["idx"])
    from_mkv = parse_vobsub(media["mkv"], sub_index=2)
    assert [(cue.start, cue.end, cue.image.size) for cue in from_idx] == \
           [(cue.start, cue.end, cue.image.size) for cue in from_mkv]


@needs_ffmpeg
@needs_tesseract
def test_end_to_end_text(media, font):
    from subex.ocr import TesseractEngine

    cues = parse_vobsub(media["idx"])
    engine = TesseractEngine(language="kor+eng" if font else "eng")
    recognized = [engine.recognize(prepare_for_ocr(cue.image)) for cue in cues]
    assert recognized == media["texts"]
