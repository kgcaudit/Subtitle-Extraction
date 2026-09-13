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

/** 브라우저와 개발 서버를 띄우고 page 를 넘겨준다. */
async function withPage(run) {
  const playwright = await loadPlaywright();
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
    await run(page, pageErrors);
  } finally {
    await browser.close();
    server.close();
  }
}

/** 파일을 넣고 추출을 끝까지 돌린 뒤, 만들어진 SRT 를 이름과 함께 돌려준다. */
async function extractInBrowser(page, videoName, trackCount) {
  await page.setInputFiles('#file', fixture(videoName));
  await page.waitForFunction(
    (count) => document.querySelectorAll('#tracks .track').length === count,
    trackCount,
    { timeout: 30000 },
  );
  await page.click('#extract');
  await page.waitForFunction(
    (count) => document.querySelectorAll('#results .result').length === count,
    trackCount,
    { timeout: 540000 },
  );

  return page.evaluate(async () => {
    const items = [...document.querySelectorAll('#results .result')];
    return Promise.all(
      items.map(async (item) => {
        const link = item.querySelector('a');
        return { name: link.download, text: await (await fetch(link.href)).text() };
      }),
    );
  });
}

function assertMatchesPython(produced, expectedPrefix, expectedNames) {
  const byName = Object.fromEntries(produced.map((item) => [item.name, item.text]));
  assert.deepEqual(Object.keys(byName).sort(), expectedNames, '만들어진 파일 이름');

  for (const [name, actual] of Object.entries(byName)) {
    const suffix = name.slice(name.indexOf('.') + 1);
    const expected = readFileSync(fixture(`${expectedPrefix}.${suffix}`), 'utf8');
    assert.equal(actual, expected, `${name} 의 내용이 파이썬판과 다릅니다`);
  }
}

const skipReason = 'playwright 또는 vendor/ 가 없습니다 (npm install && npm run vendor)';

test('MKV: 글자·PGS·VobSub 세 트랙이 파이썬판과 같은 SRT 가 된다', { timeout: 600000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);

  await withPage(async (page, pageErrors) => {
    const produced = await extractInBrowser(page, 'sample.mkv', 3);
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assertMatchesPython(produced, 'expected', [
      'sample.eng.srt',
      'sample.kor.forced.srt',
      'sample.kor.srt',
    ]);
  });
});

test('MP4: 글자 자막 두 트랙이 파이썬판과 같은 SRT 가 된다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);

  await withPage(async (page, pageErrors) => {
    const produced = await extractInBrowser(page, 'sample.mp4', 2);
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assertMatchesPython(produced, 'expected.mp4', ['sample.eng.srt', 'sample.kor.srt']);
  });
});

test('자막이 없는 영상은 그렇다고 알려 준다', { timeout: 120000 }, async (t) => {
  if (!(await loadPlaywright())) return t.skip(skipReason);

  await withPage(async (page) => {
    await page.setInputFiles('#file', fixture('nosubs.mp4'));
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('자막 트랙이 없습니다'), {
      timeout: 30000,
    });
    assert.equal(await page.isVisible('#trackSection'), false, '트랙 목록이 보이면 안 됩니다');
  });
});
