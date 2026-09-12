"""테스트용 VobSub(.idx/.sub) 생성기.

ffmpeg 는 텍스트 자막을 비트맵 자막으로 인코딩하지 못하므로(dvdsub 인코더는
bitmap→bitmap 만 받는다) DVD 자막 테스트 자료는 규격대로 직접 만든다.
만들어진 파일은 ffmpeg 의 dvdsub 디코더로 다시 읽어 교차 검증한다.
"""

from __future__ import annotations

import struct

PACK_SIZE = 0x800          # DVD 팩 한 개의 크기
SUBSTREAM_ID = 0x20        # private_stream_1 안의 자막 0번
_PTS_HZ = 90_000


def _pack_header(scr: int = 0, mux_rate: int = 10080, stuffing: int = 0) -> bytes:
    scr_base = scr & ((1 << 33) - 1)
    value = 0b01
    value = (value << 3) | ((scr_base >> 30) & 0x07)
    value = (value << 1) | 1
    value = (value << 15) | ((scr_base >> 15) & 0x7FFF)
    value = (value << 1) | 1
    value = (value << 15) | (scr_base & 0x7FFF)
    value = (value << 1) | 1
    value = (value << 9) | 0            # SCR extension
    value = (value << 1) | 1
    head = b"\x00\x00\x01\xba" + value.to_bytes(6, "big")
    head += (((mux_rate & 0x3FFFFF) << 2) | 0b11).to_bytes(3, "big")
    head += bytes((0xF8 | (stuffing & 0x07),))
    return head + b"\xff" * stuffing


def _pts_bytes(pts: int) -> bytes:
    return bytes((
        0x21 | ((pts >> 29) & 0x0E),
        (pts >> 22) & 0xFF,
        0x01 | ((pts >> 14) & 0xFE),
        (pts >> 7) & 0xFF,
        0x01 | ((pts << 1) & 0xFE),
    ))


def encode_rle_2bit(plane: bytes, width: int, height: int, rows: range) -> bytes:
    """한 필드(짝수 줄 또는 홀수 줄)를 DVD 2비트 런렝스로 압축한다."""
    nibbles: list[int] = []

    def emit(run: int, color: int) -> None:
        if run == 0:                                   # 줄 끝까지
            nibbles.extend((0, 0, 0, color))
        elif run <= 3:
            nibbles.append((run << 2) | color)
        elif run <= 15:
            value = (run << 2) | color
            nibbles.extend((value >> 4, value & 0x0F))
        elif run <= 63:
            value = (run << 2) | color
            nibbles.extend((value >> 8, (value >> 4) & 0x0F, value & 0x0F))
        else:
            value = (run << 2) | color
            nibbles.extend((value >> 12, (value >> 8) & 0x0F, (value >> 4) & 0x0F, value & 0x0F))

    for row in rows:
        line = plane[row * width : (row + 1) * width]
        col = 0
        while col < width:
            color = line[col]
            run = 1
            while col + run < width and line[col + run] == color and run < 255:
                run += 1
            if col + run >= width:
                emit(0, color)                         # 줄 끝까지 같은 색
                col = width
            else:
                emit(run, color)
                col += run
        if len(nibbles) % 2:                           # 줄마다 바이트 경계 맞춤
            nibbles.append(0)

    if len(nibbles) % 2:
        nibbles.append(0)
    return bytes(
        (nibbles[i] << 4) | nibbles[i + 1] for i in range(0, len(nibbles), 2)
    )


