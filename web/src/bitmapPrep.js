// 자막 그림을 문자 인식기가 좋아하는 모양(흰 바탕 + 검은 글자)으로 바꾼다.
//
// 파이썬판 subex/bitmap.py 의 prepare_for_ocr 과 같은 생각이다. 자막 그림은
// 대개 '밝은 글자 + 어두운 테두리 + 투명 배경'이다. 검은 배경에 합성하면
// 글자만 밝게 남고, 그 상태를 반전시키면 테두리와 배경이 둘 다 흰색으로
// 뭉개지면서 글자만 검게 남는다.
//
// 캔버스를 쓰지 않고 배열만 다루므로 브라우저와 Node 양쪽에서 똑같이 돈다.

/** 반전 결과가 이 밝기보다 어두우면 원본이 '어두운 글자 + 밝은 박스'였다고 본다. */
const DARK_RESULT_THRESHOLD = 110;

/** 재 볼 기울기 후보. 0(똑바름) ~ 0.4(많이 기울어짐). */
const SLANT_STEP = 0.025;
const SLANT_LIMIT = 0.4;

/** 기울기는 대충만 봐도 되므로 이 높이로 줄여서 잰다. 그만큼 빨라진다. */
const SLANT_PROBE_HEIGHT = 48;

/**
 * 글자 한 줄이 이 높이일 때 인식기가 가장 잘 읽는다. 이보다 크면 줄여서 넣는다.
 *
 * 실측으로 나온 값이다. 같은 자막을 원본 크기를 바꿔 가며(한 줄 25~100픽셀)
 * 재 봤더니, 크게 넣을수록 나빠졌다. 특히 ㅈ 을 ㅅ 으로 읽는 실수가 그렇다.
 *
 *     넣는 크기        글자정확도(최저)   ㅈ↔ㅅ 실수(최다)
 *     2배로 키움            92.10%            14
 *     손대지 않음            93.79%             8
 *     28픽셀로 줄임          96.61%             0
 *
 * 키우는 것은 어느 크기에서도 손해였다. 그래서 줄이기만 하고 키우지는 않는다.
 */
export const TARGET_LINE_HEIGHT = 28;

/**
 * 다만 '확실히 클 때' 만 손댄다. 한 줄이 이보다 작으면 줄여도 나아지지 않고
 * (실측: 27~42픽셀 구간에서는 차이가 없다), 공연히 다시 그리면서 뭉개기만 한다.
 */
const RESIZE_ABOVE = 40;

/** 줄을 가를 때, 잉크가 이 정도는 있어야 글자 줄로 본다(가장 진한 줄 대비). */
const BAND_INK = 0.08;

/**
 * 잘라 낸 줄 위아래에 줄 높이의 이만큼을 남긴다.
 *
 * 딱 붙여 자르면 인식기가 글자의 위아래 기준선을 못 잡아 오히려 틀린다
 * (실측: 기준자료에서 English → Enalish). 반대로 너무 넉넉하면 옆 줄이
 * 딸려 들어와 크게 망가진다(0.25 부터). 0.12~0.18 이 평평하게 좋다.
 */
const BAND_PAD = 0.15;

/**
 * 한 줄 안에서 끊긴 조각을 도로 붙일 때 쓰는 여유.
 *
 * '응' 이나 '요즘' 처럼 위아래로 쌓인 글자는 가운데가 가로로 비어 있다.
 * 글자가 몇 자 안 되는 짧은 줄에서는 그 빈 줄을 메워 줄 다른 글자가 없어서
 * 한 줄이 두 조각으로 끊긴다. 조각 사이 틈(12픽셀)이 줄 사이 틈(11픽셀)과
 * 거의 같아, 틈 크기만으로는 가릴 수 없다. 그래서 '합쳐도 한 줄 높이를
 * 넘지 않으면 같은 줄' 로 본다. 줄 높이는 트랙 전체에서 재므로 믿을 수 있다.
 */
const MERGE_WITHIN = 1.25;

