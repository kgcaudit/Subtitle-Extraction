"""이미지 자막 공통 자료구조와 OCR 전처리."""

from __future__ import annotations

from dataclasses import dataclass

from PIL import Image

__all__ = ["BitmapCue", "prepare_for_ocr", "estimate_slant", "deslant"]

#: 기울기를 재 볼 후보와 간격. 0(똑바름) ~ 0.4(많이 기울어짐).
_SLANT_STEP = 0.025
_SLANT_LIMIT = 0.4

#: 기울기는 대충만 봐도 되므로 이 높이로 줄여서 잰다. 그만큼 빨라진다.
_SLANT_PROBE_HEIGHT = 48


@dataclass
class BitmapCue:
    start: int              # ms
    end: int                # ms
    image: Image.Image      # RGBA, 글자 주변으로 잘라낸 상태


def deslant(image: Image.Image, slant: float, resample=Image.BICUBIC) -> Image.Image:
    """기울어진 글자를 바로 세운다. 아래는 그대로 두고 위를 왼쪽으로 민다.

    캔버스를 기운 만큼 넓히고 자리를 맞춰, 왼쪽 위 획이 잘려 나가지 않게 한다.
    """
    if slant <= 0:
        return image
    width, height = image.size
    grown = width + int(slant * height) + 2
    return image.transform(
        (grown, height), Image.AFFINE, (1, -slant, 0, 0, 1, 0),
        resample=resample, fillcolor=255,
    )


def estimate_slant(image: Image.Image) -> float:
    """글자가 얼마나 기울었는지 잰다. 안 기울었으면 0.

    바로 선 글자는 세로획이 같은 열에 모인다. 그래서 열마다 잉크량을 재면
    획이 있는 열과 없는 열의 차이가 커진다. 여러 기울기로 되돌려 보고
    그 차이가 가장 큰 것을 고른다.

    재는 일은 작은 그림으로 한다. 열별 잉크량은 '높이 1로 줄이기' 로 구하는데,
    그러면 합산이 Pillow 안쪽(C)에서 끝나 파이썬 반복문을 타지 않는다.
    가로·세로를 같은 비율로 줄여야 기울기 값이 그대로 유지된다.
    """
    probe = image
    if probe.height > _SLANT_PROBE_HEIGHT:
        shrink = _SLANT_PROBE_HEIGHT / probe.height
        probe = probe.resize(
            (max(1, round(probe.width * shrink)), _SLANT_PROBE_HEIGHT), Image.BILINEAR
        )
    probe = probe.convert("L")

    best_slant, best_score = 0.0, -1.0
    for step in range(int(round(_SLANT_LIMIT / _SLANT_STEP)) + 1):
        slant = step * _SLANT_STEP
        straightened = deslant(probe, slant, resample=Image.NEAREST)
        columns = straightened.resize((straightened.width, 1), Image.BOX).getdata()
        score = sum((columns[i + 1] - columns[i]) ** 2 for i in range(len(columns) - 1))
        if score > best_score:
            best_slant, best_score = slant, score
    return best_slant


def prepare_for_ocr(
    image: Image.Image, scale: int = 2, margin: int = 16, straighten: bool = True
) -> Image.Image:
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

    # 기울기는 작은 그림에서 재고(빠르다), 되돌리기는 키운 뒤에 한다(덜 뭉갠다).
    slant = estimate_slant(inverted) if straighten else 0.0

    if scale > 1:
        inverted = inverted.resize(
            (inverted.width * scale, inverted.height * scale), Image.LANCZOS
        )
    inverted = deslant(inverted, slant)

    canvas = Image.new("L", (inverted.width + margin * 2, inverted.height + margin * 2), 255)
    canvas.paste(inverted, (margin, margin))
    return canvas
