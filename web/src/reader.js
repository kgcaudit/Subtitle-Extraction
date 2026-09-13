// 파일을 조각내어 읽는다. 필요 없는 구간은 아예 가져오지 않으므로
// 수 기가바이트짜리 영상도 메모리에 통째로 올리지 않는다.

export class SliceReader {
  constructor(file, chunkSize = 1 << 20) {
    this.file = file;
    this.chunkSize = chunkSize;
    this.buffer = new Uint8Array(0);
    this.bufferStart = 0;
    this.bytesFetched = 0;
  }

  get size() {
    return this.file.size;
  }

  /** offset 부터 length 바이트를 담은 뷰를 돌려준다. */
  async ensure(offset, length) {
    if (offset < 0 || offset >= this.file.size || length <= 0) return new Uint8Array(0);

    const end = offset + length;
    if (offset >= this.bufferStart && end <= this.bufferStart + this.buffer.length) {
      return this.buffer.subarray(offset - this.bufferStart, end - this.bufferStart);
    }

    const fetchLength = Math.min(Math.max(length, this.chunkSize), this.file.size - offset);
    const blob = this.file.slice(offset, offset + fetchLength);
    this.buffer = new Uint8Array(await blob.arrayBuffer());
    this.bufferStart = offset;
    this.bytesFetched += this.buffer.length;
    return this.buffer.subarray(0, Math.min(length, this.buffer.length));
  }

  /** 버퍼에 담기에 너무 큰 구간을 따로 읽을 때. */
  async read(offset, length) {
    if (offset < 0 || length <= 0 || offset >= this.file.size) return new Uint8Array(0);
    const end = Math.min(offset + length, this.file.size);
    const bytes = new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
    this.bytesFetched += bytes.length;
    return bytes;
  }
}

export const u16 = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

export const u24 = (bytes, offset) =>
  (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];

/** 32비트 이상은 비트 연산이 부호를 망가뜨리므로 곱셈으로 만든다. */
export const u32 = (bytes, offset) =>
  bytes[offset] * 16777216 + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];

export const u64 = (bytes, offset) => u32(bytes, offset) * 4294967296 + u32(bytes, offset + 4);

export function readAscii(bytes) {
  let text = '';
  for (const byte of bytes) if (byte) text += String.fromCharCode(byte);
  return text;
}