/**
 * 이보다 얇게 잡힌 띠는 글자가 잘린 것으로 보고 한 줄 크기로 넓힌다.
 * 짧은 줄은 잉크가 적어 위아래가 문턱 아래로 깎여 나가기도 한다.
 */
const THIN_BAND = 0.5;

/**
 * 음표(♪) 를 알아보는 데 쓸 본. 16x24 회색 그림을 base64 로 담았다.
 *
 * 인식기의 한국어·영어 자료에는 ♪ 가 아예 없다(글자 목록 1158자 / 112자에 없음).
 * 그래서 인식기는 ♪ 를 죽었다 깨어나도 못 내놓는다. 실제로 영화 한 편에서
 * 한 번도 못 읽었고, 대신 》 ^ _ > 같은 엉뚱한 글자를 내거나 그냥 흘렸다.
 * 그러니 글자로 고칠 수가 없고, 그림에서 직접 찾아내는 수밖에 없다.
 */
const NOTE_TEMPLATE_BASE64 =
  'AAAAAAAAAJPlYgAAAAAAAAAAAAAAAACT5mUBAAAAAAAAAAAAAAAAk/SjHgEAAAAAAAAAAAAAAJP69ZgZAAAAAAAA' +
  'AAAAAACT+v/1jRMAAAAAAAAAAAAAk/r///aACQAAAAAAAAAAAJP5+/7/6W0IAAAAAAAAAACT7a2p8f/bSwIAAAAA' +
  'AAAAk+VjE2zo/qocAAAAAAAAAJPlYgALePjzSwAAAAAAAACT5WIAACO9/48AAAAAAAAAk+ViAAAIfP3AAAAAAAAA' +
  'AJPlYgAAAF3y1gAAAAAAAACT5WIAAABX7NAAAAAAAAAAk+ViAAAAYfWtAAAAAAAAAJPlYgAACH/6awAAAAAAAACT' +
  '5WIAAByyzCwAAAceLzEnn+ViAAJE1WMHAB12x/L33ubnWwAEPlkNACms9P//////3UAAAAAAAACO/f///////bsS' +
  'AAAAAAAA1P///////+RTAAAAAAAAALz//////dpnCgAAAAAAAABGvvDz1JA+CAAAAAAAAAAA';
const NOTE_WIDTH = 16;
const NOTE_HEIGHT = 24;

/**
 * 본과 얼마나 닮아야 음표로 볼지. 실측으로 두 무리가 확실히 갈린다.
 * 음표 0.49~0.74 / 한글 -0.14~0.27 / 대시(-) -0.09~-0.03 — 그 사이에 둔다.
 */
const NOTE_MATCH = 0.38;

let noteTemplate = null;
function template() {
  if (noteTemplate) return noteTemplate;
  const raw = atob(NOTE_TEMPLATE_BASE64);
  noteTemplate = new Float64Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) noteTemplate[i] = raw.charCodeAt(i) / 255;
  return noteTemplate;
}

export function prepareForOcr(image, options = {}) {
  const prepared = toGrayscale(image, options);
  if (!prepared) return null;
  return withMargin(prepared, options.margin ?? 16);
}

/** 회색 그림에 흰 여백을 둘러 RGBA 로 내놓는다. 인식기에 넣을 마지막 모양이다. */
function withMargin({ data, width, height }, margin) {
  const outWidth = width + margin * 2;
  const outHeight = height + margin * 2;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4).fill(255);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = data[y * width + x];
      const base = ((y + margin) * outWidth + (x + margin)) * 4;
      out[base] = value;
      out[base + 1] = value;
      out[base + 2] = value;
      out[base + 3] = 255;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
}

/**
 * 자막 한 덩이를 '글자 줄' 별로 잘라 인식기에 넣을 모양으로 만든다.
 *
 * 통째로 넣으면 인식기가 줄 배치를 제 나름대로 해석하면서, 가운데 맞춘
 * 자막의 들쭉날쭉한 여백을 글자로 오해해 앞에 점이나 밑줄을 만들어 내고
 * 때로는 한 줄을 통째로 흘린다. 줄마다 따로 넣으면 그 일이 없어진다.
 * (실측: 정답지 64줄에서 오류 21자 → 8자)
 *
 * @returns [{ image, prefix }] - prefix 는 그림에서 찾아낸 음표(♪) 등
 */
