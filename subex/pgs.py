"""PGS(Blu-ray, .sup) 자막 파서.

.sup 는 세그먼트의 나열이다. 하나의 화면 단위(display set)는
PCS → WDS → PDS → ODS → END 순으로 오고, PCS 의 PTS 가 그 화면의 시각이다.
합성 객체가 하나도 없는 PCS 는 '화면 지우기' 이므로 직전 자막의 종료 시각이 된다.
"""

from __future__ import annotations

from PIL import Image

from subex.bitmap import BitmapCue

__all__ = ["parse_sup"]

SEG_PDS = 0x14   # 팔레트
SEG_ODS = 0x15   # 비트맵 객체
SEG_PCS = 0x16   # 화면 구성
SEG_WDS = 0x17   # 윈도우
SEG_END = 0x80   # 화면 단위 끝

_PTS_HZ = 90_000
#: 파일이 끝났는데도 안 닫힌 자막에 씌울 기본 길이.
_DANGLING_DURATION_MS = 3_000


def _u16(data: bytes, offset: int) -> int:
    return int.from_bytes(data[offset : offset + 2], "big")


def _ycrcb_to_rgb(y: int, cr: int, cb: int) -> tuple[int, int, int]:
    """BT.601 limited range → full range RGB."""
    yf = (y - 16) * 255.0 / 219.0
    cbf = cb - 128
    crf = cr - 128
    red = yf + 1.402 * crf
    green = yf - 0.344136 * cbf - 0.714136 * crf
    blue = yf + 1.772 * cbf
    return (
        min(255, max(0, round(red))),
        min(255, max(0, round(green))),
        min(255, max(0, round(blue))),
    )


def iter_segments(data: bytes):
    """(pts_90khz, segment_type, payload) 를 차례로 내놓는다."""
    offset = 0
    end = len(data)
    while offset + 13 <= end:
        if data[offset : offset + 2] != b"PG":
            # 깨진 구간은 다음 매직까지 건너뛴다.
            nxt = data.find(b"PG", offset + 1)
            if nxt < 0:
                return
            offset = nxt
            continue
        pts = int.from_bytes(data[offset + 2 : offset + 6], "big")
        seg_type = data[offset + 10]
        size = _u16(data, offset + 11)
        payload = data[offset + 13 : offset + 13 + size]
        if len(payload) < size:
            return
        yield pts, seg_type, payload
        offset += 13 + size


def decode_rle(data: bytes, width: int, height: int) -> bytes:
    """PGS 런렝스를 팔레트 인덱스 바이트열로 편다."""
    out = bytearray(width * height)
    pos = 0
    size = len(data)
    x = y = 0

    while pos < size and y < height:
        first = data[pos]
        pos += 1

        if first:
            run, color = 1, first
        else:
            if pos >= size:
                break
            second = data[pos]
            pos += 1
            if second == 0:                      # 줄 끝
                y += 1
                x = 0
                continue
            if second < 0x40:                    # 0 색 짧은 런
                run, color = second, 0
            elif second < 0x80:                  # 0 색 긴 런
                if pos >= size:
                    break
                run = ((second & 0x3F) << 8) | data[pos]
                pos += 1
                color = 0
            elif second < 0xC0:                  # 지정 색 짧은 런
                if pos >= size:
                    break
                run, color = second & 0x3F, data[pos]
                pos += 1
            else:                                # 지정 색 긴 런
                if pos + 1 >= size:
                    break
                run = ((second & 0x3F) << 8) | data[pos]
                color = data[pos + 1]
                pos += 2

        # 정상적인 데이터는 줄 끝마다 0x00 0x00 을 넣는다. 그 마커가 빠진
        # 인코더도 있으므로, 줄이 가득 찬 상태에서 런이 또 오면 여기서 넘긴다.
        if x >= width:
            y += 1
            x = 0
            if y >= height:
                break

        run = min(run, width - x)
        if run > 0:
            if color:
                start = y * width + x
                out[start : start + run] = bytes([color]) * run
            x += run

    return bytes(out)


def _parse_pcs(payload: bytes) -> dict:
    objects = []
    count = payload[10] if len(payload) > 10 else 0
    offset = 11
    for _ in range(count):
        if offset + 8 > len(payload):
            break
        cropped = bool(payload[offset + 3] & 0x80)
        entry = {
            "object_id": _u16(payload, offset),
            "x": _u16(payload, offset + 4),
            "y": _u16(payload, offset + 6),
            "crop": None,
        }
        offset += 8
        if cropped and offset + 8 <= len(payload):
            entry["crop"] = (
                _u16(payload, offset),
                _u16(payload, offset + 2),
                _u16(payload, offset + 4),
                _u16(payload, offset + 6),
            )
            offset += 8
        objects.append(entry)

    return {
        "width": _u16(payload, 0),
        "height": _u16(payload, 2),
        "state": payload[7] if len(payload) > 7 else 0,
        "palette_id": payload[9] if len(payload) > 9 else 0,
        "objects": objects,
    }


