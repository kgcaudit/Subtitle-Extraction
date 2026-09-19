"""텍스트 자막 트랙(SubRip/ASS/mov_text/WebVTT 등)을 SRT 로 옮긴다."""

from __future__ import annotations

from pathlib import Path

from subex.ffmpeg import FFmpegError, run
from subex.srt import Cue, parse_srt

__all__ = ["extract_text_track", "read_text_tracks"]


def read_text_tracks(source, tracks, workdir: Path) -> dict[int, list[Cue]]:
    """여러 글자 자막 트랙을 **ffmpeg 한 번으로** 꺼낸다.

    트랙마다 따로 부르면 그때마다 영상 파일을 처음부터 다시 읽는다. ffmpeg 은 출력
    여러 개를 한 번에 받으므로, 한 번 읽으며 트랙을 동시에 뽑아 낼 수 있다
    (mkvextract 도 같은 방식이다).

    -copyts 로 시각을 그대로 꺼낸다. 이게 없으면 ffmpeg 이 출력을 0 에서
    시작시키려고 **모든 스트림 중 가장 이른 것** 에 맞춰 전체를 미는데, AAC 소리의
    준비 구간(-0.023초) 때문에 자막이 통째로 23밀리초 늦어진다. 화면 기준으로
    다시 맞추는 일은 extract.py 가 한다.

    돌려주는 값은 {스트림 번호: Cue 목록}.
    """
    tracks = list(tracks)
    if not tracks:
        return {}

    args = ["ffmpeg", "-v", "error", "-y", "-copyts", "-i", str(source)]
    targets: dict[int, Path] = {}
    for track in tracks:
        target = workdir / f"track{track.index}.srt"
        targets[track.index] = target
        args += ["-map", f"0:{track.index}", "-c:s", "srt", str(target)]

    try:
        run(args)
    except FFmpegError as error:
        names = ", ".join(f"#{track.sub_index}({track.codec})" for track in tracks)
        raise FFmpegError(f"트랙 {names} 을 SRT 로 변환하지 못했습니다.\n{error}") from error

    return {
        index: parse_srt(target.read_text(encoding="utf-8", errors="replace"))
        for index, target in targets.items() if target.exists()
    }


def extract_text_track(source, track, workdir: Path) -> list[Cue]:
    """ffmpeg 로 SRT 를 뽑아 Cue 목록으로 읽어 온다.

    바로 최종 파일로 쓰지 않고 한 번 파싱하는 이유는, 이미지 자막 경로와
    똑같은 후처리·인코딩 선택을 거치게 하기 위해서다.

    -copyts 로 시각을 그대로 꺼낸다. 이게 없으면 ffmpeg 이 출력을 0 에서
    시작시키려고 **모든 스트림 중 가장 이른 것** 에 맞춰 전체를 미는데, AAC 소리의
    준비 구간(-0.023초) 때문에 자막이 통째로 23밀리초 늦어진다. 화면 기준으로
    다시 맞추는 일은 extract.py 가 한다.
    """
    target = workdir / f"track{track.index}.srt"
    try:
        run([
            "ffmpeg", "-v", "error", "-y", "-copyts",
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
