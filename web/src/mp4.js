// MP4(ISO 기반 미디어 파일)의 자막 트랙을 꺼낸다.
//
// MP4 는 MKV 와 구조가 다르다. 자막 조각(샘플)이 파일 여기저기 흩어져 있고,
// 그 위치와 길이·시각은 moov 안의 표(stbl)에 모여 있다. 그래서 표를 먼저 읽어
// 두고, 필요한 조각만 골라 읽으면 된다 — 영상 데이터는 건드리지 않는다.

import { SliceReader, readAscii, u16, u32, u64 } from './reader.js';

/** 자막을 다루는 핸들러 종류. */
const SUBTITLE_HANDLERS = new Set(['sbtl', 'text', 'subt', 'clcp']);

const FORMAT_MIME = {
  tx3g: 'application/x-quicktime-tx3g',
  text: 'application/x-quicktime-tx3g',
  wvtt: 'text/vtt',
  stpp: 'application/ttml+xml',
  c608: 'application/x-mp4-cea-608',
  c708: 'application/x-mp4-cea-708',
};

/** 상자 하나의 머리말을 읽는다. */
async function readBoxHeader(reader, offset, limit) {
  if (offset + 8 > limit) return null;
  const head = await reader.ensure(offset, 16);
  if (head.length < 8) return null;

  let size = u32(head, 0);
  const type = readAscii(head.subarray(4, 8));
  let headerSize = 8;

  if (size === 1) {
    if (head.length < 16) return null;
    size = u64(head, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset; // 파일 끝까지
  }
  if (size < headerSize) return null;

  return { type, start: offset, dataStart: offset + headerSize, end: offset + size };
}

/** 주어진 범위 안의 상자들을 차례로 내놓는다. */
async function* iterBoxes(reader, start, end) {
  let offset = start;
  while (offset < end) {
    const box = await readBoxHeader(reader, offset, end);
    if (!box) return;
    yield box;
    offset = box.end;
  }
}

async function findBox(reader, start, end, type) {
  for await (const box of iterBoxes(reader, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/** mdhd 의 15비트 묶음 언어 코드를 ISO-639-2 세 글자로. */
function unpackLanguage(packed) {
  const letters = [(packed >> 10) & 0x1f, (packed >> 5) & 0x1f, packed & 0x1f];
  const code = letters.map((value) => String.fromCharCode(value + 0x60)).join('');
  return /^[a-z]{3}$/.test(code) && code !== 'und' ? code : null;
}

async function parseMdhd(reader, box) {
  const bytes = await reader.ensure(box.dataStart, 36);
  const version = bytes[0];
  const offset = version === 1 ? 20 : 12;
  return {
    timescale: version === 1 ? u32(bytes, 20) : u32(bytes, 12),
    language: unpackLanguage(u16(bytes, version === 1 ? 36 : 20)),
    _offset: offset,
  };
}

async function parseHdlr(reader, box) {
  const bytes = await reader.ensure(box.dataStart, 12);
  return readAscii(bytes.subarray(8, 12));
}

/** stsd 의 첫 항목에서 자막 형식(tx3g, wvtt …)을 알아낸다. */
async function parseStsd(reader, box) {
  const bytes = await reader.ensure(box.dataStart, 16);
  if (u32(bytes, 4) < 1) return null;
  return readAscii(bytes.subarray(12, 16));
}

async function parseStts(reader, box) {
  const header = await reader.ensure(box.dataStart, 8);
  const count = u32(header, 4);
  const bytes = await reader.read(box.dataStart + 8, count * 8);
  const runs = [];
  for (let i = 0; i + 8 <= bytes.length; i += 8) {
    runs.push({ count: u32(bytes, i), delta: u32(bytes, i + 4) });
  }
  return runs;
}

async function parseStsz(reader, box) {
  const header = await reader.ensure(box.dataStart, 12);
  const uniform = u32(header, 4);
  const count = u32(header, 8);
  if (uniform) return new Array(count).fill(uniform);

  const bytes = await reader.read(box.dataStart + 12, count * 4);
  const sizes = new Array(count);
  for (let i = 0; i < count; i += 1) sizes[i] = u32(bytes, i * 4);
  return sizes;
}

async function parseStsc(reader, box) {
  const header = await reader.ensure(box.dataStart, 8);
  const count = u32(header, 4);
  const bytes = await reader.read(box.dataStart + 8, count * 12);
  const entries = [];
  for (let i = 0; i + 12 <= bytes.length; i += 12) {
    entries.push({ firstChunk: u32(bytes, i), samplesPerChunk: u32(bytes, i + 4) });
  }
  return entries;
}

async function parseChunkOffsets(reader, box, wide) {
  const header = await reader.ensure(box.dataStart, 8);
  const count = u32(header, 4);
  const width = wide ? 8 : 4;
  const bytes = await reader.read(box.dataStart + 8, count * width);
  const offsets = new Array(count);
  for (let i = 0; i < count; i += 1) {
    offsets[i] = wide ? u64(bytes, i * width) : u32(bytes, i * width);
  }
  return offsets;
}

/**
 * 편집 목록(elst)이 앞을 비워 두라고 하면 그만큼 모든 자막이 밀린다.
 * ffmpeg 도 같은 처리를 하므로 맞춰 둔다.
 */
async function parseEditDelayMs(reader, trakStart, trakEnd, movieTimescale) {
  const edts = await findBox(reader, trakStart, trakEnd, 'edts');
  if (!edts) return 0;
  const elst = await findBox(reader, edts.dataStart, edts.end, 'elst');
  if (!elst) return 0;

  const header = await reader.ensure(elst.dataStart, 8);
  const version = header[0];
  const count = u32(header, 4);
  if (count < 1) return 0;

  const entrySize = version === 1 ? 20 : 12;
  const bytes = await reader.ensure(elst.dataStart + 8, entrySize);
  const duration = version === 1 ? u64(bytes, 0) : u32(bytes, 0);
  const mediaTime = version === 1 ? u64(bytes, 8) : u32(bytes, 4);
  const empty = version === 1 ? mediaTime === 0xffffffffffffffff : mediaTime === 0xffffffff;

  return empty && movieTimescale ? Math.round((duration * 1000) / movieTimescale) : 0;
}

/** 파일이 MP4 계열인지. */
export async function looksLikeMp4(file) {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  return head.length >= 8 && readAscii(head.subarray(4, 8)) === 'ftyp';
}

/**
 * 자막 트랙 목록과 각 트랙의 샘플 표를 읽는다.
 *
 * 표까지 한 번에 읽어 두는 이유는, MP4 에서는 트랙 목록만 알아도 결국 같은
 * moov 를 훑어야 하기 때문이다. moov 는 보통 수십 킬로바이트라 부담이 없다.
 */
export async function probeMp4(file) {
  const reader = new SliceReader(file);
  const moov = await findBox(reader, 0, reader.size, 'moov');
  if (!moov) {
    const moof = await findBox(reader, 0, reader.size, 'moof');
    if (moof) {
      throw new Error('조각난 MP4(fragmented)는 아직 읽지 못합니다.');
    }
    throw new Error('MP4 안에서 moov 를 찾지 못했습니다.');
  }

  const mvhd = await findBox(reader, moov.dataStart, moov.end, 'mvhd');
  let movieTimescale = 1000;
  if (mvhd) {
    const bytes = await reader.ensure(mvhd.dataStart, 24);
    movieTimescale = bytes[0] === 1 ? u32(bytes, 20) : u32(bytes, 12);
  }

  const tracks = [];
  let subtitleIndex = 0;

  for await (const trak of iterBoxes(reader, moov.dataStart, moov.end)) {
    if (trak.type !== 'trak') continue;

    const mdia = await findBox(reader, trak.dataStart, trak.end, 'mdia');
    if (!mdia) continue;
    const hdlr = await findBox(reader, mdia.dataStart, mdia.end, 'hdlr');
    if (!hdlr) continue;
    const handler = await parseHdlr(reader, hdlr);
    if (!SUBTITLE_HANDLERS.has(handler)) continue;

    const mdhdBox = await findBox(reader, mdia.dataStart, mdia.end, 'mdhd');
    if (!mdhdBox) continue;
    const mdhd = await parseMdhd(reader, mdhdBox);

    const minf = await findBox(reader, mdia.dataStart, mdia.end, 'minf');
    const stbl = minf && (await findBox(reader, minf.dataStart, minf.end, 'stbl'));
    if (!stbl) continue;

    const stsdBox = await findBox(reader, stbl.dataStart, stbl.end, 'stsd');
    const format = stsdBox ? await parseStsd(reader, stsdBox) : null;

    const samples = await buildSampleTable(reader, stbl, mdhd.timescale);
    const delayMs = await parseEditDelayMs(reader, trak.dataStart, trak.end, movieTimescale);
    if (delayMs) for (const sample of samples) sample.startMs += delayMs;

    tracks.push({
      trackNumber: subtitleIndex,
      subtitleIndex: subtitleIndex++,
      mimeType: FORMAT_MIME[format] ?? `application/x-mp4-${format ?? 'unknown'}`,
      format,
      language: mdhd.language,
      default: false,
      forced: false,
      codecPrivate: null,
      samples,
    });
  }

  return { container: 'mp4', tracks, bytesFetched: reader.bytesFetched };
}

/** stbl 의 표들을 엮어 (위치, 길이, 시각) 목록을 만든다. */
async function buildSampleTable(reader, stbl, timescale) {
  const sttsBox = await findBox(reader, stbl.dataStart, stbl.end, 'stts');
  const stszBox = await findBox(reader, stbl.dataStart, stbl.end, 'stsz');
  const stscBox = await findBox(reader, stbl.dataStart, stbl.end, 'stsc');
  const stcoBox = await findBox(reader, stbl.dataStart, stbl.end, 'stco');
  const co64Box = stcoBox ? null : await findBox(reader, stbl.dataStart, stbl.end, 'co64');
  if (!sttsBox || !stszBox || !stscBox || !(stcoBox || co64Box)) return [];

  const runs = await parseStts(reader, sttsBox);
  const sizes = await parseStsz(reader, stszBox);
  const chunks = await parseStsc(reader, stscBox);
  const offsets = await parseChunkOffsets(reader, stcoBox ?? co64Box, Boolean(co64Box));

  const scale = timescale || 1000;
  const samples = [];

  // 시각: stts 의 (개수, 간격) 묶음을 펼쳐 누적한다.
  let ticks = 0;
  for (const run of runs) {
    for (let i = 0; i < run.count && samples.length < sizes.length; i += 1) {
      samples.push({
        startMs: Math.round((ticks * 1000) / scale),
        durationMs: run.delta ? Math.round((run.delta * 1000) / scale) : null,
        size: sizes[samples.length],
        offset: 0,
      });
      ticks += run.delta;
    }
  }
  while (samples.length < sizes.length) {
    samples.push({ startMs: Math.round((ticks * 1000) / scale), durationMs: null, size: sizes[samples.length], offset: 0 });
  }

  // 위치: 덩어리(chunk)마다 몇 개씩 들었는지 보고 차례로 쌓아 올린다.
  let sampleIndex = 0;
  for (let chunkIndex = 0; chunkIndex < offsets.length && sampleIndex < samples.length; chunkIndex += 1) {
    const perChunk = samplesPerChunk(chunks, chunkIndex);
    let cursor = offsets[chunkIndex];
    for (let i = 0; i < perChunk && sampleIndex < samples.length; i += 1) {
      samples[sampleIndex].offset = cursor;
      cursor += samples[sampleIndex].size;
      sampleIndex += 1;
    }
  }

  return samples.slice(0, sampleIndex || samples.length);
}

function samplesPerChunk(entries, chunkIndex) {
  let value = entries.length ? entries[0].samplesPerChunk : 0;
  for (const entry of entries) {
    if (entry.firstChunk - 1 <= chunkIndex) value = entry.samplesPerChunk;
    else break;
  }
  return value;
}

/** 자막 조각들을 실제로 읽어 온다. 영상 데이터는 건드리지 않는다. */
export async function readMp4Samples(file, track, onProgress) {
  const reader = new SliceReader(file, 256 * 1024);
  const samples = [];

  for (const [index, entry] of track.samples.entries()) {
    if (!entry.size) continue;
    const data = await reader.ensure(entry.offset, entry.size);
    samples.push({
      startMs: entry.startMs,
      durationMs: entry.durationMs,
      data: new Uint8Array(data.subarray(0, entry.size)),
    });
    if (onProgress && index % 32 === 0) onProgress(index + 1, track.samples.length);
  }
  onProgress?.(track.samples.length, track.samples.length);
  return { samples, bytesFetched: reader.bytesFetched };
}
