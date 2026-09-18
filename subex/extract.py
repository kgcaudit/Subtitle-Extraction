"""자막 트랙 하나를 SRT 큐 목록으로 만드는 전체 흐름."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from subex.bitmap import BitmapCue, measure_line_height, prepare_lines
from subex.ffmpeg import run
from subex.ocr import TesseractEngine, pick_language, recognize_many
from subex.pgs import parse_sup
from subex.postprocess import tidy
from subex.probe import SubtitleTrack, presentation_offset_ms
from subex.srt import Cue
from subex.text_track import extract_text_track
from subex.vobsub import parse_vobsub

__all__ = ["ExtractOptions", "extract_track"]


@dataclass
class ExtractOptions:
    #: "auto" 를 주면 앞부분을 살펴보고 'kor' 과 'kor+eng' 중에서 고른다.
    ocr_language: str = "auto"
    psm: int = 7
    jobs: int | None = None
    strip_styling: bool = True
    line_height: int = 28
    on_progress: object = None       # callable(stage: str, done: int, total: int)
    on_language: object = None       # callable(choice: LanguageChoice)


def _notify(options: ExtractOptions, stage: str, done: int, total: int) -> None:
    if options.on_progress:
        options.on_progress(stage, done, total)


def _is_raw_sup(source: Path) -> bool:
    """이미 PGS 스트림 그 자체인 파일인가(.sup). 앞 두 바이트가 'PG' 다."""
    try:
        with open(source, "rb") as handle:
            return handle.read(2) == b"PG"
    except OSError:
        return False


def _read_bitmap_cues(source: Path, track: SubtitleTrack, workdir: Path) -> list[BitmapCue]:
    if track.codec == "hdmv_pgs_subtitle":
        # .sup 파일은 그대로 읽는다. ffmpeg 을 거치면 시각이 어긋난다.
        #
        # .sup 은 담는 그릇이 따로 없어서 파일의 시작 시각이 곧 '첫 자막이 나오는
        # 시각' 이다. ffmpeg 은 출력이 0 에서 시작하도록 시각을 당겨 쓰므로, 그
        # 값만큼 자막 전체가 앞당겨진다(실측: 어떤 블루레이 자막이 53.072초 빨라짐).
        if _is_raw_sup(source):
            return parse_sup(source)

        # -copyts: 시각을 건드리지 말고 그대로 꺼내라. 기준 맞추기는 우리가 한다
        # (아래 _presentation_offset 참고).
        target = workdir / f"track{track.index}.sup"
        run([
            "ffmpeg", "-v", "error", "-y", "-copyts",
            "-i", str(source), "-map", f"0:{track.index}", "-c:s", "copy", str(target),
        ])
        return parse_sup(target)

    if track.codec == "dvd_subtitle":
        return parse_vobsub(source, track.sub_index)

    raise ValueError(f"이 프로젝트가 비트맵을 복원할 수 없는 코덱입니다: {track.codec}")


def _is_standalone_subtitle(source: Path) -> bool:
    """자막만 든 파일인가(.sup, .idx). 이런 파일은 시각이 이미 제 값이다."""
    return _is_raw_sup(source) or source.suffix.lower() == ".idx"


def _presentation_offset(source: Path) -> int:
    """이 파일에서 '재생 0초' 에 해당하는 시각(밀리초).

    자막이 화면과 맞으려면 영상이 시작하는 시각을 0 으로 잡아야 한다. 자세한
    내용은 subex.probe.presentation_offset_ms 참고.

    자막만 든 파일(.sup, .idx)은 그 자체가 이미 영화 시간축 위에 있으므로
    건드리지 않는다 — 여기서 빼 버리면 블루레이 자막이 53초 앞당겨진다.
    """
    if _is_standalone_subtitle(source):
        return 0
    return presentation_offset_ms(source)


def _shift(cues: list[Cue], offset: int) -> list[Cue]:
    if not offset:
        return cues
    for cue in cues:
        cue.start -= offset
        cue.end -= offset
    return cues


def extract_track(source, track: SubtitleTrack, workdir: Path,
                  options: ExtractOptions | None = None) -> list[Cue]:
    options = options or ExtractOptions()
    source = Path(source)

    offset = _presentation_offset(source)

    if not track.is_bitmap:
        cues = _shift(extract_text_track(source, track, workdir), offset)
        return tidy(cues, strip_styling=options.strip_styling)

    bitmap_cues = _read_bitmap_cues(source, track, workdir)
    if not bitmap_cues:
        return []
    if offset:
        for cue in bitmap_cues:
            cue.start -= offset
            cue.end -= offset

    _notify(options, "prepare", 0, len(bitmap_cues))
    # 자막 한 덩이가 여러 줄일 수 있다. 줄마다 따로 인식하므로 한 줄로 펴서 넘기고
    # 결과를 다시 덩이별로 모은다.
    # 글자 한 줄의 높이는 트랙 전체에서 한 번 잰다. 자막 하나만 보고 재면
    # 짧은 줄에서 크게 어긋나, 한 줄이 두 조각으로 끊기거나 잘린다.
    track_line_height = measure_line_height([cue.image for cue in bitmap_cues])
    groups = [
        prepare_lines(
            cue.image,
            line_height=track_line_height,
            target_line_height=options.line_height or None,
        )
        for cue in bitmap_cues
    ]
    flat = [line.image for group in groups for line in group]
    _notify(options, "prepare", len(bitmap_cues), len(bitmap_cues))

    language = options.ocr_language
    if language == "auto":
        _notify(options, "language", 0, 1)
        choice = pick_language(flat, psm=options.psm, jobs=options.jobs)
        language = choice.language
        if options.on_language:
            options.on_language(choice)
        _notify(options, "language", 1, 1)

    engine = TesseractEngine(language=language, psm=options.psm)
    recognized = recognize_many(
        flat, engine, jobs=options.jobs,
        progress=lambda done, total: _notify(options, "ocr", done, total),
    )

    texts = []
    at = 0
    for group in groups:
        parts = []
        for line in group:
            text = recognized[at].strip()
            at += 1
            if text or line.prefix:
                parts.append(line.prefix + text)
        texts.append("\n".join(parts))

    cues = [Cue(cue.start, cue.end, text) for cue, text in zip(bitmap_cues, texts)]
    # OCR 결과에는 ASS 태그가 있을 리 없으니 스타일 제거는 건너뛴다.
    return tidy(cues, strip_styling=False)
