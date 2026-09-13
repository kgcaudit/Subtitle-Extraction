// VobSub(DVD) 그림 자막 해독기. 파이썬판 subex/vobsub.py 를 옮긴 것이다.
//
// DVD 자막 한 덩어리는 SPU(Sub-Picture Unit) 하나다. 안에는 2비트 런렝스로
// 압축된 비트맵과, 표시/숨김 시각·색·영역을 지정하는 제어 시퀀스가 들어 있다.
// 16색 팔레트는 .idx 텍스트에 있고, MKV 안에서는 같은 텍스트가 트랙의
// CodecPrivate 에 실려 있다.

/** 제어 시퀀스의 delay 단위는 1024/90000 초. */
const DELAY_TO_MS = 1024 / 90;

/** .idx 가 없을 때 쓰는 무난한 기본값(배경 투명 / 흰 글자 / 검은 테두리). */
const DEFAULT_PALETTE = [
  [0, 0, 0],
  [255, 255, 255],
  [0, 0, 0],
  [128, 128, 128],
  ...Array.from({ length: 12 }, () => [0, 0, 0]),
];

const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

export function parseIdxPalette(text) {
  const match = /^palette:\s*(.+)$/m.exec(text ?? '');
  if (!match) return DEFAULT_PALETTE.map((color) => [...color]);

  const colors = [];
  for (const token of match[1].split(',')) {
    const value = token.trim();
    if (value.length === 6) {
      colors.push([
        parseInt(value.slice(0, 2), 16),
        parseInt(value.slice(2, 4), 16),
        parseInt(value.slice(4, 6), 16),
      ]);
    }
  }
  while (colors.length < 16) colors.push([0, 0, 0]);
  return colors.slice(0, 16);
}

const readNibble = (bytes, position) =>
  position % 2 === 0 ? bytes[position >> 1] >> 4 : bytes[position >> 1] & 0x0f;

/** 한 필드(짝수 줄 또는 홀수 줄)의 2비트 런렝스를 편다. */
function decodeField(bytes, byteOffset, plane, width, height, firstRow) {
  let position = byteOffset * 2;
  const limit = bytes.length * 2;
  let row = firstRow;
  let column = 0;

  while (row < height && position < limit) {
    let value = readNibble(bytes, position);
    position += 1;
    for (let step = 0; step < 3; step += 1) {
      if (value >= 0x04 || position >= limit) break;
      value = (value << 4) | readNibble(bytes, position);
      position += 1;
      if (value >= 0x10 || position >= limit) break;
      value = (value << 4) | readNibble(bytes, position);
      position += 1;
      if (value >= 0x40 || position >= limit) break;
      value = (value << 4) | readNibble(bytes, position);
      position += 1;
      break;
    }

    let run = value >> 2;
    const color = value & 0x03;
    if (run === 0 || column + run > width) run = width - column;

    if (color && run > 0) plane.fill(color, row * width + column, row * width + column + run);
    column += run;

    if (column >= width) {
      row += 2;
      column = 0;
      position = (position + 1) & ~1; // 줄이 끝나면 바이트 경계로 맞춘다
    }
  }
}

/**
 * SPU 하나를 푼다.
 *
 * @returns { image, startDelayMs, stopDelayMs } 또는 null
 */
export function decodeSpu(spu, palette) {
  if (!spu || spu.length < 4) return null;
  const controlOffset = u16(spu, 2);
  if (!(controlOffset > 0 && controlOffset < spu.length)) return null;

  let colormap = [0, 1, 2, 3];
  let alphas = [0, 15, 15, 0];
  let area = null;
  let fieldOffsets = null;
  let startDelayMs = 0;
  let stopDelayMs = null;

  let offset = controlOffset;
  const visited = new Set();
  while (offset >= 0 && offset <= spu.length - 4 && !visited.has(offset)) {
    visited.add(offset);
    const delay = Math.round(u16(spu, offset) * DELAY_TO_MS);
    const nextOffset = u16(spu, offset + 2);
    let cursor = offset + 4;

    while (cursor < spu.length) {
      const command = spu[cursor];
      cursor += 1;
      if (command === 0xff) break;

      if (command === 0x00 || command === 0x01) {
        startDelayMs = delay;
      } else if (command === 0x02) {
        stopDelayMs = delay;
      } else if (command === 0x03 && cursor + 2 <= spu.length) {
        const high = spu[cursor];
        const low = spu[cursor + 1];
        colormap = [low & 0x0f, low >> 4, high & 0x0f, high >> 4];
        cursor += 2;
      } else if (command === 0x04 && cursor + 2 <= spu.length) {
        const high = spu[cursor];
        const low = spu[cursor + 1];
        alphas = [low & 0x0f, low >> 4, high & 0x0f, high >> 4];
        cursor += 2;
      } else if (command === 0x05 && cursor + 6 <= spu.length) {
        const b = spu.subarray(cursor, cursor + 6);
        area = {
          x1: (b[0] << 4) | (b[1] >> 4),
          x2: ((b[1] & 0x0f) << 8) | b[2],
          y1: (b[3] << 4) | (b[4] >> 4),
          y2: ((b[4] & 0x0f) << 8) | b[5],
        };
        cursor += 6;
      } else if (command === 0x06 && cursor + 4 <= spu.length) {
        fieldOffsets = [u16(spu, cursor), u16(spu, cursor + 2)];
        cursor += 4;
      } else if (command === 0x07 && cursor + 2 <= spu.length) {
        cursor += Math.max(2, u16(spu, cursor)); // 색 변경 테이블 - 건너뜀
      } else {
        break;
      }
    }

    if (nextOffset === offset) break;
    offset = nextOffset;
  }

  if (!area || !fieldOffsets) return null;
  const width = area.x2 - area.x1 + 1;
  const height = area.y2 - area.y1 + 1;
  if (!(width > 0 && width <= 4096 && height > 0 && height <= 4096)) return null;

  const plane = new Uint8Array(width * height);
  decodeField(spu, fieldOffsets[0], plane, width, height, 0);
  decodeField(spu, fieldOffsets[1], plane, width, height, 1);

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < plane.length; i += 1) {
    const index = plane[i];
    const alpha = Math.min(255, alphas[index] * 17);
    if (!alpha) continue;
    const color = palette[colormap[index] % palette.length] ?? [0, 0, 0];
    const base = i * 4;
    data[base] = color[0];
    data[base + 1] = color[1];
    data[base + 2] = color[2];
    data[base + 3] = alpha;
  }

  const image = cropToContent({ width, height, data });
  if (!image) return null;
  return { image, startDelayMs, stopDelayMs };
}

/** 완전히 투명한 가장자리를 잘라낸다. */
function cropToContent(image) {
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

  const width = right - left + 1;
  const height = bottom - top + 1;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let row = 0; row < height; row += 1) {
    const from = ((top + row) * image.width + left) * 4;
    data.set(image.data.subarray(from, from + width * 4), row * width * 4);
  }
  return { width, height, data };
}
