// 브라우저 안에서 도는 문자 인식(tesseract.js).
//
// 인식기를 여러 개 띄워 나눠 돌린다. 측정해 보면 4개일 때 장당 42밀리초로
// 1개(114밀리초)보다 훨씬 빠르다. 다만 개수를 코어 수보다 늘리면 서로 경합해
// 오히려 느려지므로 코어 수를 넘기지 않는다.

const DEFAULT_LANGUAGE = 'kor+eng';

/** 자막은 여러 줄이 한 덩어리로 들어오므로 '균일한 블록'(6번)이 맞다. */
const PAGE_SEG_MODE_SINGLE_BLOCK = '6';

export function suggestedWorkerCount() {
  const cores = globalThis.navigator?.hardwareConcurrency ?? 4;
  return Math.max(1, Math.min(4, cores));
}

export class OcrPool {
  constructor(scheduler, workers) {
    this.scheduler = scheduler;
    this.workers = workers;
  }

  /**
   * @param assets { workerPath, corePath, langPath } - 파일 위치
   * @param options { language, workers }
   */
  static async create(assets, { language = DEFAULT_LANGUAGE, workers = suggestedWorkerCount() } = {}) {
    const { createScheduler, createWorker } = globalThis.Tesseract;
    const scheduler = createScheduler();
    const created = [];

    for (let index = 0; index < workers; index += 1) {
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
      scheduler.addWorker(worker);
      created.push(worker);
    }
    return new OcrPool(scheduler, created);
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
