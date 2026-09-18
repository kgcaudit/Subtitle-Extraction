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


def test_large_text_is_shrunk_small_text_is_not():
    """글자가 크면 줄여서 인식기에 넣는다. 작은 글자는 건드리지 않는다.

    실측에서 크게 넣을수록 나빠졌다(ㅈ 을 ㅅ 으로 읽는 실수가 특히 늘었다).
    그렇다고 작은 글자를 키우면 그것도 손해라 줄이기만 한다.
    """
    from PIL import Image

    from subex.bitmap import prepare_for_ocr, text_line_height

    def block(line_height: int, gap: int, lines: int) -> Image.Image:
        """글자처럼 — 줄마다 세로획 몇 개, 줄 사이는 빈칸.

        꽉 채우면 잉크가 너무 많아 전처리가 색을 한 번 더 뒤집는다.
        """
        height = lines * line_height + (lines - 1) * gap
        image = Image.new("RGBA", (60, height), (0, 0, 0, 0))
        for line in range(lines):
            top = line * (line_height + gap)
            for row in range(line_height):
                for base in (8, 24, 40):
                    for dx in range(3):
                        image.putpixel((base + dx, top + row), (255, 255, 255, 255))
        return image

    big = block(80, 20, 2)
    assert text_line_height(prepare_for_ocr(big, target_line_height=None, margin=0)) == 80
    shrunk = prepare_for_ocr(big, margin=0, straighten=False)
    assert shrunk.height < big.height, "큰 글자는 줄어들어야 한다"

    small = block(20, 10, 2)
    assert prepare_for_ocr(small, margin=0, straighten=False).size == small.size, (
        "작은 글자는 그대로여야 한다"
    )


def test_lines_are_split_and_music_note_is_recovered():
    """자막은 줄마다 갈라 인식기에 넣고, 음표(♪)는 그림에서 찾아 되살린다.

    인식기의 글자 목록에 ♪ 가 아예 없어서(한국어 1158자·영어 112자) 글자로는
    절대 못 얻는다. 실제 영화 한 편에서 한 번도 못 읽었고 대신 》 ^ _ 같은
    엉뚱한 글자가 나왔다. 그래서 그림에서 직접 찾는다.
    """
    from pathlib import Path

    from PIL import Image, ImageDraw, ImageFont

    from subex.bitmap import prepare_lines

    fonts = [
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ]
    path = next((p for p in fonts if Path(p).exists()), None)
    if path is None:
        pytest.skip("♪ 를 가진 글꼴이 없습니다")

    font = ImageFont.truetype(path, 40)

    def draw(lines: list[str]) -> Image.Image:
        image = Image.new("RGBA", (260, 60 * len(lines) + 20), (0, 0, 0, 0))
        pen = ImageDraw.Draw(image)
        for index, line in enumerate(lines):
            pen.text((10, 10 + index * 60), line, font=font, fill=(255, 255, 255, 255))
        return image

    # 줄 수만큼 갈린다.
    for count in (1, 2, 3):
        prepared = prepare_lines(draw(["abc"] * count), straighten=False)
        assert len(prepared) == count
        assert all(line.prefix == "" for line in prepared)

    # 음표는 찾아서 떼어 내고 앞에 붙일 글자로 돌려준다.
    with_note = prepare_lines(draw(["♪ abc"]), straighten=False)
    assert len(with_note) == 1
    assert with_note[0].prefix == "♪"

    # 그냥 글자는 음표로 보면 안 된다.
    assert prepare_lines(draw(["abc"]), straighten=False)[0].prefix == ""
    assert prepare_lines(draw(["♪ abc"]), straighten=False, find_notes=False)[0].prefix == ""
