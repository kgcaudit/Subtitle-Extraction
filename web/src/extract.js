// 영상 파일 하나에서 자막을 꺼내는 흐름.
//
//   영상 ─ MKV 해석 ─┬─ 글자 자막 ─────────────────┐
//                    └─ 그림 자막 ─ 해독 ─ 문자인식 ┴─ 다듬기 ─ SRT
//
// 여기서는 '다듬기' 직전까지, 즉 시각과 내용(글자 또는 그림)을 맞춰 내놓는다.
// 문자 인식은 브라우저에서만 할 수 있으므로 바깥에서 붙인다.

import { listSubtitleTracks, readSubtitleSamples } from './mkv.js';
import { PgsDecoder, splitSampleSegments } from './pgs.js';
import { decodeSpu, parseIdxPalette } from './vobsub.js';

/** 그림으로 들어 있어 문자 인식을 거쳐야 하는 형식. */
export const BITMAP_MIME_TYPES = new Set(['application/pgs', 'application/vobsub']);

/** 이 구현이 다룰 수 있는 형식. */
export const SUPPORTED_MIME_TYPES = new Set([
  'application/pgs',
  'application/vobsub',
  'application/x-subrip',
  'text/x-ssa',
  'text/vtt',
]);

const FORMAT_NAMES = {
  'application/pgs': 'PGS (블루레이 그림 자막)',
  'application/vobsub': 'VobSub (DVD 그림 자막)',
  'application/dvbsubs': 'DVB 그림 자막 (방송)',
  'application/x-subrip': 'SubRip',
  'text/x-ssa': 'ASS/SSA',
  'text/vtt': 'WebVTT',
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

export function outputFileName(videoName, track) {
  const dot = videoName.lastIndexOf('.');
  const stem = dot > 0 ? videoName.slice(0, dot) : videoName;
  return `${stem}.${trackSlug(track)}.srt`;
}

/**
 * 이미 쓴 이름과 겹치면 자막 순번을 덧붙인다. 파이썬판과 같은 규칙이다.
 */
export function uniqueFileName(videoName, track, used) {
  const candidate = outputFileName(videoName, track);
  if (!used.has(candidate)) return candidate;
  const dot = videoName.lastIndexOf('.');
  const stem = dot > 0 ? videoName.slice(0, dot) : videoName;
  return `${stem}.${trackSlug(track)}.${track.subtitleIndex}.srt`;
}

export function describeTrack(track) {
  const parts = [`#${track.subtitleIndex}`, track.language || 'und', formatName(track.mimeType)];
  const flags = [track.default && 'default', track.forced && 'forced'].filter(Boolean);
  if (flags.length) parts.push(`[${flags.join(',')}]`);
  return parts.join('  ');
}

/** 파일 안의 자막 트랙 목록. 파일 앞부분만 읽으므로 즉시 끝난다. */
export async function listTracks(file) {
  return listSubtitleTracks(file);
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
export async function readTrackCues(file, track, timestampScale, onProgress) {
  const { samples } = await readSubtitleSamples(file, track.trackNumber, timestampScale, onProgress);
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
  if (track.mimeType === 'application/pgs') {
    const decoder = new PgsDecoder();
    return samples.map((sample) => {
      const image = decoder.decodeSegments(splitSampleSegments(sample.data));
      return {
        startMs: sample.startMs,
        durationMs: sample.durationMs,
        content: image ? { image } : null,
      };
    });
  }

  if (track.mimeType === 'application/vobsub') {
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

  // 글자 자막. MKV 안에서는 자막 내용만 UTF-8 로 들어 있다.
  return samples.map((sample) => {
    const text = decodeUtf8(sample.data).trim();
    return {
      startMs: sample.startMs,
      durationMs: sample.durationMs,
      content: text ? { text: track.mimeType === 'text/x-ssa' ? stripSsaFields(text) : text } : null,
    };
  });
}

function decodeUtf8(bytes) {
  if (!bytes || !bytes.length) return '';
  return new TextDecoder('utf-8').decode(bytes);
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
