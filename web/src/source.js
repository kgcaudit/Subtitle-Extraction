// 고른 파일들을 '읽을 파일 하나 + 곁들인 .idx' 로 정리한다.
//
// 대부분은 영상 파일 하나면 끝이다. 다만 DVD 자막(.idx/.sub)만은 두 파일이
// 짝이라 둘 다 있어야 한다. .sub 에는 그림만 있고, 색과 시각 표는 .idx 에
// 따로 있기 때문이다. 브라우저는 고르지 않은 파일에 손댈 수 없으므로,
// 짝이 안 맞으면 무엇이 더 필요한지 알려 준다.

import { looksLikeIdx } from './vobsubFile.js';

/** .idx 는 표만 든 텍스트라 작다. 이보다 큰 파일은 .idx 인지 들여다보지 않는다. */
const IDX_SIZE_LIMIT = 32 << 20;

/** 앞머리만 읽어도 .idx 인지 가릴 수 있다. */
const IDX_SNIFF_BYTES = 4096;

/**
 * @param files 사용자가 고르거나 끌어다 놓은 파일들
 * @returns { file, indexText } - 고른 게 없으면 null
 * @throws .idx 만 골랐을 때처럼 짝이 안 맞는 경우
 */
export async function pickSource(files) {
  const list = [...files];
  if (!list.length) return null;

  let indexFile = null;
  for (const file of list) {
    // 이름이 아니라 앞머리 내용을 보고 가린다. 확장자는 믿지 않는다.
    if (file.size > IDX_SIZE_LIMIT) continue;
    if (looksLikeIdx(await file.slice(0, IDX_SNIFF_BYTES).text())) {
      indexFile = file;
      break;
    }
  }

  const main = list.find((file) => file !== indexFile) ?? null;
  if (!main) {
    throw new Error(
      `${indexFile.name} 은(는) 색과 시각 표만 담긴 파일이라 이것만으로는 자막을 만들 수 없습니다. ` +
        '같은 이름의 .sub 파일도 함께 골라 주세요 (둘을 한 번에 선택하거나 같이 끌어다 놓으면 됩니다).',
    );
  }

  return { file: main, indexText: indexFile ? await indexFile.text() : null };
}
