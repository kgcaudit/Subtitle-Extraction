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
  SEEK_HEAD: 0x114d9b74,
  SEEK: 0x4dbb,
  SEEK_ID: 0x53ab,
  SEEK_POSITION: 0x53ac,
  CUES: 0x1c53bb6b,
  CUE_POINT: 0xbb,
  CUE_TRACK_POSITIONS: 0xb7,
  CUE_TRACK: 0xf7,
  CUE_CLUSTER_POSITION: 0xf1,
  CUE_RELATIVE_POSITION: 0xf0,
};

/**
 * 색인을 따라갈 때 한 번에 가져올 크기.
 *
 * 자막 블록은 수백 바이트뿐인데 여기저기 흩어져 있다. 크게 잡으면 쓰지도 않을
 * 옆 영상 데이터까지 딸려 온다. 실측(374MB 영상): 64KB 로 잡으면 44.5MB 를
 * 읽고, 4KB 로 잡으면 3.0MB 만 읽는다.
 */
const CUE_CHUNK_SIZE = 4 << 10;

/** 클러스터 앞머리에서 시각을 찾을 때 여기까지만 본다. */
const CLUSTER_HEAD_LIMIT = 4 << 10;

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
/**
 * 색인(Cues)을 따라 자막 블록 자리로 바로 건너뛴다. 못 쓰면 null.
 *
 * MKV 는 자막 조각이 영상·소리와 뒤섞여 파일 전체에 흩어져 있다. 그래서 그냥
 * 훑으면 **영상 파일을 통째로 읽게 된다**(실측: 374MB 영상에서 27KB 의 자막을
 * 얻으려고 372.8MB 를 읽었다 — 파일의 99.6%).
 *
 * 다행히 대부분의 MKV 에는 Cues 라는 색인이 있고, 만드는 도구들이 **자막
 * 트랙까지** 색인해 둔다. CueRelativePosition 까지 있으면 블록이 클러스터
 * 안 어디인지도 정확히 알 수 있어 그 자리만 집어 읽으면 된다.
 *
 * 실측(같은 374MB 영상): 372.8MB → 3.0MB 로 **125배** 줄었고, 나온 자막은
 * 훑어서 얻은 것과 바이트 하나까지 같았다.
 *
 * 색인이 없거나, 우리 트랙이 색인에 없거나, CueRelativePosition 이 빠진 옛날
 * 파일이면 null 을 돌려주고 원래대로 훑는다.
 */
async function readSamplesViaCues(file, trackNumber, timestampScale, onProgress) {
  const reader = new SliceReader(file, CUE_CHUNK_SIZE);
  const scaleMs = timestampScale / 1e6;

  const segmentStart = await findSegmentStart(reader);
  if (segmentStart === null) return null;

  const cuesPosition = await findCuesPosition(reader, segmentStart);
  if (cuesPosition === null) return null;

  const points = await readCuePoints(reader, cuesPosition, trackNumber);
  if (!points) return null;

  const clusters = new Map();
  const samples = [];

  for (const [index, point] of points.entries()) {
    const cluster = await readClusterHead(reader, segmentStart + point.cluster, clusters);
    if (!cluster) return null;

    const sample = await readBlockAt(reader, cluster.dataStart + point.relative, trackNumber,
                                    cluster.timestamp, scaleMs);
    if (sample) samples.push(sample);
    if (onProgress && index % 32 === 0) onProgress(index + 1, points.length, samples.length);
  }

  // 색인이 있다고 했는데 한 조각도 못 얻었으면 믿을 수 없다. 훑는 쪽으로 넘긴다.
  if (!samples.length) return null;

  onProgress?.(points.length, points.length, samples.length);
  return { samples, bytesFetched: reader.bytesFetched };
}

