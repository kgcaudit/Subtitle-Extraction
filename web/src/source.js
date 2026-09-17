// 고른 파일들을 '읽을 파일 하나 + 곁들인 .idx' 로 정리한다.
//
// 대부분은 영상 파일 하나면 끝이다. 다만 DVD 자막(.idx/.sub)만은 두 파일이
// 짝이라 둘 다 있어야 한다. .sub 에는 그림만 있고, 색과 시각 표는 .idx 에
// 따로 있기 때문이다.
//
// 휴대폰 파일 고르기는 대개 한 번에 하나만 고르게 한다. 그래서 '두 개를 한꺼번에
// 고르라' 고 하면 폰에서는 아예 쓸 수 없다. 대신 **하나씩 받아 모은다**.
// 먼저 온 것을 들고 있다가 짝이 오면 그때 잇는다. 순서는 상관없다.

import { looksLikeIdx, looksLikeProgramStream } from './vobsubFile.js';

/** .idx 는 표만 든 텍스트라 작다. 이보다 큰 파일은 .idx 인지 들여다보지 않는다. */
const IDX_SIZE_LIMIT = 32 << 20;

/** 앞머리만 읽어도 .idx 인지 가릴 수 있다. */
const IDX_SNIFF_BYTES = 4096;

/** 앞머리 내용을 보고 .idx 인지 가린다. 확장자는 믿지 않는다. */
async function isIdx(file) {
  if (file.size > IDX_SIZE_LIMIT) return false;
  try {
    return looksLikeIdx(await file.slice(0, IDX_SNIFF_BYTES).text());
  } catch {
    return false;
  }
}

/** 이 파일이 .sub(MPEG 프로그램 스트림)이라 .idx 가 있어야 하는지. */
export async function needsIndex(file) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  return looksLikeProgramStream(head);
}

/** 고른 파일들을 '.idx' 와 '그 밖의 것' 으로 가른다. */
export async function classify(files) {
  let indexFile = null;
  let mainFile = null;

  for (const file of files) {
    if (!indexFile && (await isIdx(file))) indexFile = file;
    else mainFile ??= file;
  }
  return { indexFile, mainFile };
}

/**
 * 지금까지 모인 것으로 읽을 준비가 됐는지 본다.
 *
 * @param held { indexFile, mainFile } - 앞서 고른 것까지 합친 것
 * @returns { ready, file, indexText } 또는 { ready:false, waitingFor, message }
 */
export async function resolveSource({ indexFile, mainFile }) {
  if (!mainFile && !indexFile) return { ready: false };

  if (!mainFile) {
    return {
      ready: false,
      waitingFor: 'sub',
      message:
        `'${indexFile.name}' 을(를) 받았습니다 — 색과 시각 표입니다. ` +
        '이제 자막 그림이 든 **.sub 파일**을 고르면 이어서 진행합니다.',
    };
  }

  if (!indexFile && (await needsIndex(mainFile))) {
    return {
      ready: false,
      waitingFor: 'idx',
      message:
        `'${mainFile.name}' 을(를) 받았습니다 — 자막 그림입니다. ` +
        '색과 시각은 짝이 되는 **.idx 파일**에 들어 있습니다. 이제 그 .idx 를 고르면 이어서 진행합니다.',
    };
  }

  return { ready: true, file: mainFile, indexText: indexFile ? await indexFile.text() : null };
}
