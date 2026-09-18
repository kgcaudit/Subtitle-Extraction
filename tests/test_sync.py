"""자막 시각이 화면과 맞는지.

자막은 영상과 같은 시간축 위에 있어야 한다. ffmpeg 에게 그냥 맡기면 출력이 0 에서
시작하도록 **모든 스트림 중 가장 이른 것** 에 맞춰 전체를 미는데, AAC 소리는 앞에
준비 구간이 있어 -0.023초에서 시작하는 일이 흔하다. 그러면 화면은 0 에서 시작하는데
자막만 23밀리초 늦어진다(실측).
"""

from __future__ import annotations

from pathlib import Path

from subex.extract import _is_standalone_subtitle, _presentation_offset
from subex.probe import decide_presentation_offset


def test_offset_follows_the_video_track():
    """기준은 영상이 시작하는 시각이다. 소리의 준비 구간에 끌려가지 않는다."""
    streams = [
        {"codec_type": "video", "start_time": "0.000000"},
        {"codec_type": "audio", "start_time": "-0.023000"},
        {"codec_type": "subtitle", "start_time": "0.000000"},
    ]
    assert decide_presentation_offset(streams, "-0.023000") == 0, \
        "AAC 준비 구간 때문에 자막이 23밀리초 밀리면 안 된다"


def test_offset_handles_a_stream_that_starts_late():
    """방송 스트림(MPEG-TS)처럼 한참 뒤에서 시작하는 파일도 화면 기준으로 맞춘다."""
    streams = [{"codec_type": "video", "start_time": "36000.000000"}]
    assert decide_presentation_offset(streams, "36000.000000") == 36_000_000


def test_offset_without_a_video_track():
    """영상이 없으면 컨테이너의 시작 시각을 쓰되, 음수는 0 으로 본다."""
    assert decide_presentation_offset([{"codec_type": "audio", "start_time": "-0.023000"}],
                                      "-0.023000") == 0
    assert decide_presentation_offset([{"codec_type": "audio", "start_time": "36000.0"}],
                                      "36000.0") == 36_000_000
    assert decide_presentation_offset(None, None) == 0


def test_standalone_subtitle_files_keep_their_own_times(tmp_path):
    """자막만 든 파일(.sup, .idx)은 이미 영화 시간축 위에 있어 건드리지 않는다.

    여기서 기준을 빼 버리면 블루레이 자막이 53초 앞당겨진다. 실제로 그런 적이 있다.
    """
    sup = tmp_path / "movie.sup"
    sup.write_bytes(b"PG" + bytes(64))
    idx = tmp_path / "movie.idx"
    idx.write_text("# VobSub index file\ntimestamp: 00:00:01:000, filepos: 000000000\n")

    assert _is_standalone_subtitle(sup)
    assert _is_standalone_subtitle(idx)
    assert _presentation_offset(sup) == 0
    assert _presentation_offset(idx) == 0
