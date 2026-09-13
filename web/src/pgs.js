// PGS(블루레이) 그림 자막 해독기. 파이썬판 subex/pgs.py 를 옮긴 것이다.
//
// 하나의 화면 단위(display set)는 PCS → WDS → PDS → ODS → END 순으로 온다.
// 합성 객체가 하나도 없는 PCS 는 '화면 지우기'이므로 직전 자막의 끝 시각이 된다.
//
// 컨테이너(MKV) 안에서는 각 샘플이 화면 단위 하나를 통째로 담고 있고 시각은
// 컨테이너가 들고 있다. 독립된 .sup 파일에서는 세그먼트마다 앞에 13바이트
// 머리말(PG + PTS + DTS + 종류 + 길이)이 붙는다. 양쪽 다 다룬다.

export const SEG_PDS = 0x14;
export const SEG_ODS = 0x15;
export const SEG_PCS = 0x16;
export const SEG_WDS = 0x17;
export const SEG_END = 0x80;

const PTS_HZ = 90000;
/** 파일이 끝났는데도 안 닫힌 자막에 씌울 기본 길이. */
const DANGLING_DURATION_MS = 3000;

const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

/** BT.601 limited range → full range RGB. */
function ycrcbToRgb(y, cr, cb) {
  const luma = ((y - 16) * 255) / 219;
  const chromaB = cb - 128;
  const chromaR = cr - 128;
  const clamp = (v) => Math.min(255, Math.max(0, Math.round(v)));
  return [
    clamp(luma + 1.402 * chromaR),
    clamp(luma - 0.344136 * chromaB - 0.714136 * chromaR),
    clamp(luma + 1.772 * chromaB),
  ];
}

/** PGS 런렝스를 팔레트 인덱스 배열로 편다. */
export function decodeRle(data, width, height) {
  const out = new Uint8Array(width * height);
  let position = 0;
  let x = 0;
  let y = 0;

  while (position < data.length && y < height) {
    const first = data[position];
    position += 1;
    let run;
    let color;

    if (first) {
      run = 1;
      color = first;
    } else {
      if (position >= data.length) break;
      const second = data[position];
      position += 1;
      if (second === 0) {
        y += 1;
        x = 0;
        continue;
      }
      if (second < 0x40) {
        run = second;
        color = 0;
      } else if (second < 0x80) {
        if (position >= data.length) break;
        run = ((second & 0x3f) << 8) | data[position];
        position += 1;
        color = 0;
      } else if (second < 0xc0) {
        if (position >= data.length) break;
        run = second & 0x3f;
        color = data[position];
        position += 1;
      } else {
        if (position + 1 >= data.length) break;
        run = ((second & 0x3f) << 8) | data[position];
        color = data[position + 1];
        position += 2;
      }
    }

    // 정상적인 데이터는 줄 끝마다 0x00 0x00 을 넣는다. 그 마커가 빠진
    // 인코더도 있으므로, 줄이 가득 찬 상태에서 런이 또 오면 여기서 넘긴다.
    if (x >= width) {
      y += 1;
      x = 0;
      if (y >= height) break;
    }

    run = Math.min(run, width - x);
    if (run > 0) {
      if (color) out.fill(color, y * width + x, y * width + x + run);
      x += run;
    }
  }
  return out;
}

function parsePcs(payload) {
  const count = payload.length > 10 ? payload[10] : 0;
  const objects = [];
  let offset = 11;
  for (let i = 0; i < count; i += 1) {
    if (offset + 8 > payload.length) break;
    const cropped = (payload[offset + 3] & 0x80) !== 0;
    const entry = {
      objectId: u16(payload, offset),
      x: u16(payload, offset + 4),
      y: u16(payload, offset + 6),
      crop: null,
    };
    offset += 8;
    if (cropped && offset + 8 <= payload.length) {
      entry.crop = [
        u16(payload, offset),
        u16(payload, offset + 2),
        u16(payload, offset + 4),
        u16(payload, offset + 6),
      ];
      offset += 8;
    }
    objects.push(entry);
  }
  return {
    width: u16(payload, 0),
    height: u16(payload, 2),
    state: payload.length > 7 ? payload[7] : 0,
    paletteId: payload.length > 9 ? payload[9] : 0,
    objects,
  };
}

function parsePds(payload) {
  const paletteId = payload.length ? payload[0] : 0;
  const entries = new Map();
  for (let offset = 2; offset + 5 <= payload.length; offset += 5) {
    const [red, green, blue] = ycrcbToRgb(payload[offset + 1], payload[offset + 2], payload[offset + 3]);
    entries.set(payload[offset], [red, green, blue, payload[offset + 4]]);
  }
  return { paletteId, entries };
}

