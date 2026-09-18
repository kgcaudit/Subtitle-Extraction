"""subex 명령줄 진입점."""

from __future__ import annotations

import argparse
import sys
import tempfile
import time
from pathlib import Path

from subex import __version__
from subex.extract import ExtractOptions, extract_track
from subex.ffmpeg import FFmpegError, ToolMissing, which
from subex.probe import SubtitleTrack, probe_subtitles
from subex.srt import write_srt


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="subex",
        description="영상에 들어 있는 자막 트랙을 SRT 파일로 뽑아냅니다. "
                    "이미지 자막(PGS/VobSub)은 OCR 을 거쳐 글자로 바꿉니다.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "예시:\n"
            "  subex movie.mkv                    자막 트랙을 전부 SRT 로\n"
            "  subex movie.mkv --list             어떤 자막이 들어 있는지만 확인\n"
            "  subex movie.mkv -t 1 -o ko.srt     2번째 자막만 지정한 이름으로\n"
            "  subex *.mkv --lang kor             한국어 트랙만 일괄 추출\n"
        ),
    )
    parser.add_argument("inputs", nargs="+", metavar="INPUT", help="영상 파일 (mkv, mp4, avi, ts, .sup, .idx ...)")
    parser.add_argument("--list", action="store_true", help="자막 트랙 목록만 보여주고 끝낸다")
    parser.add_argument("-o", "--output", metavar="FILE", help="출력 파일 (입력 1개 + 트랙 1개일 때만)")
    parser.add_argument("--outdir", metavar="DIR", help="출력 폴더 (기본: 입력 파일과 같은 폴더)")
    parser.add_argument("-t", "--track", type=int, action="append", metavar="N",
                        help="추출할 자막 트랙 번호(--list 의 # 값). 여러 번 쓸 수 있다")
    parser.add_argument("--lang", metavar="CODE", help="이 언어의 트랙만 추출 (예: kor, eng)")
    parser.add_argument("--ocr-lang", default="auto", metavar="LANGS",
                        help="이미지 자막 OCR 언어 (기본: auto — 앞부분을 살펴보고 "
                             "'kor' 과 'kor+eng' 중에서 고른다). 직접 주려면 kor, kor+eng, eng ...")
    parser.add_argument("--psm", type=int, default=7, metavar="N",
                        help="Tesseract 페이지 분할 모드 (기본: 7 — 자막을 줄마다 따로 넣으므로 '한 줄')")
    parser.add_argument("--line-height", type=int, default=28, metavar="N",
                        help="OCR 에 넣을 글자 한 줄 높이 (기본: 28). 큰 글자만 줄이고 키우지는 않는다. "
                             "0 을 주면 원본 크기 그대로")
    parser.add_argument("-j", "--jobs", type=int, metavar="N", help="OCR 동시 실행 개수 (기본: CPU 수)")
    parser.add_argument("--encoding", default="utf-8", metavar="ENC",
                        help="출력 인코딩 (기본: utf-8). 구형 플레이어는 cp949")
    parser.add_argument("--bom", action="store_true", help="UTF-8 BOM 을 붙인다")
    parser.add_argument("--keep-styling", action="store_true",
                        help="ASS 스타일 태그({\\an8} 등)를 지우지 않는다")
    parser.add_argument("--overwrite", action="store_true", help="이미 있는 출력 파일을 덮어쓴다")
    parser.add_argument("-q", "--quiet", action="store_true", help="진행 상황을 출력하지 않는다")
    parser.add_argument("-V", "--version", action="version", version=f"subex {__version__}")
    return parser


def _select(tracks: list[SubtitleTrack], args) -> list[SubtitleTrack]:
    chosen = tracks
    if args.track is not None:
        wanted = set(args.track)
        chosen = [track for track in chosen if track.sub_index in wanted]
    if args.lang:
        target = args.lang.lower()
        chosen = [track for track in chosen if (track.language or "").lower() == target]
    return chosen


def _output_path(source: Path, track: SubtitleTrack, args, used: set[Path]) -> Path:
    if args.output:
        return Path(args.output)
    directory = Path(args.outdir) if args.outdir else source.parent
    candidate = directory / f"{source.stem}.{track.slug()}.srt"
    if candidate in used:
        candidate = directory / f"{source.stem}.{track.slug()}.{track.sub_index}.srt"
    return candidate


class _Progress:
    """한 줄짜리 진행 표시. 너무 자주 그리지 않도록 간격을 둔다."""

    def __init__(self, quiet: bool):
        self.quiet = quiet
        self.last = 0.0

    def __call__(self, stage: str, done: int, total: int) -> None:
        if self.quiet or not total:
            return
        now = time.monotonic()
        if done < total and now - self.last < 0.2:
            return
        self.last = now
        # OCR 은 자막 덩이가 아니라 글자 줄 단위로 센다. 끝에 찍히는 "N줄"
        # (자막 수)과 헷갈리지 않도록 무엇을 세는지 붙여 준다.
        label = {"prepare": "이미지 준비", "ocr": "OCR(글자 줄)",
                 "language": "인식 언어 고르기"}.get(stage, stage)
        print(f"\r    {label} {done}/{total} ({done * 100 // total}%)", end="", file=sys.stderr)
        if done >= total:
            print(file=sys.stderr)


