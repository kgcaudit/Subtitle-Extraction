// MKV(Matroska)/WebM 의 자막 트랙만 뽑아낸다.
// 자막 블록만 모으므로 파일 전체를 메모리에 올리지 않는다.

import { SliceReader, readAscii } from './reader.js';

const ID = {
  SEGMENT: 0x18538067,
  INFO: 0x1549a966,
  TIMESTAMP_SCALE: 0x2ad7b1,
  TRACKS: 0x1654ae6b,
  TRACK_ENTRY: 0xae,
  TRACK_NUMBER: 0xd7,
  TRACK_TYPE: 0x83,
  FLAG_DEFAULT: 0x88,
  FLAG_FORCED: 0x55aa,
  CODEC_ID: 0x86,
  CODEC_PRIVATE: 0x63a2,
  LANGUAGE: 0x22b59c,
  LANGUAGE_IETF: 0x22b59d,
  CLUSTER: 0x1f43b675,
  CLUSTER_TIMESTAMP: 0xe7,
  SIMPLE_BLOCK: 0xa3,
  BLOCK_GROUP: 0xa0,
  BLOCK: 0xa1,
  BLOCK_DURATION: 0x9b,
};

function readVint(bytes, position, keepMarker) {
  const first = bytes[position];
  if (first === undefined || first === 0) return null;
  let length = 1;
  let mask = 0x80;
  while (!(first & mask)) {
    mask >>= 1;
    length += 1;
  }
  let value = keepMarker ? first : first & (mask - 1);
  for (let i = 1; i < length; i += 1) value = value * 256 + bytes[position + i];
  return { value, length, unknown: !keepMarker && value === Math.pow(2, 7 * length) - 1 };
}

async function readElementHeader(reader, offset) {
  const head = await reader.ensure(offset, 12);
  if (head.length < 2) return null;
  const id = readVint(head, 0, true);
  if (!id) return null;
  const size = readVint(head, id.length, false);
  if (!size) return null;
  return {
    id: id.value,
    dataStart: offset + id.length + size.length,
    dataSize: size.unknown ? Infinity : size.value,
  };
}

function readUint(bytes) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

const CODEC_MIME = {
  'S_HDMV/PGS': 'application/pgs',
  S_VOBSUB: 'application/vobsub',
  S_DVBSUB: 'application/dvbsubs',
  'S_TEXT/UTF8': 'application/x-subrip',
  'S_TEXT/ASCII': 'application/x-subrip',
  'S_TEXT/ASS': 'text/x-ssa',
  'S_TEXT/SSA': 'text/x-ssa',
  'S_TEXT/WEBVTT': 'text/vtt',
};

/** 자막 트랙 목록을 읽는다. Tracks 요소만 훑으므로 파일 앞부분만 건드린다. */
export async function listSubtitleTracks(file) {
  const reader = new SliceReader(file);
  const tracks = [];
  let timestampScale = 1000000;

  let offset = 0;
  while (offset < reader.size) {
    const element = await readElementHeader(reader, offset);
    if (!element) break;

    if (element.id === ID.SEGMENT) {
      offset = element.dataStart;
      continue;
    }
    if (element.id === ID.INFO || element.id === ID.TRACKS) {
      const end = element.dataStart + element.dataSize;
      let inner = element.dataStart;
      while (inner < end) {
        const child = await readElementHeader(reader, inner);
        if (!child) break;
        if (child.id === ID.TIMESTAMP_SCALE) {
          timestampScale = readUint(await reader.ensure(child.dataStart, child.dataSize));
        } else if (child.id === ID.TRACK_ENTRY) {
          const track = await readTrackEntry(reader, child);
          if (track) tracks.push(track);
        }
        inner = child.dataStart + child.dataSize;
      }
      offset = end;
      continue;
    }
    if (element.id === ID.CLUSTER) break; // 트랙 정보는 클러스터 앞에 있다
    offset = element.dataStart + element.dataSize;
  }

  tracks.forEach((track, index) => {
    track.subtitleIndex = index;
  });
  return { tracks, timestampScale, bytesFetched: reader.bytesFetched };
}

