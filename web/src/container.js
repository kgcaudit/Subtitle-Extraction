// 영상 파일의 종류를 알아보고 알맞은 해석기로 넘긴다.
//
// 바깥(extract.js)에서는 컨테이너가 MKV 인지 MP4 인지 신경 쓰지 않는다.
// 어느 쪽이든 '자막 트랙 목록'과 '트랙의 샘플 목록'만 얻으면 되기 때문이다.

import { listSubtitleTracks, readSamplesForTracks, readSubtitleSamples } from './mkv.js';
import { looksLikeMp4, probeMp4, readMp4Samples } from './mp4.js';
import { readAscii } from './reader.js';
import { MIME } from './mime.js';
import { looksLikeProgramStream, parseIdx, readVobsubSamples } from './vobsubFile.js';

/** 파일 앞머리를 보고 종류를 가린다. 확장자는 믿지 않는다. */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'mkv';
  }
  if (head.length >= 8 && readAscii(head.subarray(4, 8)) === 'ftyp') return 'mp4';
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x47) return 'sup';
  // .sub 은 MPEG 프로그램 스트림이다. 짝이 되는 .idx 가 있어야 읽을 수 있다.
  if (looksLikeProgramStream(head)) return 'vobsub';
  return 'unknown';
}

/**
 * 자막 트랙 목록을 읽는다.
 *
 * @returns { container, tracks, context } - context 는 샘플을 읽을 때 되돌려 준다
 */
export async function probe(file, { indexText = null } = {}) {
  const kind = await sniff(file);

  if (kind === 'vobsub') {
    if (!indexText) {
      throw new Error(
        '이 파일은 .sub 자막입니다. 짝이 되는 같은 이름의 .idx 파일도 함께 골라 주세요. ' +
          '(.idx 에 색과 시각 표가 들어 있어 둘이 있어야 읽을 수 있습니다)',
      );
    }
    const index = parseIdx(indexText);
    if (!index.streams.length) {
      throw new Error('.idx 에서 자막 표를 찾지 못했습니다. 짝이 맞는 .idx 인지 확인해 주세요.');
    }
    return {
      container: 'vobsub',
      tracks: index.streams.map((stream) => ({
        trackNumber: stream.index,
        subtitleIndex: stream.subtitleIndex,
        mimeType: MIME.VOBSUB,
        language: stream.language,
        default: stream.subtitleIndex === 0,
        forced: false,
        codecPrivate: indexText,        // 팔레트가 이 텍스트 안에 있다
        vobsubStream: stream,
      })),
      context: { index },
    };
  }

  if (kind === 'mkv') {
    const { tracks, timestampScale } = await listSubtitleTracks(file);
    return { container: 'mkv', tracks, context: { timestampScale } };
  }

  if (kind === 'mp4') {
    const { tracks } = await probeMp4(file);
    return { container: 'mp4', tracks, context: {} };
  }

  if (kind === 'sup') {
    // 자막만 든 파일. 트랙이라는 개념이 없어 하나로 취급한다.
    return {
      container: 'sup',
      tracks: [
        {
          trackNumber: 0,
          subtitleIndex: 0,
          mimeType: 'application/pgs',
          language: null,
          default: false,
          forced: false,
          standaloneSup: true,
        },
      ],
      context: {},
    };
  }

  throw new Error(
    '읽을 수 있는 형식이 아닙니다. MKV · WebM · MP4 · MOV, 그리고 .sup 자막 파일을 지원합니다.',
  );
}

/** 트랙 하나의 샘플(자막 조각)을 읽는다. */
export async function readSamples(file, track, container, context, onProgress) {
  if (container === 'vobsub') {
    return readVobsubSamples(file, track.vobsubStream, onProgress);
  }
  if (container === 'mp4') {
    return readMp4Samples(file, track, onProgress);
  }
  return readSubtitleSamples(file, track.trackNumber, context.timestampScale, onProgress);
}

/**
 * 여러 트랙의 조각을 **파일을 한 번만 지나가며** 읽는다. 못 하는 형식이면 null.
 *
 * MKV 만 이득이 있다. MP4 는 원래 표를 보고 제 자리만 집어 읽고, DVD 자막(.idx)도
 * 스트림마다 자리표가 따로 있어 트랙을 늘려도 남의 자리를 읽지 않는다.
 *
 * @returns Map<자막 순번, { samples }> 또는 null
 */
export async function readSamplesForAll(file, tracks, container, context, onProgress) {
  if (container !== 'mkv' || tracks.length < 2) return null;

  const byNumber = await readSamplesForTracks(
    file, tracks.map((track) => track.trackNumber), context.timestampScale, onProgress,
  );
  return new Map(tracks.map((track) => [track.subtitleIndex, byNumber.get(track.trackNumber)]));
}

export { looksLikeMp4 };