async function findSegmentStart(reader) {
  let offset = 0;
  for (let guard = 0; guard < 8; guard += 1) {
    const element = await readElementHeader(reader, offset);
    if (!element) return null;
    if (element.id === ID.SEGMENT) return element.dataStart;
    if (!Number.isFinite(element.dataSize)) return null;
    offset = element.dataStart + element.dataSize;
  }
  return null;
}

/** SeekHead(맨 앞의 차례표)에서 Cues 가 어디 있는지 찾는다. */
async function findCuesPosition(reader, segmentStart) {
  let offset = segmentStart;
  for (let guard = 0; guard < 32; guard += 1) {
    const element = await readElementHeader(reader, offset);
    if (!element || !Number.isFinite(element.dataSize)) return null;
    if (element.id === ID.CLUSTER) return null;        // 차례표 없이 알맹이가 시작됐다
    if (element.id === ID.CUES) return offset;          // 차례표가 없어도 직접 만났다면 그대로
    if (element.id === ID.SEEK_HEAD) {
      const body = await reader.read(element.dataStart, element.dataSize);
      const found = findCuesInSeekHead(body, segmentStart);
      if (found !== null) return found;
    }
    offset = element.dataStart + element.dataSize;
  }
  return null;
}

function findCuesInSeekHead(body, segmentStart) {
  for (const seek of iterateElements(body)) {
    if (seek.id !== ID.SEEK) continue;
    let elementId = null;
    let position = null;
    for (const field of iterateElements(body, seek.dataStart, seek.dataStart + seek.dataSize)) {
      if (field.id === ID.SEEK_ID) elementId = readUint(body.subarray(field.dataStart, field.dataStart + field.dataSize));
      if (field.id === ID.SEEK_POSITION) position = readUint(body.subarray(field.dataStart, field.dataStart + field.dataSize));
    }
    if (elementId === ID.CUES && position !== null) return segmentStart + position;
  }
  return null;
}

/** Cues 안에서 이 트랙의 (클러스터 위치, 블록 상대 위치)만 모은다. */
async function readCuePoints(reader, cuesPosition, trackNumber) {
  const cues = await readElementHeader(reader, cuesPosition);
  if (!cues || cues.id !== ID.CUES || !Number.isFinite(cues.dataSize)) return null;

  const body = await reader.read(cues.dataStart, cues.dataSize);
  const points = [];

  for (const point of iterateElements(body)) {
    if (point.id !== ID.CUE_POINT) continue;
    for (const positions of iterateElements(body, point.dataStart, point.dataStart + point.dataSize)) {
      if (positions.id !== ID.CUE_TRACK_POSITIONS) continue;
      let track = null;
      let cluster = null;
      let relative = null;
      for (const field of iterateElements(body, positions.dataStart, positions.dataStart + positions.dataSize)) {
        const value = () => readUint(body.subarray(field.dataStart, field.dataStart + field.dataSize));
        if (field.id === ID.CUE_TRACK) track = value();
        else if (field.id === ID.CUE_CLUSTER_POSITION) cluster = value();
        else if (field.id === ID.CUE_RELATIVE_POSITION) relative = value();
      }
      if (track !== trackNumber) continue;
      // 블록 자리를 모르면 클러스터를 통째로 읽어야 해서 남는 게 없다. 훑는 쪽이 낫다.
      if (cluster === null || relative === null) return null;
      points.push({ cluster, relative });
    }
  }
  return points.length ? points : null;
}

