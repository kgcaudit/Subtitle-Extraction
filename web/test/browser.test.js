// 진짜 브라우저에서 처음부터 끝까지 돌려 보고, 결과 SRT 가 파이썬판과 같은지 본다.
//
// 이게 이 프로젝트에서 가장 중요한 시험이다. 자막을 꺼내고, 그림을 해독하고,
// 글자를 읽고, 다듬어 SRT 로 만드는 전 과정을 한 번에 확인하기 때문이다.
//
// 준비물: `npm install && npm run vendor` (문자 인식 엔진을 vendor/ 로 복사)
// Playwright 나 vendor/ 가 없으면 이 시험은 건너뛴다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const vendorReady = existsSync(fileURLToPath(new URL('../vendor/tesseract.min.js', import.meta.url)));

/** 환경에 설치된 크로미움을 찾는다. */
const CHROMIUM_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    return null;
  }
}

test('브라우저 전체 흐름이 파이썬판과 같은 SRT 를 만든다', { timeout: 600000 }, async (t) => {
  const playwright = await loadPlaywright();
  if (!playwright || !vendorReady) {
    t.skip('playwright 또는 vendor/ 가 없습니다 (npm install && npm run vendor)');
    return;
  }

  const { createStaticServer } = await import('../tools/serve.js');
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const executablePath = CHROMIUM_CANDIDATES.find(existsSync);
  const browser = await playwright.chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`http://127.0.0.1:${port}/index.html`);
    await page.setInputFiles('#file', fixture('sample.mkv'));

    // 자막 트랙 세 개가 잡혀야 한다.
    await page.waitForFunction(() => document.querySelectorAll('#tracks .track').length === 3, {
      timeout: 30000,
    });

    await page.click('#extract');
    await page.waitForFunction(() => document.querySelectorAll('#results .result').length === 3, {
      timeout: 540000,
    });

    const produced = await page.evaluate(async () => {
      const items = [...document.querySelectorAll('#results .result')];
      return Promise.all(
        items.map(async (item) => {
          const link = item.querySelector('a');
          const text = await (await fetch(link.href)).text();
          return { name: link.download, text };
        }),
      );
    });

    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');

    const byName = Object.fromEntries(produced.map((item) => [item.name, item.text]));
    assert.deepEqual(
      Object.keys(byName).sort(),
      ['sample.eng.srt', 'sample.kor.forced.srt', 'sample.kor.srt'],
      '만들어진 파일 이름',
    );

    for (const [name, actual] of Object.entries(byName)) {
      const expected = readFileSync(fixture(`expected.${name.slice('sample.'.length)}`), 'utf8');
      assert.equal(actual, expected, `${name} 의 내용이 파이썬판과 다릅니다`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