export function prepareLines(image, options = {}) {
  const {
    margin = 16,
    findNotes = true,
    lineHeight = null,
    targetLineHeight = TARGET_LINE_HEIGHT,
  } = options;

  const whole = toGrayscale(image, { ...options, targetLineHeight: 0 });
  if (!whole) return [];

  const bands = inkBands(whole.data, whole.width, whole.height);
  // 줄 높이는 트랙 전체에서 잰 값을 쓴다. 없으면 이 그림 하나로 가늠한다.
  const track = lineHeight || Math.max(...bands.map(([a, b]) => b - a));

  // 한 줄 안에서 끊긴 조각을 도로 붙인다.
  const joined = [[...bands[0]]];
  for (const [start, end] of bands.slice(1)) {
    if (end - joined[joined.length - 1][0] <= track * MERGE_WITHIN) {
      joined[joined.length - 1][1] = end;
    } else joined.push([start, end]);
  }

  const lines = [];
  joined.forEach(([bandStart, bandEnd], index) => {
    const above = index > 0 ? joined[index - 1][1] : 0;
    const below = index + 1 < joined.length ? joined[index + 1][0] : whole.height;

    let start = bandStart;
    let end = bandEnd;
    // 너무 얇게 잡힌 띠는 글자가 잘린 것이다. 한 줄 크기로 넓힌다.
    if (end - start < track * THIN_BAND) {
      const centre = (start + end) / 2;
      start = Math.max(above, centre - track / 2);
      end = Math.min(below, centre + track / 2);
    }

    let pad = Math.max(2, Math.round((end - start) * BAND_PAD));
    // 옆 줄까지 넘어가지 않도록, 이웃과의 틈의 절반을 넘지 않게 한다.
    if (index > 0) pad = Math.min(pad, Math.max(1, Math.floor((start - above) / 2)));
    if (index + 1 < joined.length) pad = Math.min(pad, Math.max(1, Math.floor((below - end) / 2)));

    const top = Math.max(0, Math.round(start - pad));
    const bottom = Math.min(whole.height, Math.round(end + pad));
    const height = bottom - top;
    const cut = new Uint8ClampedArray(whole.width * height);
    cut.set(whole.data.subarray(top * whole.width, bottom * whole.width));

    let piece = { data: cut, width: whole.width, height };
    let prefix = '';
    if (findNotes) {
      const { line, note } = stripLeadingNote(piece);
      piece = line;
      if (note) prefix = '\u266a';
    }

    // 글자가 너무 크면 인식기가 오히려 못 읽는다. 확실히 큰 것만 줄인다.
    if (targetLineHeight && track > RESIZE_ABOVE) {
      const factor = targetLineHeight / track;
      piece = resize(piece.data, piece.width, piece.height,
        Math.max(1, Math.round(piece.width * factor)),
        Math.max(1, Math.round(piece.height * factor)));
    }

    lines.push({ image: withMargin(piece, margin), prefix });
  });

  return lines;
}

/**
 * 트랙 전체에서 글자 한 줄의 높이를 잰다.
 *
 * 자막은 한 트랙 안에서 글자 크기가 일정하므로, 여러 자막에서 재어 가운데
 * 값을 쓰면 아주 안정적이다(실측: 자막 1,578개에서 중앙값 49픽셀, 사분위
 * 48~49픽셀). 자막 하나만 보고 재면 짧은 줄에서 크게 어긋난다.
 *
 * 한 자막 안에서는 '가장 큰 띠' 를 쓴다. 조각난 띠보다 온전한 줄일 가능성이
 * 높기 때문이다. 표본 몇 개면 충분하므로 전부 보지는 않는다.
 */