def _check_tools(need_ocr: bool) -> list[str]:
    problems = []
    if not which("ffmpeg") or not which("ffprobe"):
        problems.append(
            "ffmpeg / ffprobe 가 필요합니다.\n"
            "  Windows: winget install Gyan.FFmpeg\n"
            "  macOS  : brew install ffmpeg\n"
            "  Ubuntu : sudo apt install ffmpeg"
        )
    if need_ocr and not which("tesseract"):
        problems.append(
            "이미지 자막을 글자로 바꾸려면 tesseract 가 필요합니다.\n"
            "  Windows: winget install UB-Mannheim.TesseractOCR\n"
            "  macOS  : brew install tesseract tesseract-lang\n"
            "  Ubuntu : sudo apt install tesseract-ocr tesseract-ocr-kor"
        )
    return problems


def _process_file(source: Path, args, used: set[Path]) -> tuple[int, int]:
    """(성공한 트랙 수, 실패한 트랙 수)"""
    say = (lambda *a: None) if args.quiet else (lambda *a: print(*a))

    if not source.exists():
        print(f"[!] 파일을 찾을 수 없습니다: {source}", file=sys.stderr)
        return 0, 1

    tracks = probe_subtitles(source)
    if not tracks:
        print(f"[!] {source.name}: 자막 트랙이 없습니다. "
              f"화면에 새겨진(번인) 자막이거나 음성만 있는 영상일 수 있습니다.", file=sys.stderr)
        return 0, 0

    if args.list:
        print(f"{source.name}")
        for track in tracks:
            mark = "" if track.supported else "   <- 지원하지 않는 형식"
            print(f"  {track.describe()}{mark}")
        return 0, 0

    selected = _select(tracks, args)
    if not selected:
        print(f"[!] {source.name}: 조건에 맞는 자막 트랙이 없습니다 "
              f"(--list 로 확인해 보세요).", file=sys.stderr)
        return 0, 1

    if args.output and len(selected) > 1:
        print("[!] -o 는 트랙 하나만 뽑을 때 쓸 수 있습니다. -t 로 트랙을 지정하거나 "
              "--outdir 을 쓰세요.", file=sys.stderr)
        return 0, 1

    problems = _check_tools(need_ocr=any(track.is_bitmap for track in selected))
    if problems:
        for problem in problems:
            print(f"[!] {problem}", file=sys.stderr)
        return 0, len(selected)

    options = ExtractOptions(
        ocr_language=args.ocr_lang,
        psm=args.psm,
        jobs=args.jobs,
        strip_styling=not args.keep_styling,
        line_height=args.line_height,
        on_progress=_Progress(args.quiet),
        on_language=lambda choice: say(
            f"    인식 언어 : {choice.language} (자동 선택 — {choice.describe()})"
        ),
    )

    ok = failed = 0
    say(f"{source.name}")
    with tempfile.TemporaryDirectory(prefix="subex-") as tmp:
        workdir = Path(tmp)
        for track in selected:
            say(f"  트랙 {track.describe()}")
            if not track.supported:
                print(f"    [!] {track.codec_label} 은(는) 아직 지원하지 않습니다. 건너뜁니다.",
                      file=sys.stderr)
                failed += 1
                continue

            target = _output_path(source, track, args, used)
            if target.exists() and not args.overwrite:
                print(f"    [!] 이미 있습니다: {target} (--overwrite 로 덮어쓰기)", file=sys.stderr)
                failed += 1
                continue

            started = time.monotonic()
            try:
                cues = extract_track(source, track, workdir, options)
            except (FFmpegError, ToolMissing, RuntimeError, ValueError) as error:
                print(f"    [!] 실패: {error}", file=sys.stderr)
                failed += 1
                continue

            if not cues:
                print("    [!] 자막 내용이 비어 있어 파일을 만들지 않았습니다.", file=sys.stderr)
                failed += 1
                continue

            target.parent.mkdir(parents=True, exist_ok=True)
            write_srt(target, cues, encoding=args.encoding, bom=args.bom)
            used.add(target)
            ok += 1
            say(f"    -> {target}  ({len(cues)}줄, {time.monotonic() - started:.1f}초)")

    return ok, failed


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    used: set[Path] = set()
    total_ok = total_failed = 0

    for name in args.inputs:
        ok, failed = _process_file(Path(name), args, used)
        total_ok += ok
        total_failed += failed

    if args.list:
        return 0
    if total_ok == 0 and total_failed:
        return 1
    if not args.quiet and (total_ok or total_failed):
        print(f"\n완료: {total_ok}개 성공" + (f", {total_failed}개 실패" if total_failed else ""))
    return 0 if total_failed == 0 else 2