def build_spu(plane: bytes, width: int, height: int, position: tuple[int, int],
              duration_ms: int, colormap=(0, 1, 2, 3), alphas=(0, 15, 15, 0)) -> bytes:
    top = encode_rle_2bit(plane, width, height, range(0, height, 2))
    bottom = encode_rle_2bit(plane, width, height, range(1, height, 2))

    top_offset = 4
    bottom_offset = top_offset + len(top)
    pixel_end = bottom_offset + len(bottom)
    if pixel_end % 2:
        pixel_end += 1
    control_offset = pixel_end

    x1, y1 = position
    x2, y2 = x1 + width - 1, y1 + height - 1

    first = bytearray()
    first += struct.pack(">HH", 0, control_offset)     # delay 0, 다음 시퀀스 위치(뒤에서 채움)
    first += bytes((0x01,))                            # STA_DSP
    first += bytes((0x03, (colormap[3] << 4) | colormap[2], (colormap[1] << 4) | colormap[0]))
    first += bytes((0x04, (alphas[3] << 4) | alphas[2], (alphas[1] << 4) | alphas[0]))
    first += bytes((0x05,
                    (x1 >> 4) & 0xFF, ((x1 & 0x0F) << 4) | ((x2 >> 8) & 0x0F), x2 & 0xFF,
                    (y1 >> 4) & 0xFF, ((y1 & 0x0F) << 4) | ((y2 >> 8) & 0x0F), y2 & 0xFF))
    first += bytes((0x06,)) + struct.pack(">HH", top_offset, bottom_offset)
    first += bytes((0xFF,))

    second_offset = control_offset + len(first)
    second = struct.pack(">HH", round(duration_ms * 90 / 1024), second_offset)
    second += bytes((0x02, 0xFF))                      # STP_DSP, 끝

    first[2:4] = struct.pack(">H", second_offset)      # 첫 시퀀스의 next 를 확정
    control = bytes(first) + second

    total = control_offset + len(control)
    spu = bytearray(struct.pack(">HH", total, control_offset))
    spu += top
    spu += bottom
    spu += b"\x00" * (control_offset - len(spu))
    spu += control
    return bytes(spu)


def _wrap_packs(spu: bytes, pts_ms: int) -> bytes:
    """SPU 를 2048 바이트 MPEG-PS 팩들에 나눠 담는다."""
    out = bytearray()
    offset = 0
    first = True
    while offset < len(spu):
        header = _pack_header()
        pes_header = bytes((0x81, 0x80, 0x05)) + _pts_bytes(int(pts_ms * _PTS_HZ / 1000)) if first \
            else bytes((0x81, 0x00, 0x00))
        # 팩 하나에 들어갈 수 있는 자막 데이터 크기
        fixed = len(header) + 4 + 2 + len(pes_header) + 1
        chunk = min(len(spu) - offset, PACK_SIZE - fixed)
        payload = pes_header + bytes((SUBSTREAM_ID,)) + spu[offset : offset + chunk]

        pad = PACK_SIZE - (len(header) + 4 + 2 + len(payload))
        if 0 < pad < 6:
            # 패딩 패킷 최소 길이(6)보다 작으면 자막 데이터를 그만큼 덜 담는다.
            chunk -= 6 - pad
            payload = pes_header + bytes((SUBSTREAM_ID,)) + spu[offset : offset + chunk]
            pad = PACK_SIZE - (len(header) + 4 + 2 + len(payload))

        out += header
        out += b"\x00\x00\x01\xbd" + struct.pack(">H", len(payload)) + payload
        if pad >= 6:
            out += b"\x00\x00\x01\xbe" + struct.pack(">H", pad - 6) + b"\xff" * (pad - 6)

        offset += chunk
        first = False
    return bytes(out)


def write_vobsub(idx_path, sub_path, entries, size=(720, 480), palette=None, language="ko") -> None:
    """entries: [(start_ms, end_ms, plane_bytes, width, height, (x, y)), ...]"""
    palette = palette or [
        (0, 0, 0), (255, 255, 255), (0, 0, 0), (128, 128, 128),
        *[(0, 0, 0)] * 12,
    ]

    blob = bytearray()
    index_lines = []
    for start, end, plane, width, height, position in entries:
        spu = build_spu(plane, width, height, position, end - start)
        index_lines.append((start, len(blob)))
        blob += _wrap_packs(spu, start)

    with open(sub_path, "wb") as handle:
        handle.write(bytes(blob))

    def timecode(ms: int) -> str:
        hours, ms = divmod(ms, 3_600_000)
        minutes, ms = divmod(ms, 60_000)
        seconds, ms = divmod(ms, 1_000)
        return f"{hours:02d}:{minutes:02d}:{seconds:02d}:{ms:03d}"

    with open(idx_path, "w", encoding="utf-8") as handle:
        handle.write("# VobSub index file, v7 (do not modify this line!)\n")
        handle.write(f"size: {size[0]}x{size[1]}\n")
        handle.write("palette: " + ", ".join(f"{r:02x}{g:02x}{b:02x}" for r, g, b in palette) + "\n")
        handle.write("langidx: 0\n\n")
        handle.write(f"id: {language}, index: 0\n")
        for start, filepos in index_lines:
            handle.write(f"timestamp: {timecode(start)}, filepos: {filepos:09x}\n")