/** 조각난 ODS 를 모아 완성되면 객체를 돌려준다. */
function parseOds(payload, pending) {
  if (payload.length < 4) return null;
  const objectId = u16(payload, 0);
  const sequence = payload[3];
  let offset = 4;

  if (sequence & 0x80) {
    if (payload.length < 11) return null;
    pending.set(objectId, {
      width: u16(payload, 7),
      height: u16(payload, 9),
      chunks: [],
      length: 0,
    });
    offset = 11;
  }

  const entry = pending.get(objectId);
  if (!entry) return null;
  const chunk = payload.subarray(offset);
  entry.chunks.push(chunk);
  entry.length += chunk.length;

  if (sequence & 0x40) {
    pending.delete(objectId);
    const data = new Uint8Array(entry.length);
    let cursor = 0;
    for (const part of entry.chunks) {
      data.set(part, cursor);
      cursor += part.length;
    }
    return { objectId, width: entry.width, height: entry.height, data };
  }
  return null;
}

/** {width, height, data(RGBA)} 형태의 그림. 브라우저에서는 ImageData 로 감싸면 된다. */
function toImage(width, height, rle, palette) {
  const indices = decodeRle(rle, width, height);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const color = palette.get(indices[i]);
    if (!color) continue;
    const base = i * 4;
    data[base] = color[0];
    data[base + 1] = color[1];
    data[base + 2] = color[2];
    data[base + 3] = color[3];
  }
  return { width, height, data };
}

function compose(pcs, objects, palette) {
  const pieces = [];
  for (const entry of pcs.objects) {
    const source = objects.get(entry.objectId);
    if (!source || source.width <= 0 || source.height <= 0) continue;
    let image = toImage(source.width, source.height, source.data, palette);
    if (entry.crop) {
      image = cropRegion(image, entry.crop[0], entry.crop[1], entry.crop[2], entry.crop[3]);
    }
    pieces.push({ image, x: entry.x, y: entry.y });
  }
  if (!pieces.length) return null;

  const canvasWidth = Math.max(1, pcs.width);
  const canvasHeight = Math.max(1, pcs.height);
  const canvas = {
    width: canvasWidth,
    height: canvasHeight,
    data: new Uint8ClampedArray(canvasWidth * canvasHeight * 4),
  };

  for (const piece of pieces) blit(canvas, piece.image, piece.x, piece.y);
  return cropToContent(canvas);
}

function cropRegion(image, x, y, width, height) {
  const w = Math.min(width, image.width - x);
  const h = Math.min(height, image.height - y);
  if (w <= 0 || h <= 0) return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  const out = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let row = 0; row < h; row += 1) {
    const from = ((y + row) * image.width + x) * 4;
    out.data.set(image.data.subarray(from, from + w * 4), row * w * 4);
  }
  return out;
}

/** 알파 합성. 자막 조각은 서로 겹치지 않는 게 보통이지만 규칙대로 얹는다. */
function blit(canvas, image, offsetX, offsetY) {
  for (let row = 0; row < image.height; row += 1) {
    const y = offsetY + row;
    if (y < 0 || y >= canvas.height) continue;
    for (let column = 0; column < image.width; column += 1) {
      const x = offsetX + column;
      if (x < 0 || x >= canvas.width) continue;
      const from = (row * image.width + column) * 4;
      const alpha = image.data[from + 3];
      if (!alpha) continue;
      const to = (y * canvas.width + x) * 4;
      if (alpha === 255 || canvas.data[to + 3] === 0) {
        canvas.data[to] = image.data[from];
        canvas.data[to + 1] = image.data[from + 1];
        canvas.data[to + 2] = image.data[from + 2];
        canvas.data[to + 3] = alpha;
      } else {
        const srcA = alpha / 255;
        const dstA = canvas.data[to + 3] / 255;
        const outA = srcA + dstA * (1 - srcA);
        for (let channel = 0; channel < 3; channel += 1) {
          canvas.data[to + channel] = Math.round(
            (image.data[from + channel] * srcA + canvas.data[to + channel] * dstA * (1 - srcA)) / outA
          );
        }
        canvas.data[to + 3] = Math.round(outA * 255);
      }
    }
  }
}

/** 완전히 투명한 가장자리를 잘라낸다. 파이썬판의 Image.getbbox 와 같은 일. */
export function cropToContent(image) {
  let left = image.width;
  let top = image.height;
  let right = -1;
  let bottom = -1;

  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] === 0) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }
  if (right < left || bottom < top) return null;
  return cropRegion(image, left, top, right - left + 1, bottom - top + 1);
}

