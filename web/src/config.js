// 문자 인식 엔진 파일을 어디서 가져올지 정한다.
//
// 기본은 web/vendor/ 다(`npm run vendor` 로 채운다). 사내망처럼 바깥 인터넷이
// 막힌 곳에서도 그대로 돌게 하려는 것이다. vendor/ 가 없으면 공개 배포망에서
// 받아 온다.
//
// 경로는 '지금 열린 페이지' 가 아니라 '이 모듈의 위치' 를 기준으로 잡는다.
// 그래야 index.html 에서 열든 tools/ 아래에서 열든 똑같이 찾는다.

const CDN = 'https://cdn.jsdelivr.net/npm';
const VENDOR = new URL('../vendor/', import.meta.url).href;

async function exists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

export async function resolveAssets() {
  if (await exists(`${VENDOR}tesseract.min.js`)) {
    return {
      source: 'vendor',
      script: `${VENDOR}tesseract.min.js`,
      workerPath: `${VENDOR}worker.min.js`,
      corePath: VENDOR,
      langPath: VENDOR,
    };
  }
  return {
    source: 'cdn',
    script: `${CDN}/tesseract.js@7/dist/tesseract.min.js`,
    workerPath: `${CDN}/tesseract.js@7/dist/worker.min.js`,
    corePath: `${CDN}/tesseract.js-core@7`,
    // 비워 두면 tesseract.js 가 자기 기본 위치에서 언어 자료를 받는다.
    langPath: undefined,
  };
}

export function loadScript(url) {
  return new Promise((resolve, reject) => {
    const element = document.createElement('script');
    element.src = url;
    element.onload = () => resolve();
    element.onerror = () => reject(new Error(`문자 인식 엔진을 불러오지 못했습니다: ${url}`));
    document.head.append(element);
  });
}
