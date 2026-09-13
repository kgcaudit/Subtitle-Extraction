// 문자 인식 엔진 파일을 어디서 가져올지 정한다.
//
// 기본은 같은 폴더의 vendor/ 다(`npm run vendor` 로 채운다). 사내망처럼 바깥
// 인터넷이 막힌 곳에서도 그대로 돌게 하려는 것이다. vendor/ 가 없으면 공개
// 배포망에서 받아 온다.

const CDN = 'https://cdn.jsdelivr.net/npm';

async function exists(url) {
  try {
    const response = await fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

export async function resolveAssets() {
  if (await exists('./vendor/tesseract.min.js')) {
    return {
      source: 'vendor',
      script: './vendor/tesseract.min.js',
      workerPath: './vendor/worker.min.js',
      corePath: './vendor/',
      langPath: './vendor/',
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
