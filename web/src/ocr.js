// 브라우저 안에서 도는 문자 인식(tesseract.js).
//
// 인식기를 여러 개 띄워 나눠 돌린다. 측정해 보면 4개일 때 장당 42밀리초로
// 1개(114밀리초)보다 훨씬 빠르다. 다만 개수를 코어 수보다 늘리면 서로 경합해
// 오히려 느려지므로 코어 수를 넘기지 않는다.

const DEFAULT_LANGUAGE = 'kor+eng';

/** 자막은 여러 줄이 한 덩어리로 들어오므로 '균일한 블록'(6번)이 맞다. */
const PAGE_SEG_MODE_SINGLE_BLOCK = '6';

/** 자동 선택에 쓸 표본 수. 12장이면 1초 남짓이면 끝난다. */
const AUTO_SAMPLE_SIZE = 12;

/**
 * 라틴 낱말 신뢰도가 이 값보다 낮으면 '진짜 영문' 이 아니라고 본다.
 * 실측: 한글 전용 자막 16.8, 한·영 혼합 자막 95.0 — 그 사이에 둔다.
 */
const LATIN_IS_REAL_CONFIDENCE = 50;

const LATIN_WORD = /^[^\uAC00-\uD7A3]*[A-Za-z][^\uAC00-\uD7A3]*$/;

export function suggestedWorkerCount() {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores));
}

async function createTesseractWorker(assets, language) {
  const { createWorker } = globalThis.Tesseract;
  const worker = await createWorker(language, 1, {
    workerPath: assets.workerPath,
    corePath: assets.corePath,
    langPath: assets.langPath,
    gzip: true,
    logger: () => {},
  });
  await worker.setParameters({
    tessedit_pageseg_mode: PAGE_SEG_MODE_SINGLE_BLOCK,
    preserve_interword_spaces: '1',
  });
  return worker;
}

/**
 * 인식 언어를 자동으로 고른다.
 *
 * 자막이 한글만 있으면 '한국어만'이, 영문이 섞여 있으면 '한국어+영어'가
 * 뚜렷하게 낫다(실측: 한글 전용 자막에서 98.0% 대 89.7%, 혼합 자막에서는
 * 반대로 39% 대 100%).
 *
 * 두 설정의 전체 신뢰도를 견주는 방법은 차이가 너무 작아 못 믿는다
 * (400장에서 89.8 대 89.5 로 뒤집혔다). 대신 안전한 쪽('한국어+영어')으로
 * 표본을 읽어 **라틴 낱말이 진짜인지**를 본다. 진짜 영어면 자신 있게 읽고,
 * 한글을 영문으로 잘못 읽은 것이면 자신 없어 하기 때문에 확실히 갈린다.
 */
export async function pickLanguage(assets, images) {
  const step = Math.max(1, Math.floor(images.length / AUTO_SAMPLE_SIZE));
  const sample = images.filter((_, index) => index % step === 0).slice(0, AUTO_SAMPLE_SIZE);
  if (!sample.length) return { language: DEFAULT_LANGUAGE, latinWords: 0, latinConfidence: 0, sampleSize: 0 };

  const blobs = await Promise.all(sample.map(toPngBlob));
  const worker = await createTesseractWorker(assets, DEFAULT_LANGUAGE);

  let latinWords = 0;
  let latinConfidenceSum = 0;
  let totalWords = 0;

  try {
    for (const blob of blobs) {
      const { data } = await worker.recognize(blob, {}, { blocks: true });
      for (const word of wordsOf(data)) {
        const text = (word.text ?? '').trim();
        if (!text) continue;
        totalWords += 1;
        if (LATIN_WORD.test(text)) {
          latinWords += 1;
          latinConfidenceSum += word.confidence;
        }
      }
    }
  } finally {
    await worker.terminate();
  }

  const latinConfidence = latinWords ? latinConfidenceSum / latinWords : 0;
  const hasRealLatin = latinWords > 0 && latinConfidence >= LATIN_IS_REAL_CONFIDENCE;

  return {
    language: hasRealLatin ? DEFAULT_LANGUAGE : 'kor',
    latinWords,
    totalWords,
    latinConfidence,
    sampleSize: sample.length,
  };
}

function wordsOf(data) {
  return (data.blocks ?? []).flatMap((block) =>
    (block.paragraphs ?? []).flatMap((paragraph) =>
      (paragraph.lines ?? []).flatMap((line) => line.words ?? []),
    ),
  );
}

export class OcrPool {
  constructor(scheduler, workers, language) {
    this.scheduler = scheduler;
    this.workers = workers;
    this.language = language;
  }

  /**
   * @param assets { workerPath, corePath, langPath } - 파일 위치
   * @param options { language, workers }
   */
  static async create(assets, { language = DEFAULT_LANGUAGE, workers = suggestedWorkerCount() } = {}) {
    const { createScheduler } = globalThis.Tesseract;
    const scheduler = createScheduler();
    const created = [];

    for (let index = 0; index < workers; index += 1) {
      const worker = await createTesseractWorker(assets, language);
      scheduler.addWorker(worker);
      created.push(worker);
    }
    return new OcrPool(scheduler, created, language);
  }

  /**
   * 그림 여러 장을 읽는다. 순서는 입력 순서 그대로 유지된다.
   *
   * @param images [{width, height, data}] - 전처리를 마친 그림
   * @param onProgress (done, total) => void
   */
  async recognizeAll(images, onProgress) {
    let done = 0;
    const total = images.length;

    const jobs = images.map(async (image) => {
      const blob = await toPngBlob(image);
      const { data } = await this.scheduler.addJob('recognize', blob);
      done += 1;
      onProgress?.(done, total);
      return data.text.trim();
    });

    return Promise.all(jobs);
  }

  async terminate() {
    await this.scheduler.terminate();
  }
}

/**
 * 인식기에는 그림 파일 형태로 넘기는 게 가장 확실하다. 캔버스 객체는
 * 작업 스레드로 넘길 때 사라질 수 있어서 PNG 로 굳혀 보낸다.
 */
async function toPngBlob(image) {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const context = canvas.getContext('2d');
  context.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}
