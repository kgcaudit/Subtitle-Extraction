"""이미지 자막 공통 자료구조와 OCR 전처리."""

from __future__ import annotations

import statistics
from dataclasses import dataclass

from PIL import Image

__all__ = [
    "BitmapCue", "PreparedLine", "prepare_for_ocr", "prepare_lines",
    "estimate_slant", "deslant", "text_line_height", "measure_line_height",
]

#: 글자 한 줄이 이 높이일 때 인식기가 가장 잘 읽는다. 이보다 크면 줄여서 넣는다.
#:
#: 실측으로 나온 값이다. 같은 자막을 원본 크기를 바꿔 가며(한 줄 25~100픽셀)
#: 재 봤더니, 크게 넣을수록 나빠졌다. 특히 ㅈ 을 ㅅ 으로 읽는 실수가 그렇다.
#:
#:     넣는 크기        글자정확도(최저)   ㅈ↔ㅅ 실수(최다)
#:     2배로 키움            92.10%            14
#:     손대지 않음            93.79%             8
#:     28픽셀로 줄임          96.61%             0
#:
#: 키우는 것은 어느 크기에서도 손해였다. 그래서 줄이기만 하고 키우지는 않는다.
_TARGET_LINE_HEIGHT = 28

#: 다만 '확실히 클 때' 만 손댄다. 한 줄이 이보다 작으면 줄여도 나아지지 않고
#: (실측: 27~42픽셀 구간에서는 차이가 없다), 공연히 다시 그리면서 뭉개기만 한다.
_RESIZE_ABOVE = 40

#: 기울기를 재 볼 후보와 간격. 0(똑바름) ~ 0.4(많이 기울어짐).
_SLANT_STEP = 0.025
_SLANT_LIMIT = 0.4

#: 기울기는 대충만 봐도 되므로 이 높이로 줄여서 잰다. 그만큼 빨라진다.
_SLANT_PROBE_HEIGHT = 48


#: 음표(♪) 를 알아보는 데 쓸 본. 16x24 회색 그림을 base64 로 담았다.
#:
#: 인식기의 한국어·영어 자료에는 ♪ 가 아예 없다(글자 목록 1158자 / 112자에 없음).
#: 그래서 인식기는 ♪ 를 죽었다 깨어나도 못 내놓는다. 실제로 영화 한 편에서
#: 한 번도 못 읽었고, 대신 》 ^ _ > 같은 엉뚱한 글자를 내거나 그냥 흘렸다.
#: 그러니 글자로 고칠 수가 없고, 그림에서 직접 찾아내는 수밖에 없다.
_NOTE_TEMPLATE_BASE64 = (
    "AAAAAAAAAJPlYgAAAAAAAAAAAAAAAACT5mUBAAAAAAAAAAAAAAAAk/SjHgEAAAAAAAAAAAAAAJP69ZgZAAAAAAAA"
    "AAAAAACT+v/1jRMAAAAAAAAAAAAAk/r///aACQAAAAAAAAAAAJP5+/7/6W0IAAAAAAAAAACT7a2p8f/bSwIAAAAA"
    "AAAAk+VjE2zo/qocAAAAAAAAAJPlYgALePjzSwAAAAAAAACT5WIAACO9/48AAAAAAAAAk+ViAAAIfP3AAAAAAAAA"
    "AJPlYgAAAF3y1gAAAAAAAACT5WIAAABX7NAAAAAAAAAAk+ViAAAAYfWtAAAAAAAAAJPlYgAACH/6awAAAAAAAACT"
    "5WIAAByyzCwAAAceLzEnn+ViAAJE1WMHAB12x/L33ubnWwAEPlkNACms9P//////3UAAAAAAAACO/f///////bsS"
    "AAAAAAAA1P///////+RTAAAAAAAAALz//////dpnCgAAAAAAAABGvvDz1JA+CAAAAAAAAAAA"
)
_NOTE_SIZE = (16, 24)

