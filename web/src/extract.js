// 영상 파일 하나에서 자막을 꺼내는 흐름.
//
//   영상 ─ 컨테이너 해석 ─┬─ 글자 자막 ────────────────┐
//                        └─ 그림 자막 ─ 해독 ─ 문자인식 ┴─ 다듬기 ─ SRT
//
// 여기서는 '다듬기' 직전까지, 즉 시각과 내용(글자 또는 그림)을 맞춰 내놓는다.
// 문자 인식은 브라우저에서만 할 수 있으므로 바깥에서 붙인다.

import { probe, readSamples } from './container.js';
import { PgsDecoder, splitSampleSegments } from './pgs.js';
import { readAscii, u16, u32 } from './reader.js';
import { decodeSpu, parseIdxPalette } from './vobsub.js';

export const MIME = {
  PGS: 'application/pgs',
  VOBSUB: 'application/vobsub',
  DVBSUBS: 'application/dvbsubs',
  SUBRIP: 'application/x-subrip',
  SSA: 'text/x-ssa',
  VTT: 'text/vtt',
  TX3G: 'application/x-quicktime-tx3g',
};

/** 그림으로 들어 있어 문자 인식을 거쳐야 하는 형식. */
export const BITMAP_MIME_TYPES = new Set([MIME.PGS, MIME.VOBSUB]);

/** 이 구현이 다룰 수 있는 형식. */
export const SUPPORTED_MIME_TYPES = new Set([
  MIME.PGS,
  MIME.VOBSUB,
  MIME.SUBRIP,
  MIME.SSA,
  MIME.VTT,
  MIME.TX3G,
]);

const FORMAT_NAMES = {
  [MIME.PGS]: 'PGS (블루레이 그림 자막)',
  [MIME.VOBSUB]: 'VobSub (DVD 그림 자막)',
  [MIME.DVBSUBS]: 'DVB 그림 자막 (방송)',
  [MIME.SUBRIP]: 'SubRip',
  [MIME.SSA]: 'ASS/SSA',
  [MIME.VTT]: 'WebVTT',
  [MIME.TX3G]: 'MP4 글자 자막',
  'application/ttml+xml': 'TTML',
};

/** 파일이 끝났는데도 안 닫힌 자막에 씌울 기본 길이. */
const DANGLING_DURATION_MS = 3000;

export function formatName(mimeType) {
  return FORMAT_NAMES[mimeType] ?? mimeType;
}

export function isBitmap(track) {
  return BITMAP_MIME_TYPES.has(track.mimeType);
}

export function isSupported(track) {
  return SUPPORTED_MIME_TYPES.has(track.mimeType);
}

/** 출력 파일 이름에 붙일 꼬리표. 파이썬판 SubtitleTrack.slug() 와 같은 규칙. */
export function trackSlug(track) {
  const language = track.language && track.language !== 'und' ? track.language : 'und';
  return track.forced ? `${language}.forced` : language;
}

function stemOf(videoName) {
  const dot = videoName.lastIndexOf('.');
  return dot > 0 ? videoName.slice(0, dot) : videoName;
}

export function outputFileName(videoName, track) {
  return `${stemOf(videoName)}.${trackSlug(track)}.srt`;
}

/** 이미 쓴 이름과 겹치면 자막 순번을 덧붙인다. 파이썬판과 같은 규칙이다. */
export function uniqueFileName(videoName, track, used) {
  const candidate = outputFileName(videoName, track);
  if (!used.has(candidate)) return candidate;
  return `${stemOf(videoName)}.${trackSlug(track)}.${track.subtitleIndex}.srt`;
}

export function describeTrack(track) {
  const parts = [`#${track.subtitleIndex}`, track.language || 'und', formatName(track.mimeType)];
  const flags = [track.default && 'default', track.forced && 'forced'].filter(Boolean);
  if (flags.length) parts.push(`[${flags.join(',')}]`);
  return parts.join('  ');
}

/** 파일 안의 자막 트랙 목록. */
export async function listTracks(file) {
  return probe(file);
}

/**
 * 트랙 하나의 자막을 시각과 함께 꺼낸다.
 *
 * 시각 규칙은 파이썬판과 같다. 끝 시각을 해독기가 알려 주면 그걸 쓰고,
 * 아니면 다음 자막이 나타나는 시각까지로 본다. 그림 자막에서 내용이 없는
 * 덩어리는 '화면 지우기' 신호라 그 자체가 자막은 아니다.
 *
 * @returns [{ startMs, endMs, text }] 또는 [{ startMs, endMs, image }]
 */
