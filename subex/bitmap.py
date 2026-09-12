"""이미지 자막 공통 자료구조와 OCR 전처리."""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

__all__ = ["BitmapCue", "prepare_for_ocr"]


@dataclass
class BitmapCue:
    start: int              # ms
    end: int                # ms
    image: Image.Image      # RGBA, 글자 주변으로 잘라낸 상태


def prepare_for_ocr(image: Image.Image, scale: int = 2, margin: int = 16) -> Image.Image:
    """자막 비트맵을 Tesseract 가 좋아하는 모양(흰 바탕 + 검은 글자)으로 바꾼다.

    자막 비트맵은 보통 '밝은 글자 + 어두운 테두리 + 투명 배경' 이다.
    검은 배경에 합성하면 글자만 밝게 남고, 그 상태를 반전시키면
    테두리와 배경이 둘 다 흰색으로 뭉개지면서 글자만 검게 남는다.
    """
    if image.mode != "RGBA":
        image = image.convert("RGBA")

    flattened = Image.new("RGB", image.size, (0, 0, 0))
    flattened.paste(image, mask=image.split()[3])

    gray = flattened.convert("L")
    inverted = gray.point(lambda value: 255 - value)

    # 검은 글자 + 흰 배경이 정상. 결과가 전체적으로 어두우면 원본이
    # '어두운 글자 + 밝은 박스' 형태였다는 뜻이므로 한 번 더 뒤집는다.
    histogram = inverted.histogram()
    total = sum(histogram) or 1
    mean = sum(value * count for value, count in enumerate(histogram)) / total
    if mean < 110:
        inverted = inverted.point(lambda value: 255 - value)

    if scale > 1:
        inverted = inverted.resize(
            (inverted.width * scale, inverted.height * scale), Image.LANCZOS
        )

    canvas = Image.new("L", (inverted.width + margin * 2, inverted.height + margin * 2), 255)
    canvas.paste(inverted, (margin, margin))
    return canvas