def _parse_pds(payload: bytes) -> tuple[int, dict[int, tuple[int, int, int, int]]]:
    palette_id = payload[0] if payload else 0
    entries: dict[int, tuple[int, int, int, int]] = {}
    offset = 2
    while offset + 5 <= len(payload):
        index, y, cr, cb, alpha = payload[offset : offset + 5]
        entries[index] = (*_ycrcb_to_rgb(y, cr, cb), alpha)
        offset += 5
    return palette_id, entries


def _parse_ods(payload: bytes, pending: dict) -> tuple[int, int, int, bytes] | None:
    """조각난 ODS 를 모아 완성되면 (id, width, height, rle) 를 돌려준다."""
    if len(payload) < 4:
        return None
    object_id = _u16(payload, 0)
    sequence = payload[3]
    offset = 4

    if sequence & 0x80:                              # 첫 조각
        if len(payload) < 11:
            return None
        pending[object_id] = {
            "width": _u16(payload, 7),
            "height": _u16(payload, 9),
            "data": bytearray(),
        }
        offset = 11

    entry = pending.get(object_id)
    if entry is None:
        return None
    entry["data"] += payload[offset:]

    if sequence & 0x40:                              # 마지막 조각
        pending.pop(object_id, None)
        return object_id, entry["width"], entry["height"], bytes(entry["data"])
    return None


def _to_image(width: int, height: int, rle: bytes,
              palette: dict[int, tuple[int, int, int, int]]) -> Image.Image:
    indices = decode_rle(rle, width, height)

    rgb_table = bytearray(768)
    alpha_table = [0] * 256
    for index, (red, green, blue, alpha) in palette.items():
        if 0 <= index < 256:
            rgb_table[index * 3 : index * 3 + 3] = bytes((red, green, blue))
            alpha_table[index] = alpha

    paletted = Image.frombytes("P", (width, height), indices)
    paletted.putpalette(bytes(rgb_table))
    alpha = Image.frombytes("L", (width, height), indices).point(alpha_table)

    image = paletted.convert("RGB").convert("RGBA")
    image.putalpha(alpha)
    return image


def _compose(pcs: dict, objects: dict, palette: dict) -> Image.Image | None:
    canvas = Image.new("RGBA", (max(pcs["width"], 1), max(pcs["height"], 1)), (0, 0, 0, 0))
    drew = False

    for entry in pcs["objects"]:
        source = objects.get(entry["object_id"])
        if source is None:
            continue
        width, height, rle = source
        if width <= 0 or height <= 0:
            continue
        image = _to_image(width, height, rle, palette)
        if entry["crop"]:
            crop_x, crop_y, crop_w, crop_h = entry["crop"]
            image = image.crop((crop_x, crop_y, crop_x + crop_w, crop_y + crop_h))
        # 캔버스를 벗어나는 좌표는 PIL 이 알아서 잘라낸다.
        canvas.alpha_composite(image, (entry["x"], entry["y"]))
        drew = True

    if not drew:
        return None
    box = canvas.getbbox()
    return canvas.crop(box) if box else None


def parse_sup(path) -> list[BitmapCue]:
    """.sup 파일에서 (시작, 끝, 비트맵) 목록을 뽑는다."""
    with open(path, "rb") as handle:
        data = handle.read()

    cues: list[BitmapCue] = []
    palettes: dict[int, dict] = {}
    objects: dict[int, tuple[int, int, bytes]] = {}
    pending_ods: dict[int, dict] = {}

    current_pcs: dict | None = None
    current_pts = 0
    open_start: int | None = None
    open_image: Image.Image | None = None
    last_pts_ms = 0

    for pts, seg_type, payload in iter_segments(data):
        # 90kHz 눈금을 밀리초로. 반올림한다 — 버리면 웹판(Math.round)과
        # 자막 절반의 시각이 1밀리초씩 어긋난다.
        pts_ms = (pts * 1000 + _PTS_HZ // 2) // _PTS_HZ
        last_pts_ms = max(last_pts_ms, pts_ms)

        if seg_type == SEG_PCS:
            current_pcs = _parse_pcs(payload)
            current_pts = pts_ms
            if current_pcs["state"] & 0x80:          # epoch start → 캐시 비우기
                palettes.clear()
                objects.clear()
                pending_ods.clear()

        elif seg_type == SEG_PDS:
            palette_id, entries = _parse_pds(payload)
            palettes.setdefault(palette_id, {}).update(entries)

        elif seg_type == SEG_ODS:
            finished = _parse_ods(payload, pending_ods)
            if finished:
                object_id, width, height, rle = finished
                objects[object_id] = (width, height, rle)

        elif seg_type == SEG_END:
            if current_pcs is None:
                continue
            if open_start is not None and open_image is not None and current_pts > open_start:
                cues.append(BitmapCue(open_start, current_pts, open_image))
                open_start, open_image = None, None

            image = _compose(current_pcs, objects, palettes.get(current_pcs["palette_id"], {}))
            if image is not None:
                open_start, open_image = current_pts, image
            current_pcs = None

    if open_start is not None and open_image is not None:
        end = max(last_pts_ms, open_start + _DANGLING_DURATION_MS)
        cues.append(BitmapCue(open_start, end, open_image))

    return cues