#: 본과 얼마나 닮아야 음표로 볼지. 실측으로 두 무리가 확실히 갈린다.
#: 음표 0.49~0.74 / 한글 -0.14~0.27 / 대시(-) -0.09~-0.03 — 그 사이에 둔다.
_NOTE_MATCH = 0.38

#: 줄을 가를 때, 잉크가 이 정도는 있어야 글자 줄로 본다(가장 진한 줄 대비).
_BAND_INK = 0.08

#: 한 줄 안에서 끊긴 조각을 도로 붙일 때 쓰는 여유.
#:
#: '응' 이나 '요즘' 처럼 위아래로 쌓인 글자는 가운데가 가로로 비어 있다.
#: 글자가 몇 자 안 되는 짧은 줄에서는 그 빈 줄을 메워 줄 다른 글자가 없어서
#: 한 줄이 두 조각으로 끊긴다. 조각 사이 틈(12픽셀)이 줄 사이 틈(11픽셀)과
#: 거의 같아, 틈 크기만으로는 가릴 수 없다. 그래서 '합쳐도 한 줄 높이를
#: 넘지 않으면 같은 줄' 로 본다. 줄 높이는 트랙 전체에서 재므로 믿을 수 있다.
_MERGE_WITHIN = 1.25

#: 이보다 얇게 잡힌 띠는 글자가 잘린 것으로 보고 한 줄 크기로 넓힌다.
#: 짧은 줄은 잉크가 적어 위아래가 문턱 아래로 깎여 나가기도 한다.
_THIN_BAND = 0.5

#: 잘라 낸 줄 위아래에 줄 높이의 이만큼을 남긴다.
#:
#: 딱 붙여 자르면 인식기가 글자의 위아래 기준선을 못 잡아 오히려 틀린다
#: (실측: 기준자료에서 English → Enalish). 반대로 너무 넉넉하면 옆 줄이
#: 딸려 들어와 크게 망가진다(0.25 부터). 0.12~0.18 이 평평하게 좋다.
_BAND_PAD = 0.15


@dataclass
class PreparedLine:
    """인식기에 넣을 자막 한 줄."""

    image: Image.Image
    prefix: str = ""        # 그림에서 찾아낸 음표 등, 인식 결과 앞에 붙일 것


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


def text_line_height(image: Image.Image) -> float:
    """글자 한 줄의 높이를 잰다.

    가로로 잉크가 있는 띠를 찾아 그 중앙값을 쓴다. 자막은 한 줄이나 두 줄이고
    줄 사이가 비어 있으므로 이렇게 세면 글자 크기가 나온다.
    """
    width, height = image.size
    pixels = image.load()
    rows = [sum(255 - pixels[x, y] for x in range(width)) for y in range(height)]
    peak = max(rows) if rows else 0
    if peak <= 0:
        return float(height)

    limit = peak * 0.08
    bands: list[int] = []
    start = None
    for y, value in enumerate(rows):
        if value > limit and start is None:
            start = y
        elif value <= limit and start is not None:
            bands.append(y - start)
            start = None
    if start is not None:
        bands.append(height - start)

    bands = [band for band in bands if band >= 4]     # 점·따옴표 같은 것은 뺀다
    return float(statistics.median(bands)) if bands else float(height)


def _ink_bands(image: Image.Image) -> list[list[int]]:
    """잉크가 있는 가로 띠(글자 줄)의 위·아래 위치를 찾는다."""
    width, height = image.size
    pixels = image.load()
    rows = [sum(255 - pixels[x, y] for x in range(width)) for y in range(height)]
    peak = max(rows) if rows else 0
    if peak <= 0:
        return [[0, height]]

    limit = peak * _BAND_INK
    bands: list[list[int]] = []
    start = None
    for y, value in enumerate(rows):
        if value > limit and start is None:
            start = y
        elif value <= limit and start is not None:
            bands.append([start, y])
            start = None
    if start is not None:
        bands.append([start, height])

    bands = [band for band in bands if band[1] - band[0] >= 8]
    if not bands:
        return [[0, height]]

    # 받침이 떨어져 보여 끊긴 것은 도로 붙인다.
    merged = [bands[0]]
    for start_y, end_y in bands[1:]:
        if start_y - merged[-1][1] <= 4:
            merged[-1][1] = end_y
        else:
            merged.append([start_y, end_y])
    return merged


