"""ffmpeg / ffprobe 실행 헬퍼."""

from __future__ import annotations

import json
import shutil
import subprocess

__all__ = ["ToolMissing", "FFmpegError", "which", "require", "run", "probe_json"]


class ToolMissing(RuntimeError):
    """필요한 외부 실행 파일이 PATH 에 없을 때."""


class FFmpegError(RuntimeError):
    """ffmpeg/ffprobe 가 0 이 아닌 코드로 끝났을 때."""


_INSTALL_HINT = {
    "ffmpeg": "Windows: winget install Gyan.FFmpeg / macOS: brew install ffmpeg / Ubuntu: sudo apt install ffmpeg",
    "ffprobe": "Windows: winget install Gyan.FFmpeg / macOS: brew install ffmpeg / Ubuntu: sudo apt install ffmpeg",
    "tesseract": "Windows: winget install UB-Mannheim.TesseractOCR / macOS: brew install tesseract tesseract-lang / Ubuntu: sudo apt install tesseract-ocr tesseract-ocr-kor",
}


def which(name: str) -> str | None:
    return shutil.which(name)


def require(name: str) -> str:
    path = shutil.which(name)
    if not path:
        hint = _INSTALL_HINT.get(name, "")
        raise ToolMissing(f"'{name}' 을(를) 찾을 수 없습니다. 설치 후 PATH 에 추가하세요.\n  {hint}")
    return path


def run(args: list[str], *, capture: bool = True) -> subprocess.CompletedProcess:
    """외부 명령을 돌리고 실패하면 stderr 꼬리를 붙여 예외를 던진다."""
    require(args[0])
    proc = subprocess.run(
        args,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE,
        check=False,
    )
    if proc.returncode != 0:
        stderr = (proc.stderr or b"").decode("utf-8", "replace").strip()
        tail = "\n".join(stderr.splitlines()[-8:])
        raise FFmpegError(f"{args[0]} 실패 (exit {proc.returncode}):\n{tail}")
    return proc


def probe_json(args: list[str]) -> dict:
    proc = run(["ffprobe", "-v", "error", "-print_format", "json", *args])
    return json.loads(proc.stdout or b"{}")