export function measureLineHeight(images, sample = 120) {
  const list = [...images];
  if (!list.length) return 0;

  const step = Math.max(1, Math.floor(list.length / sample));
  const heights = [];
  for (let i = 0; i < list.length && heights.length < sample; i += step) {
    const gray = toGrayscale(list[i], { targetLineHeight: 0, straighten: false });
    if (!gray) continue;
    const bands = inkBands(gray.data, gray.width, gray.height);
    heights.push(Math.max(...bands.map(([a, b]) => b - a)));
  }
  if (!heights.length) return 0;

  heights.sort((a, b) => a - b);
  const middle = heights.length >> 1;
  return heights.length % 2 ? heights[middle] : (heights[middle - 1] + heights[middle]) / 2;
}

/** 자막 그림을 '흰 바탕 검은 글자' 회색 그림으로. 여백은 붙이지 않는다. */
function toGrayscale(
  image,
  { targetLineHeight = TARGET_LINE_HEIGHT, straighten = true } = {},
) {
  const { width, height, data } = image;
  if (!width || !height) return null;

  const gray = new Uint8ClampedArray(width * height);
  let total = 0;
  for (let i = 0; i < gray.length; i += 1) {
    const base = i * 4;
    const alpha = data[base + 3];
    // 검은 배경에 알파 합성한 뒤 밝기를 구한다.
    const red = (data[base] * alpha) / 255;
    const green = (data[base + 1] * alpha) / 255;
    const blue = (data[base + 2] * alpha) / 255;
    const luma = (red * 299 + green * 587 + blue * 114) / 1000;
    const inverted = 255 - luma;
    gray[i] = inverted;
    total += inverted;
  }

  const mean = total / gray.length;
  if (mean < DARK_RESULT_THRESHOLD) {
    for (let i = 0; i < gray.length; i += 1) gray[i] = 255 - gray[i];
  }

  const slant = straighten ? estimateSlant(gray, width, height) : 0;

  // 글자가 너무 크면 인식기가 오히려 못 읽는다. 확실히 큰 것만 줄인다.
  let fitted = { data: gray, width, height };
  if (targetLineHeight) {
    const line = textLineHeight(gray, width, height);
    const factor = targetLineHeight / line;
    if (line > RESIZE_ABOVE) {
      fitted = resize(gray, width, height,
        Math.max(1, Math.round(width * factor)), Math.max(1, Math.round(height * factor)));
    }
  }

  return deslant(fitted, slant);
}

/** 겹선형 보간. 자막 글자는 부드럽게 키워야 인식이 잘 된다. */
function resize(source, width, height, targetWidth, targetHeight) {
  const out = new Uint8ClampedArray(targetWidth * targetHeight);
  const scaleX = width / targetWidth;
  const scaleY = height / targetHeight;

  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY = Math.min(height - 1, Math.max(0, (y + 0.5) * scaleY - 0.5));
    const y0 = Math.floor(sourceY);
    const y1 = Math.min(height - 1, y0 + 1);
    const weightY = sourceY - y0;

    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = Math.min(width - 1, Math.max(0, (x + 0.5) * scaleX - 0.5));
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const weightX = sourceX - x0;

      const top = source[y0 * width + x0] * (1 - weightX) + source[y0 * width + x1] * weightX;
      const bottom = source[y1 * width + x0] * (1 - weightX) + source[y1 * width + x1] * weightX;
      out[y * targetWidth + x] = top * (1 - weightY) + bottom * weightY;
    }
  }
  return { data: out, width: targetWidth, height: targetHeight };
}

/**
 * 글자가 얼마나 기울었는지 잰다. 안 기울었으면 0.
 *
 * 바로 선 글자는 세로획이 같은 열에 모인다. 그래서 열마다 잉크량을 재면
 * 획이 있는 열과 없는 열의 차이가 커진다. 여러 기울기로 되돌려 보고
 * 그 차이가 가장 큰 것을 고른다.
 *
 * 재는 데는 작은 그림이면 충분하다. 가로·세로를 같은 비율로 줄여야
 * 기울기 값이 그대로 유지된다.
 */
