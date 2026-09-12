"""명령줄 동작 전체 흐름 검증."""

import pytest

from conftest import needs_ffmpeg, needs_tesseract
from subex.cli import main
from subex.probe import probe_subtitles
from subex.srt import parse_srt


@needs_ffmpeg
def test_probe_lists_every_track(media):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    tracks = probe_subtitles(media["mkv"])
    assert [track.codec for track in tracks] == ["subrip", "hdmv_pgs_subtitle", "dvd_subtitle"]
    assert [track.kind for track in tracks] == ["text", "bitmap", "bitmap"]
    assert tracks[2].forced and tracks[2].slug() == "kor.forced"


@needs_ffmpeg
def test_list_mode_writes_nothing(media, tmp_path, capsys):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    assert main([str(media["mkv"]), "--list"]) == 0
    assert "PGS" in capsys.readouterr().out
    assert not list(tmp_path.glob("*.srt"))


@needs_ffmpeg
def test_text_track_extraction(media, tmp_path):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    target = tmp_path / "out.srt"
    assert main([str(media["mkv"]), "-t", "0", "-o", str(target), "-q"]) == 0
    assert [cue.text for cue in parse_srt(target.read_text(encoding="utf-8"))] == media["texts"]


@needs_ffmpeg
@needs_tesseract
def test_bitmap_tracks_are_ocred(media, tmp_path):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    assert main([str(media["mkv"]), "--outdir", str(tmp_path), "-q"]) == 0

    produced = sorted(path.name for path in tmp_path.glob("*.srt"))
    assert produced == ["multi.eng.srt", "multi.kor.forced.srt", "multi.kor.srt"]

    for name in produced:
        cues = parse_srt((tmp_path / name).read_text(encoding="utf-8"))
        assert [cue.text for cue in cues] == media["texts"]


@needs_ffmpeg
def test_language_filter(media, tmp_path):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    main([str(media["mkv"]), "--lang", "eng", "--outdir", str(tmp_path), "-q"])
    assert sorted(path.name for path in tmp_path.glob("*.srt")) == ["multi.eng.srt"]


@needs_ffmpeg
def test_refuses_to_overwrite_without_flag(media, tmp_path):
    if "mkv" not in media:
        pytest.skip("mkv 픽스처 없음")
    target = tmp_path / "multi.eng.srt"
    target.write_text("기존 내용", encoding="utf-8")
    assert main([str(media["mkv"]), "-t", "0", "--outdir", str(tmp_path), "-q"]) != 0
    assert target.read_text(encoding="utf-8") == "기존 내용"

    assert main([str(media["mkv"]), "-t", "0", "--outdir", str(tmp_path), "--overwrite", "-q"]) == 0
    assert target.read_text(encoding="utf-8") != "기존 내용"


def test_missing_file_is_reported(tmp_path, capsys):
    assert main([str(tmp_path / "없는파일.mkv"), "-q"]) == 1
    assert "찾을 수 없습니다" in capsys.readouterr().err


@needs_ffmpeg
def test_no_subtitle_track_is_reported(tmp_path, capsys):
    import subprocess

    plain = tmp_path / "plain.mp4"
    subprocess.run(
        ["ffmpeg", "-v", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1:r=5",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(plain)],
        check=True,
    )
    assert main([str(plain), "-q"]) == 0
    assert "자막 트랙이 없습니다" in capsys.readouterr().err
