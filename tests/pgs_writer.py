"""테스트용 PGS(.sup) 생성기.

파서를 검증하려면 규격에 맞는 입력이 필요한데 ffmpeg 에는 PGS 인코더가 없다.
그래서 사양대로 직접 써 넣고, 만들어진 파일을 ffmpeg 의 PGS 디코더로
다시 읽어 교차 검증한다(tests/test_pgs.py).
"""

from __future__ import annotations

import struct

from PIL import Image, ImageDraw, ImageFont

SEG_PDS, SEG_ODS, SEG_PCS, SEG_WDS, SEG_END = 0x14, 0x15, 0x16, 0x17, 0x80
_PTS_HZ = 90_000


def rgb_to_ycrcb(red: int, green: int, blue: int) -> tuple[int, int, int]:
    y = 16 + (65.481 * red + 128.553 * green + 24.966 * blue) / 255
    cb = 128 + (-37.797 * red - 74.203 * green + 112.0 * blue) / 255
    cr = 128 + (112.0 * red - 93.786 * green - 18.214 * blue) / 255
    clamp = lambda v: min(255, max(0, round(v)))
    return clamp(y), clamp(cr), clamp(cb)


def encode_rle(indices: bytes, width: int, height: int) -> bytes:
    """팔레트 인덱스 평면을 PGS 런렝스로 압축한다."""
    out = bytearray()
    for row in range(height):
        line = indices[row * width : (row + 1) * width]
        col = 0
        while col < width:
            color = line[col]
            run = 1
            while col + run < width and line[col + run] == color and run < 16383:
                run += 1
            if color == 0:
                if run < 64:
                    out += bytes((0x00, run))
                else:
                    out += bytes((0x00, 0x40 | (run >> 8), run & 0xFF))
            else:
                if run == 1:
                    out += bytes((color,))
                elif run < 64:
                    out += bytes((0x00, 0x80 | run, color))
                else:
                    out += bytes((0x00, 0xC0 | (run >> 8), run & 0xFF, color))
            col += run
        out += bytes((0x00, 0x00))
    return bytes(out)


def _segment(pts_ms: int, seg_type: int, payload: bytes) -> bytes:
    pts = int(pts_ms * _PTS_HZ / 1000)
    return b"PG" + struct.pack(">IIB H", pts, 0, seg_type, len(payload)) + payload


def render_text(text: str, font_size: int = 44, font_path: str | None = None,
                fill=(255, 255, 255)) -> Image.Image:
    """흰 글자 + 검은 테두리의 전형적인 자막 비트맵을 만든다."""
    font = ImageFont.truetype(font_path, font_size) if font_path else ImageFont.load_default(font_size)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    box = probe.multiline_textbbox((0, 0), text, font=font, align="center", spacing=8)
    width = int(box[2] - box[0]) + 24
    height = int(box[3] - box[1]) + 24

    image = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.multiline_text(
        (12 - int(box[0]), 12 - int(box[1])), text, font=font, fill=(*fill, 255),
        stroke_width=2, stroke_fill=(0, 0, 0, 255), align="center", spacing=8,
    )
    return image


def quantize(image: Image.Image) -> tuple[bytes, list[tuple[int, int, int, int]]]:
    """RGBA 비트맵을 (투명, 흰색, 검정) 3색 팔레트 평면으로 바꾼다."""
    palette = [(0, 0, 0, 0), (255, 255, 255, 255), (0, 0, 0, 255)]
    plane = bytearray(image.width * image.height)
    pixels = image.load()
    for y in range(image.height):
        base = y * image.width
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            if alpha < 128:
                plane[base + x] = 0
            elif (red + green + blue) / 3 >= 128:
                plane[base + x] = 1
            else:
                plane[base + x] = 2
    return bytes(plane), palette