export function estimateSlant(gray, width, height) {
  let probe = { data: gray, width, height };
  if (height > SLANT_PROBE_HEIGHT) {
    const shrink = SLANT_PROBE_HEIGHT / height;
    probe = resize(gray, width, height, Math.max(1, Math.round(width * shrink)), SLANT_PROBE_HEIGHT);
  }

  let bestSlant = 0;
  let bestScore = -1;
  const steps = Math.round(SLANT_LIMIT / SLANT_STEP);

  for (let step = 0; step <= steps; step += 1) {
    const slant = step * SLANT_STEP;
    const columns = new Float64Array(probe.width + Math.ceil(slant * probe.height) + 2);

    // 잉크(255 - 밝기)를 기울인 만큼 옆으로 밀어 가며 열별로 모은다.
    for (let y = 0; y < probe.height; y += 1) {
      const shift = Math.round(slant * y);
      const row = y * probe.width;
      for (let x = 0; x < probe.width; x += 1) columns[x + shift] += 255 - probe.data[row + x];
    }

    let score = 0;
    for (let x = 0; x + 1 < columns.length; x += 1) {
      const difference = columns[x + 1] - columns[x];
      score += difference * difference;
    }
    if (score > bestScore) {
      bestScore = score;
      bestSlant = slant;
    }
  }
  return bestSlant;
}

/**
 * 기울어진 글자를 바로 세운다. 아래는 그대로 두고 위를 왼쪽으로 민다.
 * 캔버스를 기운 만큼 넓혀 자리를 맞추므로 왼쪽 위 획이 잘리지 않는다.
 */
export function deslant(image, slant) {
  if (slant <= 0) return image;
  const { data, width, height } = image;
  const outWidth = width + Math.ceil(slant * height) + 2;
  const out = new Uint8ClampedArray(outWidth * height).fill(255);

  for (let y = 0; y < height; y += 1) {
    const shift = slant * y;
    const row = y * width;
    const outRow = y * outWidth;
    for (let x = 0; x < outWidth; x += 1) {
      const sourceX = x - shift;
      if (sourceX < 0 || sourceX > width - 1) continue;   // 바깥은 흰 바탕 그대로
      const x0 = Math.floor(sourceX);
      const x1 = Math.min(width - 1, x0 + 1);
      const weight = sourceX - x0;
      out[outRow + x] = data[row + x0] * (1 - weight) + data[row + x1] * weight;
    }
  }
  return { data: out, width: outWidth, height };
}

/**
 * 글자 한 줄의 높이를 잰다.
 *
 * 가로로 잉크가 있는 띠를 찾아 그 중앙값을 쓴다. 자막은 한 줄이나 두 줄이고
 * 줄 사이가 비어 있으므로 이렇게 세면 글자 크기가 나온다.
 */
export function textLineHeight(gray, width, height) {
  const rows = new Float64Array(height);
  let peak = 0;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;
    for (let x = 0; x < width; x += 1) sum += 255 - gray[row + x];
    rows[y] = sum;
    if (sum > peak) peak = sum;
  }
  if (peak <= 0) return height;

  const limit = peak * 0.08;
  const bands = [];
  let start = null;
  for (let y = 0; y < height; y += 1) {
    if (rows[y] > limit && start === null) start = y;
    else if (rows[y] <= limit && start !== null) {
      bands.push(y - start);
      start = null;
    }
  }
  if (start !== null) bands.push(height - start);

  const kept = bands.filter((band) => band >= 4);   // 점·따옴표 같은 것은 뺀다
  if (!kept.length) return height;

  kept.sort((a, b) => a - b);
  const middle = kept.length >> 1;
  return kept.length % 2 ? kept[middle] : (kept[middle - 1] + kept[middle]) / 2;
}

