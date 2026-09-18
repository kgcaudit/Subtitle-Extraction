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

export function prepareForOcr(
  image,
  { targetLineHeight = TARGET_LINE_HEIGHT, margin = 16, straighten = true } = {},
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

  const scaled = deslant(fitted, slant);

  // 인식기는 글자가 가장자리에 붙어 있으면 잘 못 읽는다. 흰 여백을 둘러 준다.
  const outWidth = scaled.width + margin * 2;
  const outHeight = scaled.height + margin * 2;
  const out = new Uint8ClampedArray(outWidth * outHeight * 4).fill(255);
  for (let y = 0; y < scaled.height; y += 1) {
    for (let x = 0; x < scaled.width; x += 1) {
      const value = scaled.data[y * scaled.width + x];
      const base = ((y + margin) * outWidth + (x + margin)) * 4;
      out[base] = value;
      out[base + 1] = value;
      out[base + 2] = value;
      out[base + 3] = 255;
    }
  }
  return { width: outWidth, height: outHeight, data: out };
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
