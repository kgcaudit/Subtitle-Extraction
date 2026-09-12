"""입력 파일의 자막 트랙 목록을 조사한다."""

from __future__ import annotations

from dataclasses import dataclass

from subex.ffmpeg import probe_json

__all__ = ["SubtitleTrack", "probe_subtitles", "BITMAP_CODECS", "SUPPORTED_BITMAP_CODECS"]

#: 비트맵(이미지) 자막 코덱. 이쪽은 OCR 을 거쳐야 글자가 된다.
BITMAP_CODECS = {
    "hdmv_pgs_subtitle",
    "dvd_subtitle",
    "dvb_subtitle",
    "dvb_teletext",
    "xsub",
}

#: 그중 이 프로젝트가 비트맵을 복원할 수 있는 것.
SUPPORTED_BITMAP_CODECS = {"hdmv_pgs_subtitle", "dvd_subtitle"}

_CODEC_LABEL = {
    "hdmv_pgs_subtitle": "PGS (Blu-ray 이미지 자막)",
    "dvd_subtitle": "VobSub (DVD 이미지 자막)",
    "dvb_subtitle": "DVB 이미지 자막",
    "dvb_teletext": "텔레텍스트",
    "xsub": "XSUB 이미지 자막",
    "subrip": "SubRip",
    "ass": "ASS/SSA",
    "ssa": "ASS/SSA",
    "mov_text": "MP4 타임드 텍스트",
    "webvtt": "WebVTT",
}


@dataclass
class SubtitleTrack:
    index: int          # 파일 전체 기준 스트림 번호 (ffmpeg -map 0:<index>)
    sub_index: int      # 자막 스트림들 사이에서의 순번 (0부터)
    codec: str
    language: str | None
    title: str | None
    default: bool
    forced: bool
    hearing_impaired: bool

    @property
    def is_bitmap(self) -> bool:
        return self.codec in BITMAP_CODECS

    @property
    def supported(self) -> bool:
        return not self.is_bitmap or self.codec in SUPPORTED_BITMAP_CODECS

    @property
    def kind(self) -> str:
        return "bitmap" if self.is_bitmap else "text"

    @property
    def codec_label(self) -> str:
        return _CODEC_LABEL.get(self.codec, self.codec)

    def describe(self) -> str:
        flags = [name for name, on in
                 (("default", self.default), ("forced", self.forced), ("SDH", self.hearing_impaired)) if on]
        parts = [f"#{self.sub_index}", self.language or "und", self.codec_label]
        if self.title:
            parts.append(f"'{self.title}'")
        if flags:
            parts.append("[" + ",".join(flags) + "]")
        return "  ".join(parts)

    def slug(self) -> str:
        """출력 파일 이름에 붙일 꼬리표."""
        bits = [self.language or "und"]
        if self.forced:
            bits.append("forced")
        if self.hearing_impaired:
            bits.append("sdh")
        return ".".join(bits)


def probe_subtitles(path) -> list[SubtitleTrack]:
    data = probe_json(["-show_streams", "-select_streams", "s", str(path)])
    tracks = []
    for sub_index, stream in enumerate(data.get("streams", [])):
        tags = stream.get("tags") or {}
        disposition = stream.get("disposition") or {}
        language = tags.get("language") or tags.get("LANGUAGE")
        if language in {"und", ""}:
            language = None
        tracks.append(
            SubtitleTrack(
                index=int(stream["index"]),
                sub_index=sub_index,
                codec=stream.get("codec_name", "unknown"),
                language=language,
                title=tags.get("title") or tags.get("TITLE"),
                default=bool(disposition.get("default")),
                forced=bool(disposition.get("forced")),
                hearing_impaired=bool(disposition.get("hearing_impaired")),
            )
        )
    return tracks