/** 클러스터 앞머리에서 시각을 읽는다. 같은 클러스터는 한 번만 읽는다. */
async function readClusterHead(reader, clusterPosition, cache) {
  const cached = cache.get(clusterPosition);
  if (cached) return cached;

  const cluster = await readElementHeader(reader, clusterPosition);
  if (!cluster || cluster.id !== ID.CLUSTER) return null;

  // 시각이 첫 자식이라는 보장이 없다 — 앞에 CRC-32 나 Void 가 오기도 한다.
  // 다만 블록보다는 반드시 앞이므로 첫 블록을 만나면 멈춘다.
  let timestamp = 0;
  let offset = cluster.dataStart;
  const limit = cluster.dataStart + Math.min(cluster.dataSize, CLUSTER_HEAD_LIMIT);
  while (offset < limit) {
    const child = await readElementHeader(reader, offset);
    if (!child || !Number.isFinite(child.dataSize)) break;
    if (child.id === ID.CLUSTER_TIMESTAMP) {
      timestamp = readUint(await reader.ensure(child.dataStart, child.dataSize));
      break;
    }
    if (child.id === ID.SIMPLE_BLOCK || child.id === ID.BLOCK_GROUP) break;
    offset = child.dataStart + child.dataSize;
  }

  const info = { dataStart: cluster.dataStart, timestamp };
  cache.set(clusterPosition, info);
  return info;
}

/** 블록 하나를 읽어 자막 조각으로 만든다. 남의 트랙이면 null. */
async function readBlockAt(reader, position, trackNumber, clusterTimestamp, scaleMs) {
  const element = await readElementHeader(reader, position);
  if (!element || !Number.isFinite(element.dataSize)) return null;

  let block = element;
  let duration = null;

  if (element.id === ID.BLOCK_GROUP) {
    const end = element.dataStart + element.dataSize;
    let inner = element.dataStart;
    block = null;
    while (inner < end) {
      const child = await readElementHeader(reader, inner);
      if (!child || !Number.isFinite(child.dataSize)) break;
      if (child.id === ID.BLOCK) block = child;
      else if (child.id === ID.BLOCK_DURATION) {
        duration = readUint(await reader.ensure(child.dataStart, child.dataSize));
      }
      inner = child.dataStart + child.dataSize;
    }
    if (!block) return null;
  } else if (element.id !== ID.SIMPLE_BLOCK) {
    return null;
  }

  const samples = [];
  await collectBlock(reader, block, trackNumber, clusterTimestamp, scaleMs, samples, duration);
  return samples[0] ?? null;
}

/** 바이트 덩어리 안의 EBML 요소를 차례로 훑는다(이미 메모리에 있는 것 전용). */
function* iterateElements(bytes, start = 0, end = bytes.length) {
  let offset = start;
  while (offset < end) {
    const id = readVint(bytes, offset, true);
    if (!id) return;
    const size = readVint(bytes, offset + id.length, false);
    if (!size) return;
    const dataStart = offset + id.length + size.length;
    if (dataStart + size.value > end) return;
    yield { id: id.value, dataStart, dataSize: size.value };
    offset = dataStart + size.value;
  }
}

export async function readSubtitleSamples(file, trackNumber, timestampScale, onProgress) {
  // 색인이 있으면 자막 자리로 바로 건너뛴다. 없으면 처음부터 훑는다.
  try {
    const viaCues = await readSamplesViaCues(file, trackNumber, timestampScale, onProgress);
    if (viaCues) return viaCues;
  } catch {
    // 색인이 깨져 있어도 훑어서 얻을 수 있으니 조용히 넘어간다.
  }
  return readSamplesByScanning(file, trackNumber, timestampScale, onProgress);
}

/**
 * 파일을 처음부터 끝까지 훑어 자막 블록을 모은다. 색인을 못 쓸 때의 길이다.
 *
 * 자막 조각이 영상·소리와 뒤섞여 흩어져 있고 어디 있는지 알려 주는 표가 없으므로,
 * 덩어리 머리말을 하나씩 짚어 가며 지나갈 수밖에 없다. 남의 트랙 알맹이는 읽지
 * 않지만 머리말이 수십 킬로바이트마다 흩어져 있어 결국 파일 대부분을 지나간다.
 * (시험에 쓰려고 따로 내보낸다 — 색인 경로와 결과가 같은지 맞춰 보기 위해서다.)
 */
export async function readSamplesByScanning(file, trackNumber, timestampScale, onProgress) {
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
