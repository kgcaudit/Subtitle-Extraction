// 문자 인식 엔진을 불러온다.
//
// 먼저 web/vendor/ 를 시도한다(`npm run vendor` 로 채운다). 사내망처럼 바깥
// 인터넷이 막힌 곳에서도 그대로 돌게 하려는 것이다. 거기 없으면 공개 배포망에서
// 받아 온다.
//
// 경로는 '지금 열린 페이지' 가 아니라 '이 모듈의 위치' 를 기준으로 잡는다.
// 그래야 주소가 https://…/Subtitle-Extraction/ 처럼 하위 경로여도, tools/ 아래에서
// 열어도 똑같이 찾는다.

const CDN = 'https://cdn.jsdelivr.net/npm';
const VENDOR = new URL('../vendor/', import.meta.url).href;

const VENDOR_ASSETS = {
  source: 'vendor',
  script: `${VENDOR}tesseract.min.js`,
  workerPath: `${VENDOR}worker.min.js`,
  corePath: VENDOR,
  langPath: VENDOR,
};

const CDN_ASSETS = {
  source: 'cdn',
  script: `${CDN}/tesseract.js@7/dist/tesseract.min.js`,
  workerPath: `${CDN}/tesseract.js@7/dist/worker.min.js`,
  corePath: `${CDN}/tesseract.js-core@7`,
  // 비워 두면 tesseract.js 가 자기 기본 위치에서 언어 자료를 받는다.
  langPath: undefined,
};

/**
 * 엔진을 실제로 불러오고, 어디서 불러왔는지를 돌려준다.
 *
 * 있는지 먼저 물어보는(HEAD) 방식은 서버에 따라 답이 달라 못 믿는다.
 * 그냥 불러 보고 안 되면 다음 곳으로 넘어간다.
 */
export async function ensureTesseract() {
  if (globalThis.Tesseract) return globalThis.__subexAssets ?? VENDOR_ASSETS;

  const failures = [];
  for (const assets of [VENDOR_ASSETS, CDN_ASSETS]) {
    try {
      await loadScript(assets.script);
      globalThis.__subexAssets = assets;
      return assets;
    } catch (error) {
      failures.push(error.message);
    }
  }
  throw new Error(
    '문자 인식 엔진을 불러오지 못했습니다. 인터넷이 막혀 있다면 web 폴더에서 ' +
      `\`npm install && npm run vendor\` 를 실행해 주세요.\n${failures.join('\n')}`,
  );
}

export function loadScript(url) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = url;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`불러오지 못했습니다: ${url}`));
    document.head.append(element);
  });
}
