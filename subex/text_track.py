"""텍스트 자막 트랙(SubRip/ASS/mov_text/WebVTT 등)을 SRT 로 옮긴다."""

from __future__ import annotations

from pathlib import Path

from subex.ffmpeg import FFmpegError, run
from subex.srt import Cue, parse_srt

__all__ = ["extract_text_track"]


def extract_text_track(source, track, workdir: Path) -> list[Cue]:
    """ffmpeg 로 SRT 를 뽑아 Cue 목록으로 읽어 온다.

    바로 최종 파일로 쓰지 않고 한 번 파싱하는 이유는, 이미지 자막 경로와
    똑같은 후처리·인코딩 선택을 거치게 하기 위해서다.
    """
    target = workdir / f"track{track.index}.srt"
    try:
        run([
            "ffmpeg", "-v", "error", "-y",
            "-i", str(source),
            "-map", f"0:{track.index}",
            "-c:s", "srt",
            str(target),
        ])
    except FFmpegError as error:
        raise FFmpegError(
            f"트랙 #{track.sub_index}({track.codec}) 을 SRT 로 변환하지 못했습니다.\n{error}"
        ) from error

    if not target.exists():
        return []
    return parse_srt(target.read_text(encoding="utf-8", errors="replace"))
