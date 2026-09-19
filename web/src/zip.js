// 파일 여러 개를 zip 하나로 묶는다.
//
// 자막을 여러 개 뽑으면 하나씩 내려받기가 번거롭다(28개면 28번 눌러야 한다).
// 브라우저에서 여러 파일을 한꺼번에 내려받게 하면 막히는 경우가 많아서,
// 하나로 묶어 한 번만 내려받게 한다.
//
// 압축은 하지 않고 그대로 담는다(store). 자막은 커야 몇백 킬로바이트라 압축해도
// 크게 이득이 없고, 압축기를 직접 넣으면 그만큼 틀릴 여지가 생긴다.

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const STORED = 0;

/** zip 규격이 쓰는 CRC-32 표. 처음 부를 때 한 번만 만든다. */
let crcTable = null;
function crc32Table() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    crcTable[i] = value >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (const byte of bytes) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 시각을 MS-DOS 형식으로. zip 은 1980년 이전을 담지 못한다.
 *
 * @returns { time, date }
 */
export function dosTimestamp(when) {
  const year = Math.max(1980, when.getFullYear());
  return {
    time: (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate(),
  };
}

/**
 * @param entries [{ name, text }] - 담을 파일들
 * @returns Blob - zip 한 덩이
 */
export function makeZip(entries, when = new Date()) {
  const encoder = new TextEncoder();
  const { time, date } = dosTimestamp(when);
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    // 이름이 비면 푸는 쪽에서 파일이 사라진 것처럼 보인다. 여기서 바로 알린다.
    if (!entry.name) throw new Error('zip 에 넣을 파일 이름이 없습니다');
    const name = encoder.encode(entry.name);
    const body = entry.text instanceof Uint8Array ? entry.text : encoder.encode(entry.text);
    const sum = crc32(body);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, LOCAL_HEADER, true);
    local.setUint16(4, 20, true);              // 풀려면 2.0 이상
    local.setUint16(6, 0x0800, true);          // 이름이 UTF-8 이라는 표시
    local.setUint16(8, STORED, true);
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, sum, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, body.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, body);

    const entryHeader = new DataView(new ArrayBuffer(46));
    entryHeader.setUint32(0, CENTRAL_HEADER, true);
    entryHeader.setUint16(4, 20, true);
    entryHeader.setUint16(6, 20, true);
    entryHeader.setUint16(8, 0x0800, true);
    entryHeader.setUint16(10, STORED, true);
    entryHeader.setUint16(12, time, true);
    entryHeader.setUint16(14, date, true);
    entryHeader.setUint32(16, sum, true);
    entryHeader.setUint32(20, body.length, true);
    entryHeader.setUint32(24, body.length, true);
    entryHeader.setUint16(28, name.length, true);
    entryHeader.setUint32(42, offset, true);
    central.push(new Uint8Array(entryHeader.buffer), name);

    offset += 30 + name.length + body.length;
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, END_OF_CENTRAL, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}