def _correlation(values: list[float], template: list[float]) -> float:
    count = len(values)
    mean_a = sum(values) / count
    mean_b = sum(template) / count
    left = [value - mean_a for value in values]
    right = [value - mean_b for value in template]
    spread = (sum(a * a for a in left) * sum(b * b for b in right)) ** 0.5
    return sum(a * b for a, b in zip(left, right)) / spread if spread else 0.0


def _note_template() -> list[float]:
    import base64

    return [value / 255 for value in base64.b64decode(_NOTE_TEMPLATE_BASE64)]


def strip_leading_note(line: Image.Image) -> tuple[Image.Image, bool]:
    """줄 맨 앞이 음표면 잘라 내고, 잘라 냈는지를 함께 돌려준다.

    맨 앞 덩어리를 같은 크기로 맞춰 본과 견준다. 인식기가 ♪ 를 못 읽으니
    글자가 아니라 그림에서 찾아야 하고, 찾았으면 그림에서 지워야 한다.
    안 지우면 인식기가 그 자리에 엉뚱한 글자를 만들어 낸다.
    """
    width, height = line.size
    pixels = line.load()
    columns = [sum(255 - pixels[x, y] for y in range(height)) for x in range(width)]
    peak = max(columns) if columns else 0
    if peak <= 0:
        return line, False

    limit = peak * 0.02
    first = next((x for x, value in enumerate(columns) if value > limit), None)
    if first is None:
        return line, False

    # 빈칸이 충분히 이어지면 거기서 첫 덩어리가 끝난 것으로 본다.
    blank_needed = max(3, round(height * 0.12))
    blank = 0
    end = width
    for x in range(first, width):
        if columns[x] <= limit:
            blank += 1
            if blank >= blank_needed:
                end = x - blank + 1
                break
        else:
            blank = 0

    head = line.crop((first, 0, end, height))
    box = Image.eval(head, lambda value: 255 - value).getbbox()
    if not box:
        return line, False

    scaled = head.crop(box).resize(_NOTE_SIZE, Image.BILINEAR)
    values = [(255 - value) / 255 for value in scaled.getdata()]
    if _correlation(values, _note_template()) < _NOTE_MATCH:
        return line, False

    rest = line.crop((end, 0, width, height))
    return (rest, True) if rest.width > 4 else (line, True)


