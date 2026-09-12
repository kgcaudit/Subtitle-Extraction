"""VobSub(DVD, dvd_subtitle) 자막 파서.

DVD 자막 한 덩어리는 SPU(Sub-Picture Unit) 하나다. SPU 안에는 2비트 런렝스로
압축된 비트맵과, 표시/숨김 시각·색·영역을 지정하는 제어 시퀀스가 들어 있다.

원본이 .idx/.sub 든 MKV/MP4 안에 들어 있든 ffprobe 가 SPU 를 그대로 내주므로
컨테이너별 분기 없이 한 경로로 처리한다. 16색 팔레트는 .idx 텍스트에 있고,
컨테이너에 들어간 경우 같은 텍스트가 스트림 extradata 에 실려 있다.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from PIL import Image

from subex.bitmap import BitmapCue
from subex.ffmpeg import run

__all__ = ["parse_vobsub", "decode_spu", "parse_idx_palette"]

#: 제어 시퀀스의 delay 단위는 1024/90000 초.
_DELAY_TO_MS = 1024 / 90
_DANGLING_DURATION_MS = 3_000

#: .idx 가 없을 때 쓰는 무난한 기본값(배경 투명 / 흰 글자 / 검은 테두리).
_DEFAULT_PALETTE = [(0, 0, 0), (255, 255, 255), (0, 0, 0), (128, 128, 128)] + [(0, 0, 0)] * 12


def _u16(data, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "big")


def _unhexdump(dump: str) -> bytes:
    """ffprobe 의 ``-show_data`` 16진 덤프를 원래 바이트로 되돌린다."""
    out = bytearray()
    for line in dump.splitlines():
        if len(line) < 11 or line[8:10] != ": ":
            continue
        out += bytes.fromhex(line[10:50].replace(" ", ""))
    return bytes(out)


def parse_idx_palette(text: str) -> list[tuple[int, int, int]]:
    match = re.search(r"^palette:\s*(.+)$", text, re.MULTILINE)
    if not match:
        return list(_DEFAULT_PALETTE)
    colors = []
    for token in match.group(1).split(","):
        token = token.strip()
        if len(token) == 6:
            colors.append((int(token[0:2], 16), int(token[2:4], 16), int(token[4:6], 16)))
    while len(colors) < 16:
        colors.append((0, 0, 0))
    return colors[:16]


def _read_palette(path, sub_index: int) -> list[tuple[int, int, int]]:
    source = Path(path)
    if source.suffix.lower() == ".idx":
        return parse_idx_palette(source.read_text(encoding="utf-8", errors="replace"))

    proc = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-select_streams", f"s:{sub_index}", "-show_streams", "-show_data", str(path),
    ])
    streams = json.loads(proc.stdout or b"{}").get("streams") or [{}]
    extradata = streams[0].get("extradata") or ""
    if not extradata:
        return list(_DEFAULT_PALETTE)
    return parse_idx_palette(_unhexdump(extradata).decode("utf-8", "replace"))


def _read_packets(path, sub_index: int) -> list[tuple[int, bytes]]:
    proc = run([
        "ffprobe", "-v", "error", "-print_format", "json",
        "-select_streams", f"s:{sub_index}", "-show_packets", "-show_data", str(path),
    ])
    packets = []
    for packet in json.loads(proc.stdout or b"{}").get("packets", []):
        pts = packet.get("pts_time")
        if pts in (None, "N/A"):
            continue
        payload = _unhexdump(packet.get("data") or "")
        if payload:
            packets.append((round(float(pts) * 1000), payload))
    return packets


def _read_nibble(data: bytes, position: int) -> int:
    byte = data[position >> 1]
    return byte >> 4 if position % 2 == 0 else byte & 0x0F


def _decode_field(data: bytes, byte_offset: int, plane: bytearray,
                  width: int, height: int, first_row: int) -> None:
    """한 필드(짝수 줄 또는 홀수 줄)의 2비트 런렝스를 편다."""
    position = byte_offset * 2
    limit = len(data) * 2
    row, column = first_row, 0

    while row < height and position < limit:
        value = _read_nibble(data, position)
        position += 1
        for _ in range(3):
            if value >= 0x04 or position >= limit:
                break
            value = (value << 4) | _read_nibble(data, position)
            position += 1
            if value >= 0x10:
                break
            if position >= limit:
                break
            value = (value << 4) | _read_nibble(data, position)
            position += 1
            if value >= 0x40:
                break
            if position >= limit:
                break
            value = (value << 4) | _read_nibble(data, position)
            position += 1
            break

        run = value >> 2
        color = value & 0x03
        if run == 0 or column + run > width:
            run = width - column

        if color and run > 0:
            start = row * width + column
            plane[start : start + run] = bytes([color]) * run
        column += run

        if column >= width:
            row += 2
            column = 0
            position = (position + 1) & ~1      # 줄이 끝나면 바이트 경계로 맞춘다


def decode_spu(spu: bytes, palette: list[tuple[int, int, int]]):
    """SPU 하나를 (이미지, 표시지연ms, 숨김지연ms) 로 푼다. 못 풀면 None."""
    if len(spu) < 4:
        return None
    control_offset = _u16(spu, 2)
    if not 0 < control_offset < len(spu):
        return None

    colormap = [0, 1, 2, 3]
    alphas = [0, 15, 15, 0]
    area = None
    field_offsets = None
    start_delay = 0
    stop_delay = None

    offset = control_offset
    visited = set()
    while 0 <= offset <= len(spu) - 4 and offset not in visited:
        visited.add(offset)
        delay = round(_u16(spu, offset) * _DELAY_TO_MS)
        next_offset = _u16(spu, offset + 2)
        cursor = offset + 4

        while cursor < len(spu):
            command = spu[cursor]
            cursor += 1
            if command == 0xFF:
                break
            if command in (0x00, 0x01):                      # 표시 시작
                start_delay = delay
            elif command == 0x02:                            # 표시 종료
                stop_delay = delay
            elif command == 0x03 and cursor + 2 <= len(spu):  # 색 지정
                high, low = spu[cursor], spu[cursor + 1]
                colormap = [low & 0x0F, low >> 4, high & 0x0F, high >> 4]
                cursor += 2
            elif command == 0x04 and cursor + 2 <= len(spu):  # 투명도 지정
                high, low = spu[cursor], spu[cursor + 1]
                alphas = [low & 0x0F, low >> 4, high & 0x0F, high >> 4]
                cursor += 2
            elif command == 0x05 and cursor + 6 <= len(spu):  # 표시 영역
                block = spu[cursor : cursor + 6]
                x1 = (block[0] << 4) | (block[1] >> 4)
                x2 = ((block[1] & 0x0F) << 8) | block[2]
                y1 = (block[3] << 4) | (block[4] >> 4)
                y2 = ((block[4] & 0x0F) << 8) | block[5]
                area = (x1, y1, x2, y2)
                cursor += 6
            elif command == 0x06 and cursor + 4 <= len(spu):  # 필드별 픽셀 데이터 위치
                field_offsets = (_u16(spu, cursor), _u16(spu, cursor + 2))
                cursor += 4
            elif command == 0x07 and cursor + 2 <= len(spu):  # 색 변경 테이블 - 건너뜀
                cursor += max(2, _u16(spu, cursor))
            else:
                break

        if next_offset == offset:
            break
        offset = next_offset

    if area is None or field_offsets is None:
        return None
    x1, y1, x2, y2 = area
    width, height = x2 - x1 + 1, y2 - y1 + 1
    if not (0 < width <= 4096 and 0 < height <= 4096):
        return None

    plane = bytearray(width * height)
    _decode_field(spu, field_offsets[0], plane, width, height, 0)
    _decode_field(spu, field_offsets[1], plane, width, height, 1)

    rgb_table = bytearray(768)
    alpha_table = [0] * 256
    for color_index in range(4):
        red, green, blue = palette[colormap[color_index] % len(palette)]
        rgb_table[color_index * 3 : color_index * 3 + 3] = bytes((red, green, blue))
        alpha_table[color_index] = min(255, alphas[color_index] * 17)

    paletted = Image.frombytes("P", (width, height), bytes(plane))
    paletted.putpalette(bytes(rgb_table))
    alpha = Image.frombytes("L", (width, height), bytes(plane)).point(alpha_table)
    image = paletted.convert("RGB").convert("RGBA")
    image.putalpha(alpha)

    box = image.getbbox()
    if not box:
        return None
    return image.crop(box), start_delay, stop_delay


def parse_vobsub(path, sub_index: int = 0) -> list[BitmapCue]:
    palette = _read_palette(path, sub_index)
    packets = _read_packets(path, sub_index)

    cues: list[BitmapCue] = []
    for position, (pts_ms, spu) in enumerate(packets):
        decoded = decode_spu(spu, palette)
        if decoded is None:
            continue
        image, start_delay, stop_delay = decoded
        start = pts_ms + start_delay
        if stop_delay is not None:
            end = pts_ms + stop_delay
        elif position + 1 < len(packets):
            end = packets[position + 1][0]
        else:
            end = start + _DANGLING_DURATION_MS
        if end > start:
            cues.append(BitmapCue(start, end, image))
    return cues
