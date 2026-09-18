"""PGS(.sup) 파서 검증.

픽스처는 tests/pgs_writer.py 가 규격대로 만든다. 그 픽스처 자체가 옳은지는
ffmpeg 의 독립 구현(pgssub 디코더)이 같은 그림을 그려 내는지로 확인한다.
"""

import subprocess

import pytest
from PIL import Image

from conftest import needs_ffmpeg, needs_tesseract
from pgs_writer import encode_rle, render_text, write_sup
from subex.bitmap import prepare_for_ocr
from subex.pgs import _PTS_HZ, decode_rle, parse_sup


@pytest.mark.parametrize(
    "plane, width, height",
    [
        (bytes([0] * 20), 20, 1),                                  # 전부 배경
        (bytes([1] * 20), 20, 1),                                  # 전부 한 색
        (bytes([0, 1, 2, 1, 0] * 4), 20, 1),                       # 잦은 색 전환
        (bytes([0] * 100 + [2] * 100), 200, 1),                    # 긴 런
        (bytes([1] * 600), 300, 2),                                # 64 이상 런 + 여러 줄
    ],
)
def test_rle_roundtrip(plane, width, height):
    assert decode_rle(encode_rle(plane, width, height), width, height) == plane


def test_rle_roundtrip_on_real_glyphs():
    image = render_text("Wg|1lI0O", 40)
    raw = image.convert("RGBA").tobytes()
    plane = bytes(
        0 if raw[offset + 3] < 128 else (1 if sum(raw[offset : offset + 3]) / 3 >= 128 else 2)
        for offset in range(0, len(raw), 4)
    )
    encoded = encode_rle(plane, image.width, image.height)
    assert decode_rle(encoded, image.width, image.height) == plane


def test_decode_rle_survives_truncated_data():
    # 잘린 데이터를 만나도 예외 없이 그때까지 푼 만큼을 돌려준다.
    assert len(decode_rle(b"\x00\xc1", 10, 2)) == 20


def test_parse_sup_timings_and_crop(tmp_path, font):
    image = render_text("타이밍 확인" if font else "timing check", 40, font)
    target = tmp_path / "t.sup"
    write_sup(target, [(1000, 4000, image, (200, 800)), (5000, 6500, image, (200, 800))])

    cues = parse_sup(target)
    assert [(cue.start, cue.end) for cue in cues] == [(1000, 4000), (5000, 6500)]
    # 캔버스(1920x1080)가 아니라 글자 주변으로 잘려 있어야 한다.
    assert cues[0].image.size[0] <= image.width and cues[0].image.size[1] <= image.height


def test_parse_sup_keeps_absolute_start_time(tmp_path, font):
    """영화 한참 뒤에서 시작하는 .sup 은 그 시각을 그대로 지켜야 한다.

    .sup 은 담는 그릇이 없어서 파일의 시작 시각이 곧 첫 자막이 나오는 시각이다.
    ffmpeg 을 거쳐 다시 쓰면 출력이 0 에서 시작하도록 시각을 당겨 버려서, 실제
    블루레이 자막 하나가 통째로 53.072초 빨라진 적이 있다. 그래서 .sup 은
    ffmpeg 을 거치지 않고 바로 읽는다.
    """
    from subex.extract import _is_raw_sup, _read_bitmap_cues
    from subex.probe import SubtitleTrack

    image = render_text("늦게 시작" if font else "late start", 40, font)
    target = tmp_path / "late.sup"
    write_sup(target, [(53136, 55472, image, (200, 800))])

    assert _is_raw_sup(target), ".sup 은 앞 두 바이트가 'PG' 다"

    track = SubtitleTrack(index=0, sub_index=0, codec="hdmv_pgs_subtitle", language=None,
                          title=None, default=True, forced=False, hearing_impaired=False)
    cues = _read_bitmap_cues(target, track, tmp_path)
    assert (cues[0].start, cues[0].end) == (53136, 55472)


def test_pts_to_milliseconds_rounds_like_the_web(tmp_path, font):
    """90kHz 눈금을 밀리초로 바꿀 때 버리지 말고 반올림한다.

    버리면 웹판(Math.round)과 자막 절반의 시각이 1밀리초씩 어긋난다. DVD 자막은
    .idx 에 시각이 이미 밀리초로 적혀 있어 이 차이가 드러나지 않았고, 실제
    블루레이 자막을 넣고서야 1,592줄 중 794줄이 어긋나는 것이 보였다.

    픽스처는 밀리초를 90 배해 눈금으로 적으므로 그대로는 나머지가 없다. 그래서
    적어 놓은 PTS 를 반 눈금(45)씩 밀어 버림과 반올림이 갈리는 자리를 만든다.
    """
    image = render_text("반올림" if font else "rounding", 40, font)
    target = tmp_path / "r.sup"
    write_sup(target, [(1000, 2000, image, (10, 10))])

    blob = bytearray(target.read_bytes())
    offset = 0
    while offset + 13 <= len(blob) and blob[offset:offset + 2] == b"PG":
        pts = int.from_bytes(blob[offset + 2:offset + 6], "big")
        if pts:                                   # 0 인 것(첫 PDS 등)은 그대로 둔다
            blob[offset + 2:offset + 6] = (pts + _PTS_HZ // 2000).to_bytes(4, "big")
        offset += 13 + int.from_bytes(blob[offset + 11:offset + 13], "big")
    target.write_bytes(blob)

    # 1000.5ms, 2000.5ms → 반올림하면 1001, 2001. 버리면 1000, 2000 이 된다.
    assert [(c.start, c.end) for c in parse_sup(target)] == [(1001, 2001)]


def test_parse_sup_ignores_trailing_garbage(tmp_path):
    target = tmp_path / "g.sup"
    write_sup(target, [(1000, 3000, render_text("abc", 36), (10, 10))])
    with open(target, "ab") as handle:
        handle.write(b"\x00" * 64)              # 뒤에 붙은 쓰레기
    assert len(parse_sup(target)) == 1


@needs_ffmpeg
def test_fixture_is_readable_by_ffmpeg(tmp_path):
    """픽스처가 규격에 맞는지 ffmpeg 의 PGS 디코더로 교차 확인한다."""
    target = tmp_path / "x.sup"
    write_sup(target, [(1000, 4000, render_text("CROSSCHECK", 48), (300, 500))])

    burned = tmp_path / "burned.png"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y",
         "-f", "lavfi", "-i", "color=c=black:s=1920x1080:d=5:r=5",
         "-i", str(target),
         "-filter_complex", "[0:v][1:s]overlay[v]", "-map", "[v]",
         "-ss", "2", "-frames:v", "1", str(burned)],
        check=True,
    )
    rendered = Image.open(burned).convert("L")
    # 완전히 검은 배경 위에 흰 글자가 얹혔다면 밝은 픽셀이 있어야 한다.
    assert rendered.getextrema()[1] > 200


@needs_tesseract
def test_end_to_end_text(tmp_path, font):
    from subex.ocr import TesseractEngine

    text = "안녕하세요 자막입니다" if font else "hello subtitle"
    language = "kor" if font else "eng"
    target = tmp_path / "e.sup"
    write_sup(target, [(1000, 4000, render_text(text, 44, font), (200, 800))])

    cues = parse_sup(target)
    recognized = TesseractEngine(language=language).recognize(prepare_for_ocr(cues[0].image))
    assert recognized == text
