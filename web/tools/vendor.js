// 문자 인식 엔진을 web/vendor/ 로 복사한다.
//
// 이렇게 해 두면 바깥 인터넷이 막힌 사내망에서도 그대로 돌아간다.
//   npm install && npm run vendor
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createReadStream, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const VENDOR = join(ROOT, 'vendor');
const MODULES = join(ROOT, 'node_modules');

const TESSDATA_URL = 'https://tessdata.projectnaptha.com/4.0.0';
/** 우리말 자막이 목적이므로 한국어와 영어를 받는다. */
const LANGUAGES = (process.env.SUBEX_LANGS ?? 'kor,eng').split(',');

/** 이미 설치된 tesseract 가 있으면 언어 자료를 거기서 가져온다. */
const LOCAL_TESSDATA = [
  '/usr/share/tesseract-ocr/5/tessdata',
  '/usr/share/tesseract-ocr/4.00/tessdata',
  '/opt/homebrew/share/tessdata',
  '/usr/local/share/tessdata',
];

async function main() {
  if (!existsSync(MODULES)) {
    console.error('먼저 `npm install` 을 실행하세요.');
    process.exit(1);
  }
  mkdirSync(VENDOR, { recursive: true });

  for (const name of ['tesseract.min.js', 'worker.min.js']) {
    copyFileSync(join(MODULES, 'tesseract.js/dist', name), join(VENDOR, name));
  }

  const coreDir = join(MODULES, 'tesseract.js-core');
  for (const name of readdirSync(coreDir)) {
    if (name.endsWith('.js') || name.endsWith('.wasm')) {
      copyFileSync(join(coreDir, name), join(VENDOR, name));
    }
  }

  for (const language of LANGUAGES) {
    const target = join(VENDOR, `${language}.traineddata.gz`);
    const local = LOCAL_TESSDATA.map((dir) => join(dir, `${language}.traineddata`)).find(existsSync);
    if (local) {
      await pipeline(createReadStream(local), createGzip(), createWriteStream(target));
      console.log(`${language}: 설치된 tesseract 에서 가져왔습니다 (${local})`);
    } else {
      const response = await fetch(`${TESSDATA_URL}/${language}.traineddata.gz`);
      if (!response.ok) throw new Error(`${language} 언어 자료를 받지 못했습니다 (${response.status})`);
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      console.log(`${language}: 내려받았습니다`);
    }
  }

  console.log(`완료: ${VENDOR}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