/** 잉크가 있는 가로 띠(글자 줄)의 위·아래 위치를 찾는다. */
export function inkBands(gray, width, height) {
  const rows = new Float64Array(height);
  let peak = 0;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const row = y * width;
    for (let x = 0; x < width; x += 1) sum += 255 - gray[row + x];
    rows[y] = sum;
    if (sum > peak) peak = sum;
  }
  if (peak <= 0) return [[0, height]];

  const limit = peak * BAND_INK;
  const found = [];
  let start = null;
  for (let y = 0; y < height; y += 1) {
    if (rows[y] > limit && start === null) start = y;
    else if (rows[y] <= limit && start !== null) {
      found.push([start, y]);
      start = null;
    }
  }
  if (start !== null) found.push([start, height]);

  const kept = found.filter(([a, b]) => b - a >= 8);
  if (!kept.length) return [[0, height]];

  // 받침이 떨어져 보여 끊긴 것은 도로 붙인다.
  const merged = [kept[0]];
  for (const [a, b] of kept.slice(1)) {
    if (a - merged[merged.length - 1][1] <= 4) merged[merged.length - 1][1] = b;
    else merged.push([a, b]);
  }
  return merged;
}

function correlation(values, tpl) {
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < values.length; i += 1) {
    meanA += values[i];
    meanB += tpl[i];
  }
  meanA /= values.length;
  meanB /= values.length;

  let top = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < values.length; i += 1) {
    const a = values[i] - meanA;
    const b = tpl[i] - meanB;
    top += a * b;
    sumA += a * a;
    sumB += b * b;
  }
  const spread = Math.sqrt(sumA * sumB);
  return spread ? top / spread : 0;
}

/**
 * 줄 맨 앞이 음표면 잘라 내고, 잘라 냈는지를 함께 돌려준다.
 *
 * 맨 앞 덩어리를 같은 크기로 맞춰 본과 견준다. 인식기가 ♪ 를 못 읽으니
 * 글자가 아니라 그림에서 찾아야 하고, 찾았으면 그림에서 지워야 한다.
 * 안 지우면 인식기가 그 자리에 엉뚱한 글자를 만들어 낸다.
 */
export function stripLeadingNote(line) {
  const { data, width, height } = line;
  const columns = new Float64Array(width);
  let peak = 0;
  for (let x = 0; x < width; x += 1) {
    let sum = 0;
    for (let y = 0; y < height; y += 1) sum += 255 - data[y * width + x];
    columns[x] = sum;
    if (sum > peak) peak = sum;
  }
  if (peak <= 0) return { line, note: false };

  const limit = peak * 0.02;
  let first = -1;
  for (let x = 0; x < width; x += 1) if (columns[x] > limit) { first = x; break; }
  if (first < 0) return { line, note: false };

  // 빈칸이 충분히 이어지면 거기서 첫 덩어리가 끝난 것으로 본다.
  const blankNeeded = Math.max(3, Math.round(height * 0.12));
  let blank = 0;
  let end = width;
  for (let x = first; x < width; x += 1) {
    if (columns[x] <= limit) {
      blank += 1;
      if (blank >= blankNeeded) { end = x - blank + 1; break; }
    } else blank = 0;
  }

  // 덩어리를 잉크가 있는 만큼만 잘라 본과 같은 크기로 맞춘다.
  let top = height;
  let bottom = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = first; x < end; x += 1) {
      if (255 - data[y * width + x] > 0) { if (y < top) top = y; if (y > bottom) bottom = y; break; }
    }
  }
  if (bottom < top) return { line, note: false };

  const headWidth = end - first;
  const headHeight = bottom - top + 1;
  const head = new Uint8ClampedArray(headWidth * headHeight);
  for (let y = 0; y < headHeight; y += 1) {
    for (let x = 0; x < headWidth; x += 1) {
      head[y * headWidth + x] = data[(top + y) * width + first + x];
    }
  }
  const small = resize(head, headWidth, headHeight, NOTE_WIDTH, NOTE_HEIGHT);
  const values = new Float64Array(small.data.length);
  for (let i = 0; i < values.length; i += 1) values[i] = (255 - small.data[i]) / 255;

  if (correlation(values, template()) < NOTE_MATCH) return { line, note: false };

  const restWidth = width - end;
  if (restWidth <= 4) return { line, note: true };
  const rest = new Uint8ClampedArray(restWidth * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < restWidth; x += 1) rest[y * restWidth + x] = data[y * width + end + x];
  }
  return { line: { data: rest, width: restWidth, height }, note: true };
}