async function readTrackEntry(reader, element) {
  const end = element.dataStart + element.dataSize;
  let offset = element.dataStart;
  const entry = {
    trackNumber: 0,
    trackType: 0,
    codecId: '',
    language: null,
    codecPrivate: null,
    default: false,
    forced: false,
  };

  while (offset < end) {
    const child = await readElementHeader(reader, offset);
    if (!child) break;
    const data = await reader.ensure(child.dataStart, Math.min(child.dataSize, 1 << 16));
    switch (child.id) {
      case ID.TRACK_NUMBER: entry.trackNumber = readUint(data); break;
      case ID.TRACK_TYPE: entry.trackType = readUint(data); break;
      case ID.CODEC_ID: entry.codecId = readAscii(data); break;
      case ID.LANGUAGE:
      case ID.LANGUAGE_IETF: entry.language = readAscii(data) || entry.language; break;
      case ID.CODEC_PRIVATE: entry.codecPrivate = new Uint8Array(data); break;
      case ID.FLAG_DEFAULT: entry.default = readUint(data) === 1; break;
      case ID.FLAG_FORCED: entry.forced = readUint(data) === 1; break;
      default: break;
    }
    offset = child.dataStart + child.dataSize;
  }

  if (entry.trackType !== 17) return null; // 17 = 자막
  entry.mimeType = CODEC_MIME[entry.codecId] || entry.codecId;
  return entry;
}

/**
 * 자막 트랙의 샘플을 모은다.
 *
 * 클러스터 안을 걸으면서 자막이 아닌 블록은 내용을 읽지 않고 건너뛴다.
 * 덕분에 실제로 내려받는 양이 파일 크기보다 훨씬 적다.
 */
export async function readSubtitleSamples(file, trackNumber, timestampScale, onProgress) {
  const reader = new SliceReader(file);
  const samples = [];
  const scaleMs = timestampScale / 1e6;

  let offset = 0;
  let clusterEnd = 0;
  let clusterTimestamp = 0;
  let insideCluster = false;

  while (offset < reader.size) {
    const element = await readElementHeader(reader, offset);
    if (!element) break;

    if (element.id === ID.SEGMENT) {
      offset = element.dataStart;
      continue;
    }
    if (element.id === ID.CLUSTER) {
      insideCluster = true;
      clusterEnd = Number.isFinite(element.dataSize) ? element.dataStart + element.dataSize : reader.size;
      offset = element.dataStart;
      continue;
    }

    if (insideCluster && offset >= clusterEnd) insideCluster = false;

    if (insideCluster) {
      if (element.id === ID.CLUSTER_TIMESTAMP) {
        clusterTimestamp = readUint(await reader.ensure(element.dataStart, element.dataSize));
      } else if (element.id === ID.SIMPLE_BLOCK) {
        await collectBlock(reader, element, trackNumber, clusterTimestamp, scaleMs, samples, null);
      } else if (element.id === ID.BLOCK_GROUP) {
        const groupEnd = element.dataStart + element.dataSize;
        let inner = element.dataStart;
        let duration = null;
        let blockElement = null;
        while (inner < groupEnd) {
          const child = await readElementHeader(reader, inner);
          if (!child) break;
          if (child.id === ID.BLOCK) blockElement = child;
          else if (child.id === ID.BLOCK_DURATION) {
            duration = readUint(await reader.ensure(child.dataStart, child.dataSize));
          }
          inner = child.dataStart + child.dataSize;
        }
        if (blockElement) {
          await collectBlock(reader, blockElement, trackNumber, clusterTimestamp, scaleMs, samples, duration);
        }
        offset = groupEnd;
        if (onProgress) onProgress(offset, reader.size, samples.length);
        continue;
      }
      offset = element.dataStart + element.dataSize;
      if (onProgress && samples.length % 32 === 0) onProgress(offset, reader.size, samples.length);
      continue;
    }

    offset = element.dataStart + Math.min(element.dataSize, reader.size - element.dataStart);
  }

  return { samples, bytesFetched: reader.bytesFetched };
}

async function collectBlock(reader, element, trackNumber, clusterTimestamp, scaleMs, samples, duration) {
  // 블록의 앞 4바이트만 읽어 트랙 번호를 확인한다. 남의 트랙이면 내용은 건드리지 않는다.
  const head = await reader.ensure(element.dataStart, Math.min(8, element.dataSize));
  const track = readVint(head, 0, false);
  if (!track || track.value !== trackNumber) return;

  const payloadStart = element.dataStart + track.length + 3;
  const payloadSize = element.dataSize - track.length - 3;
  if (payloadSize <= 0) return;

  const full = await reader.ensure(element.dataStart, element.dataSize);
  const relative = (full[track.length] << 8) | full[track.length + 1];
  const signed = relative > 0x7fff ? relative - 0x10000 : relative;

  samples.push({
    startMs: Math.round((clusterTimestamp + signed) * scaleMs),
    durationMs: duration === null ? null : Math.round(duration * scaleMs),
    data: new Uint8Array(full.subarray(track.length + 3, element.dataSize)),
  });
}