def measure_line_height(images, sample: int = 120) -> float:
    """트랙 전체에서 글자 한 줄의 높이를 잰다.

    자막은 한 트랙 안에서 글자 크기가 일정하므로, 여러 자막에서 재어 가운데
    값을 쓰면 아주 안정적이다(실측: 자막 1,578개에서 중앙값 49픽셀, 사분위
    48~49픽셀). 자막 하나만 보고 재면 짧은 줄에서 크게 어긋난다.

    한 자막 안에서는 '가장 큰 띠' 를 쓴다. 조각난 띠보다 온전한 줄일 가능성이
    높기 때문이다. 표본 몇 개면 충분하므로 전부 보지는 않는다.
    """
    images = list(images)
    if not images:
        return 0.0

    step = max(1, len(images) // sample)
    heights = []
    for image in images[::step][:sample]:
        prepared = prepare_for_ocr(image, target_line_height=None, margin=0)
        heights.append(max(end - start for start, end in _ink_bands(prepared)))
    return float(statistics.median(heights)) if heights else 0.0


def prepare_lines(
    image: Image.Image,
    line_height: float | None = None,
    target_line_height: int | None = _TARGET_LINE_HEIGHT,
    margin: int = 16,
    straighten: bool = True,
    find_notes: bool = True,
) -> list[PreparedLine]:
    """자막 한 덩이를 '글자 줄' 별로 잘라 인식기에 넣을 모양으로 만든다.

    통째로 넣으면 인식기가 줄 배치를 제 나름대로 해석하면서, 가운데 맞춘
    자막의 들쭉날쭉한 여백을 글자로 오해해 앞에 점이나 밑줄을 만들어 내고
    때로는 한 줄을 통째로 흘린다. 줄마다 따로 넣으면 그 일이 없어진다.
    (실측: 정답지 64줄에서 오류 21자 → 11자)
    """
    whole = prepare_for_ocr(image, target_line_height=None, margin=0, straighten=straighten)

    bands = _ink_bands(whole)
    # 줄 높이는 트랙 전체에서 잰 값을 쓴다. 없으면 이 그림 하나로 가늠한다.
    track = line_height or max(end - start for start, end in bands)

    # 한 줄 안에서 끊긴 조각을 도로 붙인다.
    joined = [list(bands[0])]
    for start, end in bands[1:]:
        if end - joined[-1][0] <= track * _MERGE_WITHIN:
            joined[-1][1] = end
        else:
            joined.append([start, end])

    lines: list[PreparedLine] = []
    for index, (start, end) in enumerate(joined):
        above = joined[index - 1][1] if index > 0 else 0
        below = joined[index + 1][0] if index + 1 < len(joined) else whole.height

        # 너무 얇게 잡힌 띠는 글자가 잘린 것이다. 한 줄 크기로 넓힌다.
        if end - start < track * _THIN_BAND:
            centre = (start + end) / 2
            start = max(above, centre - track / 2)
            end = min(below, centre + track / 2)

        pad = max(2, round((end - start) * _BAND_PAD))
        # 옆 줄까지 넘어가지 않도록, 이웃과의 틈의 절반을 넘지 않게 한다.
        if index > 0:
            pad = min(pad, max(1, int(start - above) // 2))
        if index + 1 < len(joined):
            pad = min(pad, max(1, int(below - end) // 2))

        strip = whole.crop(
            (0, max(0, int(start - pad)), whole.width, min(whole.height, int(end + pad)))
        )

        prefix = ""
        if find_notes:
            strip, found = strip_leading_note(strip)
            if found:
                prefix = "\u266a"

        # 글자가 너무 크면 인식기가 오히려 못 읽는다. 확실히 큰 것만 줄인다.
        if target_line_height and track > _RESIZE_ABOVE:
            factor = target_line_height / track
            strip = strip.resize(
                (max(1, round(strip.width * factor)), max(1, round(strip.height * factor))),
                Image.LANCZOS,
            )

        canvas = Image.new("L", (strip.width + margin * 2, strip.height + margin * 2), 255)
        canvas.paste(strip, (margin, margin))
        lines.append(PreparedLine(image=canvas, prefix=prefix))
    return lines


def prepare_for_ocr(
    image: Image.Image,
    target_line_height: int | None = _TARGET_LINE_HEIGHT,
    margin: int = 16,
    straighten: bool = True,
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

    slant = estimate_slant(inverted) if straighten else 0.0

    # 글자가 너무 크면 인식기가 오히려 못 읽는다. 확실히 큰 것만 줄인다.
    if target_line_height:
        line = text_line_height(inverted)
        factor = target_line_height / line
        if line > _RESIZE_ABOVE:
            inverted = inverted.resize(
                (max(1, round(inverted.width * factor)), max(1, round(inverted.height * factor))),
                Image.LANCZOS,
            )

    inverted = deslant(inverted, slant)

    canvas = Image.new("L", (inverted.width + margin * 2, inverted.height + margin * 2), 255)
    canvas.paste(inverted, (margin, margin))
    return canvas
