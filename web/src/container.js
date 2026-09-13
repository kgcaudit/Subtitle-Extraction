// 영상 파일의 종류를 알아보고 알맞은 해석기로 넘긴다.
//
// 바깥(extract.js)에서는 컨테이너가 MKV 인지 MP4 인지 신경 쓰지 않는다.
// 어느 쪽이든 '자막 트랙 목록'과 '트랙의 샘플 목록'만 얻으면 되기 때문이다.

import { listSubtitleTracks, readSubtitleSamples } from './mkv.js';
import { looksLikeMp4, probeMp4, readMp4Samples } from './mp4.js';
import { readAscii } from './reader.js';

/** 파일 앞머리를 보고 종류를 가린다. 확장자는 믿지 않는다. */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) {
    return 'mkv';
  }
  if (head.length >= 8 && readAscii(head.subarray(4, 8)) === 'ftyp') return 'mp4';
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x47) return 'sup';
  return 'unknown';
}

/**
 * 자막 트랙 목록을 읽는다.
 *
 * @returns { container, tracks, context } - context 는 샘플을 읽을 때 되돌려 준다
 */
export async function probe(file) {
  const kind = await sniff(file);

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
  if (container === 'mp4') {
    return readMp4Samples(file, track, onProgress);
  }
  return readSubtitleSamples(file, track.trackNumber, context.timestampScale, onProgress);
}

export { looksLikeMp4 };