export async function readTrackCues(file, track, container, context, onProgress) {
  const { samples } = await readSamples(file, track, container, context, onProgress);
  if (!samples.length) return [];

  const decoded = decodeSamples(samples, track);
  const cues = [];

  decoded.forEach((item, index) => {
    if (item.content === null) return;
    const declaredEnd = item.durationMs === null ? null : item.startMs + item.durationMs;
    const nextStart = decoded[index + 1]?.startMs ?? null;
    const endMs = declaredEnd ?? nextStart ?? item.startMs + DANGLING_DURATION_MS;
    if (endMs <= item.startMs) return;
    cues.push({ startMs: item.startMs, endMs, ...item.content });
  });

  return cues;
}

function decodeSamples(samples, track) {
  if (track.mimeType === MIME.PGS) {
    const decoder = new PgsDecoder();
    return samples.map((sample) => {
      const image = decoder.decodeSegments(splitSampleSegments(sample.data));
      return { startMs: sample.startMs, durationMs: sample.durationMs, content: image ? { image } : null };
    });
  }

  if (track.mimeType === MIME.VOBSUB) {
    const palette = parseIdxPalette(decodeUtf8(track.codecPrivate));
    return samples.map((sample) => {
      const decoded = decodeSpu(sample.data, palette);
      if (!decoded) return { startMs: sample.startMs, durationMs: null, content: null };
      return {
        startMs: sample.startMs + decoded.startDelayMs,
        durationMs:
          decoded.stopDelayMs === null ? sample.durationMs : decoded.stopDelayMs - decoded.startDelayMs,
        content: { image: decoded.image },
      };
    });
  }

  const readText = textReaderFor(track);
  return samples.map((sample) => {
    const text = readText(sample.data).trim();
    return { startMs: sample.startMs, durationMs: sample.durationMs, content: text ? { text } : null };
  });
}

function textReaderFor(track) {
  if (track.mimeType === MIME.TX3G) return readTx3gText;
  if (track.mimeType === MIME.VTT && track.format === 'wvtt') return readWvttText;
  if (track.mimeType === MIME.SSA) return (bytes) => stripSsaFields(decodeUtf8(bytes));
  return decodeUtf8;
}

function decodeUtf8(bytes) {
  if (!bytes || !bytes.length) return '';
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * MP4 글자 자막(tx3g)의 조각은 '길이 2바이트 + 본문' 으로 시작한다.
 * 뒤에 글꼴·색 같은 꾸밈 상자가 더 붙기도 하지만 본문만 쓰면 된다.
 */
function readTx3gText(bytes) {
  if (!bytes || bytes.length < 2) return '';
  const length = u16(bytes, 0);
  if (length === 0 || 2 + length > bytes.length) return '';
  return decodeUtf8(bytes.subarray(2, 2 + length));
}

/** MP4 안의 WebVTT 는 상자 구조다. vttc 안의 payl 이 본문이다. */
function readWvttText(bytes) {
  const parts = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    const size = u32(bytes, offset);
    const type = readAscii(bytes.subarray(offset + 4, offset + 8));
    if (size < 8 || offset + size > bytes.length) break;

    if (type === 'vttc') {
      let inner = offset + 8;
      while (inner + 8 <= offset + size) {
        const innerSize = u32(bytes, inner);
        const innerType = readAscii(bytes.subarray(inner + 4, inner + 8));
        if (innerSize < 8 || inner + innerSize > offset + size) break;
        if (innerType === 'payl') {
          parts.push(decodeUtf8(bytes.subarray(inner + 8, inner + innerSize)));
        }
        inner += innerSize;
      }
    }
    offset += size;
  }
  return parts.join('\n');
}

/**
 * MKV 안의 ASS 자막 한 줄은 `순번,계층,스타일,이름,여백,여백,여백,효과,본문`
 * 형태다. 앞의 여덟 칸을 걷어내고 본문만 남긴다.
 */
function stripSsaFields(text) {
  return text
    .split('\n')
    .map((line) => {
      const parts = line.split(',');
      return parts.length > 8 ? parts.slice(8).join(',') : line;
    })
    .join('\n');
}
