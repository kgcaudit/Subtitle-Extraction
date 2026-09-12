from subex.srt import Cue, format_timestamp, parse_srt, render_srt, write_srt


def test_format_timestamp():
    assert format_timestamp(0) == "00:00:00,000"
    assert format_timestamp(1) == "00:00:00,001"
    assert format_timestamp(3_661_234) == "01:01:01,234"
    assert format_timestamp(-5) == "00:00:00,000"      # 음수는 0 으로 눌러 준다


def test_parse_and_render_roundtrip():
    source = (
        "1\n00:00:01,000 --> 00:00:04,000\nHello\nworld\n\n"
        "2\n00:00:05,500 --> 00:00:08,000\n안녕하세요\n"
    )
    cues = parse_srt(source)
    assert cues == [Cue(1000, 4000, "Hello\nworld"), Cue(5500, 8000, "안녕하세요")]
    assert parse_srt(render_srt(cues)) == cues


def test_parse_tolerates_bom_crlf_and_dot_separator():
    source = "﻿1\r\n00:00:01.500 --> 00:00:02.5\r\n점 구분자\r\n"
    assert parse_srt(source) == [Cue(1500, 2500, "점 구분자")]


def test_parse_ignores_empty_bodies():
    source = "1\n00:00:01,000 --> 00:00:02,000\n\n\n2\n00:00:03,000 --> 00:00:04,000\n내용\n"
    assert parse_srt(source) == [Cue(3000, 4000, "내용")]


def test_write_srt_replaces_unencodable_characters(tmp_path):
    target = tmp_path / "out.srt"
    write_srt(target, [Cue(0, 1000, "한글 ✓ 기호")], encoding="cp949")
    text = target.read_text(encoding="cp949")
    assert "한글" in text and "✓" not in text          # 못 담는 글자만 대체된다


def test_write_srt_bom(tmp_path):
    target = tmp_path / "bom.srt"
    write_srt(target, [Cue(0, 1000, "x")], bom=True)
    assert target.read_bytes().startswith(b"\xef\xbb\xbf")


def test_parse_keeps_text_ending_with_digits():
    # 본문 마지막 줄이 숫자로 끝나도 다음 큐의 번호로 오인하면 안 된다.
    source = (
        "1\n00:00:01,000 --> 00:00:02,000\nMixed 한글 and English 2026\n\n"
        "2\n00:00:03,000 --> 00:00:04,000\n2026\n\n"
        "3\n00:00:05,000 --> 00:00:06,000\n끝\n"
    )
    assert [cue.text for cue in parse_srt(source)] == ["Mixed 한글 and English 2026", "2026", "끝"]
