"""입력 파일의 자막 트랙 목록을 조사한다."""

from __future__ import annotations

from dataclasses import dataclass

from subex.ffmpeg import probe_json

__all__ = [
    "SubtitleTrack", "probe_subtitles", "presentation_offset_ms",
    "decide_presentation_offset",
    "BITMAP_CODECS", "SUPPORTED_BITMAP_CODECS",
]

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


def decide_presentation_offset(streams, format_start) -> int:
    """probe 결과로 '재생 0초' 에 해당하는 시각(밀리초)을 정한다.

    인식기·ffprobe 없이도 시험할 수 있게 따로 두었다.

    자막은 **화면과 맞아야** 하므로 기준은 영상 트랙이 시작하는 시각이다.
    영상이 없으면(소리+자막뿐인 파일) 컨테이너가 알려 주는 시작 시각을 쓰되,
    음수는 0 으로 본다.
    """
    for stream in streams or []:
        if stream.get("codec_type") != "video":
            continue
        start = stream.get("start_time")
        if start not in (None, "N/A"):
            return round(float(start) * 1000)

    if format_start in (None, "N/A"):
        return 0
    return max(0, round(float(format_start) * 1000))


def presentation_offset_ms(path) -> int:
    """이 파일에서 '재생 0초' 에 해당하는 시각(밀리초).

    ffmpeg 에게 그냥 맡기면 출력이 0 에서 시작하도록 **모든 스트림 중 가장 이른
    것** 에 맞춰 전체를 민다. 그런데 AAC 소리는 앞에 준비 구간이 있어 -0.023초에서
    시작하는 일이 흔하고, 그러면 자막이 통째로 23밀리초 밀린다(실측). 화면은 0에서
    시작하는데 자막만 늦어지는 것이다. 그래서 기준을 영상에 맞춰 직접 잡는다.
    """
    try:
        data = probe_json(["-show_streams", "-show_entries", "format=start_time", str(path)])
    except Exception:
        return 0
    return decide_presentation_offset(data.get("streams"), (data.get("format") or {}).get("start_time"))