def write_sup(path, entries, canvas=(1920, 1080)) -> None:
    """.sup 파일을 쓴다.

    entries 의 각 항목은 두 가지 모양을 받는다.

        (start_ms, end_ms, 그림, (x, y))                  — 객체 하나
        (start_ms, end_ms, [(그림, (x, y)), ...], None)   — 객체 여럿

    실제 블루레이 자막은 두 줄을 각각 다른 객체로 얹는 경우가 흔해서
    두 번째 모양도 만들 수 있어야 한다.
    """
    canvas_w, canvas_h = canvas
    blob = bytearray()

    for number, (start, end, payload, position) in enumerate(entries):
        objects = payload if isinstance(payload, list) else [(payload, position)]

        # --- 표시 시작 ---
        pcs = struct.pack(
            ">HHBHBBBB", canvas_w, canvas_h, 0x10, number * 2, 0x80, 0x00, 0x00, len(objects)
        )
        for object_id, (image, (pos_x, pos_y)) in enumerate(objects):
            pcs += struct.pack(">HBBHH", object_id, 0, 0x00, pos_x, pos_y)
        blob += _segment(start, SEG_PCS, pcs)

        wds = bytes((len(objects),))
        for object_id, (image, (pos_x, pos_y)) in enumerate(objects):
            wds += struct.pack(">BHHHH", object_id, pos_x, pos_y, image.width, image.height)
        blob += _segment(start, SEG_WDS, wds)

        # 팔레트는 화면 단위 하나에 하나뿐이므로 객체들의 색을 합쳐서 쓴다.
        planes, palette = quantize_together([image for image, _ in objects])
        pds = bytes((0, 0))
        for index, (red, green, blue, alpha) in enumerate(palette):
            if index == 0:
                continue                       # 완전 투명 항목은 생략해도 무방
            y, cr, cb = rgb_to_ycrcb(red, green, blue)
            pds += bytes((index, y, cr, cb, alpha))
        blob += _segment(start, SEG_PDS, pds)

        for object_id, ((image, _), plane) in enumerate(zip(objects, planes)):
            rle = encode_rle(plane, image.width, image.height)
            ods = struct.pack(">HBB", object_id, 0, 0xC0)
            ods += (len(rle) + 4).to_bytes(3, "big")
            ods += struct.pack(">HH", image.width, image.height)
            ods += rle
            blob += _segment(start, SEG_ODS, ods)
        blob += _segment(start, SEG_END, b"")

        # --- 표시 종료(빈 화면 구성) ---
        blob += _segment(end, SEG_PCS, struct.pack(
            ">HHBHBBBB", canvas_w, canvas_h, 0x10, number * 2 + 1, 0x00, 0x00, 0x00, 0))
        blob += _segment(end, SEG_WDS, wds)
        blob += _segment(end, SEG_END, b"")

    with open(path, "wb") as handle:
        handle.write(bytes(blob))


def quantize_together(images, max_colors: int = 200):
    """여러 그림을 한 팔레트로 묶어 색인 평면들을 만든다.

    실제 자막은 글자 가장자리가 부드럽게 번져 있어(안티에일리어싱) 색이 수십
    가지다. 3색으로 단순화한 시험 자료로는 그 경로를 못 밟아 보므로, 실제와
    비슷하게 여러 색과 여러 단계의 투명도를 쓰는 자료도 만들 수 있어야 한다.
    """
    counts: dict[tuple[int, int, int, int], int] = {}
    for image in images:
        for pixel in image.convert("RGBA").getdata():
            key = _bucket(pixel)
            counts[key] = counts.get(key, 0) + 1

    # 0번은 완전 투명 자리로 비워 둔다.
    chosen = [color for color in sorted(counts, key=counts.get, reverse=True) if color[3] > 0]
    palette = [(0, 0, 0, 0)] + chosen[: max_colors - 1]
    lookup = {color: index for index, color in enumerate(palette)}

    planes = []
    for image in images:
        plane = bytearray(image.width * image.height)
        for offset, pixel in enumerate(image.convert("RGBA").getdata()):
            key = _bucket(pixel)
            if key[3] == 0:
                continue
            plane[offset] = lookup.get(key) or _nearest(key, palette)
        planes.append(bytes(plane))
    return planes, palette


def _bucket(pixel):
    """색을 조금 뭉쳐 팔레트 크기를 줄인다. 실제 인코더도 이렇게 한다."""
    red, green, blue, alpha = pixel
    if alpha < 8:
        return (0, 0, 0, 0)
    return (red & 0xF8, green & 0xF8, blue & 0xF8, alpha & 0xF0 | 0x0F)


def _nearest(color, palette):
    best_index = 1
    best_distance = None
    for index, candidate in enumerate(palette):
        if index == 0:
            continue
        distance = sum((a - b) ** 2 for a, b in zip(color, candidate))
        if best_distance is None or distance < best_distance:
            best_distance, best_index = distance, index
    return best_index
