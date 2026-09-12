"""자막 트랙 하나를 SRT 큐 목록으로 만드는 전체 흐름."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from subex.bitmap import BitmapCue, prepare_for_ocr
from subex.ffmpeg import run
from subex.ocr import TesseractEngine, recognize_many
from subex.pgs import parse_sup
from subex.postprocess import tidy
from subex.probe import SubtitleTrack
from subex.srt import Cue
from subex.text_track import extract_text_track
from subex.vobsub import parse_vobsub

__all__ = ["ExtractOptions", "extract_track"]


@dataclass
class ExtractOptions:
    ocr_language: str = "kor+eng"
    psm: int = 6
    jobs: int | None = None
    strip_styling: bool = True
    scale: int = 2
    on_progress: object = None       # callable(stage: str, done: int, total: int)


def _notify(options: ExtractOptions, stage: str, done: int, total: int) -> None:
    if options.on_progress:
        options.on_progress(stage, done, total)


def _read_bitmap_cues(source: Path, track: SubtitleTrack, workdir: Path) -> list[BitmapCue]:
    if track.codec == "hdmv_pgs_subtitle":
        target = workdir / f"track{track.index}.sup"
        run([
            "ffmpeg", "-v", "error", "-y",
            "-i", str(source), "-map", f"0:{track.index}", "-c:s", "copy", str(target),
        ])
        return parse_sup(target)

    if track.codec == "dvd_subtitle":
        return parse_vobsub(source, track.sub_index)

    raise ValueError(f"이 프로젝트가 비트맵을 복원할 수 없는 코덱입니다: {track.codec}")


def extract_track(source, track: SubtitleTrack, workdir: Path,
                  options: ExtractOptions | None = None) -> list[Cue]:
    options = options or ExtractOptions()
    source = Path(source)

    if not track.is_bitmap:
        cues = extract_text_track(source, track, workdir)
        return tidy(cues, strip_styling=options.strip_styling)

    bitmap_cues = _read_bitmap_cues(source, track, workdir)
    if not bitmap_cues:
        return []

    _notify(options, "prepare", 0, len(bitmap_cues))
    images = [prepare_for_ocr(cue.image, scale=options.scale) for cue in bitmap_cues]
    _notify(options, "prepare", len(bitmap_cues), len(bitmap_cues))

    engine = TesseractEngine(language=options.ocr_language, psm=options.psm)
    texts = recognize_many(
        images, engine, jobs=options.jobs,
        progress=lambda done, total: _notify(options, "ocr", done, total),
    )

    cues = [Cue(cue.start, cue.end, text) for cue, text in zip(bitmap_cues, texts)]
    # OCR 결과에는 ASS 태그가 있을 리 없으니 스타일 제거는 건너뛴다.
    return tidy(cues, strip_styling=False)
