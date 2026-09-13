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

export function prepareForOcr(image, { scale = 2, margin = 16 } = {}) {
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

  const scaled = scale > 1 ? resize(gray, width, height, width * scale, height * scale) : {
    data: gray,
    width,
    height,
  };

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