/**
 * 화면 단위 하나를 계속 이어서 해독한다.
 *
 * 팔레트와 객체는 한 시기(epoch) 동안 유지되므로 상태를 들고 있어야 한다.
 */
export class PgsDecoder {
  constructor() {
    this.palettes = new Map();
    this.objects = new Map();
    this.pendingOds = new Map();
  }

  /** 세그먼트 묶음(컨테이너 샘플 하나)을 넣으면 그림 또는 null(화면 지우기)을 돌려준다. */
  decodeSegments(segments) {
    let pcs = null;
    for (const segment of segments) {
      switch (segment.type) {
        case SEG_PCS:
          pcs = parsePcs(segment.payload);
          if (pcs.state & 0x80) {
            this.palettes.clear();
            this.objects.clear();
            this.pendingOds.clear();
          }
          break;
        case SEG_PDS: {
          const { paletteId, entries } = parsePds(segment.payload);
          const palette = this.palettes.get(paletteId) ?? new Map();
          for (const [index, color] of entries) palette.set(index, color);
          this.palettes.set(paletteId, palette);
          break;
        }
        case SEG_ODS: {
          const finished = parseOds(segment.payload, this.pendingOds);
          if (finished) {
            this.objects.set(finished.objectId, finished);
          }
          break;
        }
        default:
          break;
      }
    }
    if (!pcs) return null;
    return compose(pcs, this.objects, this.palettes.get(pcs.paletteId) ?? new Map());
  }
}

/** 컨테이너 샘플 안의 세그먼트들. 머리말 없이 [종류][길이][내용] 이 이어진다. */
export function splitSampleSegments(bytes) {
  const segments = [];
  let offset = 0;
  while (offset + 3 <= bytes.length) {
    const type = bytes[offset];
    const size = u16(bytes, offset + 1);
    const start = offset + 3;
    if (start + size > bytes.length) break;
    segments.push({ type, payload: bytes.subarray(start, start + size) });
    offset = start + size;
  }
  return segments;
}

/** 독립된 .sup 파일의 세그먼트들. 앞에 13바이트 머리말이 붙는다. */
export function splitSupSegments(bytes) {
  const segments = [];
  let offset = 0;
  while (offset + 13 <= bytes.length) {
    if (bytes[offset] !== 0x50 || bytes[offset + 1] !== 0x47) {
      // 깨진 구간은 다음 매직까지 건너뛴다.
      let next = -1;
      for (let i = offset + 1; i + 1 < bytes.length; i += 1) {
        if (bytes[i] === 0x50 && bytes[i + 1] === 0x47) {
          next = i;
          break;
        }
      }
      if (next < 0) break;
      offset = next;
      continue;
    }
    const pts =
      bytes[offset + 2] * 16777216 +
      (bytes[offset + 3] << 16) +
      (bytes[offset + 4] << 8) +
      bytes[offset + 5];
    const type = bytes[offset + 10];
    const size = u16(bytes, offset + 11);
    const start = offset + 13;
    if (start + size > bytes.length) break;
    segments.push({ ptsMs: Math.round((pts * 1000) / PTS_HZ), type, payload: bytes.subarray(start, start + size) });
    offset = start + size;
  }
  return segments;
}

/** 독립된 .sup 파일 전체를 자막 목록으로. */
export function decodeSupFile(bytes) {
  const decoder = new PgsDecoder();
  const cues = [];
  let pending = null;
  let lastPtsMs = 0;
  let batch = [];
  let batchPts = 0;

  const flush = () => {
    if (!batch.length) return;
    const image = decoder.decodeSegments(batch);
    if (pending && batchPts > pending.startMs) {
      cues.push({ startMs: pending.startMs, endMs: batchPts, image: pending.image });
      pending = null;
    }
    if (image) pending = { startMs: batchPts, image };
    batch = [];
  };

  for (const segment of splitSupSegments(bytes)) {
    lastPtsMs = Math.max(lastPtsMs, segment.ptsMs);
    if (segment.type === SEG_PCS) {
      flush();
      batchPts = segment.ptsMs;
    }
    batch.push(segment);
    if (segment.type === SEG_END) flush();
  }
  flush();

  if (pending) {
    cues.push({
      startMs: pending.startMs,
      endMs: Math.max(lastPtsMs, pending.startMs + DANGLING_DURATION_MS),
      image: pending.image,
    });
  }
  return cues;
}
