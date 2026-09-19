// 진짜 브라우저에서 처음부터 끝까지 돌려 보고, 결과 SRT 가 파이썬판과 같은지 본다.
//
// 이게 이 프로젝트에서 가장 중요한 시험이다. 자막을 꺼내고, 그림을 해독하고,
// 글자를 읽고, 다듬어 SRT 로 만드는 전 과정을 한 번에 확인하기 때문이다.
//
// 준비물: `npm install && npm run vendor` (문자 인식 엔진을 vendor/ 로 복사)
// Playwright 나 vendor/ 가 없으면 이 시험은 건너뛴다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

/**
 * 파일을 넣고 추출을 끝까지 돌린 뒤, 만들어진 SRT 를 이름과 함께 돌려준다.
 * DVD 자막(.idx/.sub)처럼 두 파일이 짝인 경우를 위해 이름 여럿도 받는다.
 */
async function extractInBrowser(page, videoName, trackCount) {
  const names = Array.isArray(videoName) ? videoName : [videoName];
  await page.setInputFiles('#file', names.map(fixture));
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

/** 글자 하나 단위로 얼마나 맞는지. */
function characterAccuracy(expected, actual) {
  const distance = levenshtein(expected, actual);
  return expected.length ? (1 - distance / expected.length) * 100 : 100;
}

function levenshtein(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j];
      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = temp;
    }
  }
  return previous[b.length];
}

test('실제 자막에 가까운 .sup 도 끝까지 처리된다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);
  if (!existsSync(fixture('rich.sup'))) return t.skip('한글 글꼴이 없어 만들지 못한 자료입니다');

  await withPage(async (page, pageErrors) => {
    // 파이썬 정답지가 '한국어+영어' 로 만들어졌으므로 같은 설정으로 맞춘다.
    await page.click('.settings > summary');
    await page.selectOption('#ocrLang', 'kor+eng');

    const produced = await extractInBrowser(page, 'rich.sup', 1);
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assert.equal(produced.length, 1);

    const expected = readFileSync(fixture('expected.rich.srt'), 'utf8');
    const actual = produced[0].text;

    // 시각은 정확히 같아야 한다 — 여기가 틀리면 자막을 꺼내는 쪽 문제다.
    const times = (text) => [...text.matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)].map((m) => m[0]);
    assert.deepEqual(times(actual), times(expected), '시각이 파이썬판과 다릅니다');

    // 글자는 인식 엔진이 달라(WebAssembly 대 네이티브) 아주 조금 갈릴 수 있다.
    const accuracy = characterAccuracy(expected, actual);
    assert.ok(accuracy >= 95, `글자 일치율이 ${accuracy.toFixed(1)}% 입니다 (95% 이상이어야 함)`);
  });
});

test('인식 언어를 바꿔도 끝까지 처리된다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);
  if (!existsSync(fixture('rich.sup'))) return t.skip('한글 글꼴이 없어 만들지 못한 자료입니다');

  await withPage(async (page, pageErrors) => {
    await page.click('.settings > summary'); // 설정은 접혀 있다. 사용자처럼 펼친다.
    await page.selectOption('#ocrLang', 'kor');
    await page.selectOption('#ocrFit', 'off');
    const produced = await extractInBrowser(page, 'rich.sup', 1);
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assert.ok(produced[0].text.includes('-->'), 'SRT 가 만들어지지 않았습니다');
  });
});

test('자동 선택이 한글 전용 자막에서는 한국어만 고른다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);
  if (!existsSync(fixture('rich.sup'))) return t.skip('한글 글꼴이 없어 만들지 못한 자료입니다');

  await withPage(async (page) => {
    // 기본값이 '자동' 이므로 아무것도 건드리지 않는다.
    await extractInBrowser(page, 'rich.sup', 1);
    const status = await page.textContent('#status');
    assert.match(status, /한국어만/, `고른 언어가 예상과 다릅니다: ${status}`);
  });
});

test('자동 선택이 한·영 혼합 자막에서는 한국어+영어를 고른다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);

  await withPage(async (page) => {
    await extractInBrowser(page, 'sample.sup', 1);
    const status = await page.textContent('#status');
    assert.match(status, /한국어\+영어/, `고른 언어가 예상과 다릅니다: ${status}`);
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

test('VobSub: .idx/.sub 짝을 화면에 넣어도 끝까지 처리된다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);

  // 영상 없이 자막 파일 두 개만 있는 경우다. 파일 고르기에서 둘을 함께 넣는다.
  await withPage(async (page, pageErrors) => {
    const produced = await extractInBrowser(page, ['sample.idx', 'sample.sub'], 1);
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assert.equal(produced.length, 1);

    // 이름은 .idx 가 아니라 알맹이가 든 .sub 과 그 안의 언어(ko)에서 온다.
    assert.equal(produced[0].name, 'sample.ko.srt', '만들어진 파일 이름');

    // 시각은 파이썬판이 같은 .idx 를 읽어 낸 값과 정확히 같아야 한다.
    const golden = JSON.parse(readFileSync(fixture('bitmaps.json'), 'utf8'));
    const stamp = (ms) => {
      const pad = (value, width = 2) => String(value).padStart(width, '0');
      return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:` +
        `${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
    };
    const expectedTimes = golden.vobsubFromIdx.map((cue) => `${stamp(cue.startMs)} --> ${stamp(cue.endMs)}`);
    const actualTimes = [...produced[0].text.matchAll(/\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d/g)]
      .map((match) => match[0]);
    assert.deepEqual(actualTimes, expectedTimes, '시각이 파이썬판과 다릅니다');
  });
});

test('VobSub: .idx 와 .sub 을 하나씩 차례로 골라도 이어진다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright()) || !vendorReady) return t.skip(skipReason);

  // 휴대폰 파일 고르기는 대개 한 번에 하나만 고르게 한다. 그래서 한 번에 둘을
  // 못 고르는 상황이 실제 사용 환경이다. 여기서는 그 경우를 그대로 재현한다.
  await withPage(async (page, pageErrors) => {
    // 1) 먼저 .sub 만 고른다 → 오류가 아니라 '이제 .idx 를 고르라' 는 안내여야 한다.
    await page.setInputFiles('#file', fixture('sample.sub'));
    await page.waitForFunction(
      () => document.getElementById('status').classList.contains('waiting'),
      { timeout: 30000 },
    );
    const waiting = await page.textContent('#status');
    assert.match(waiting, /\.idx/, `이제 무엇을 고르면 되는지 알려 줘야 합니다: ${waiting}`);
    assert.equal(
      await page.evaluate(() => document.getElementById('status').classList.contains('error')),
      false,
      '기다리는 중은 오류가 아닙니다',
    );

    // 2) 이어서 .idx 를 고른다 → 앞서 고른 .sub 과 짝이 맞아 트랙이 나와야 한다.
    await page.setInputFiles('#file', fixture('sample.idx'));
    await page.waitForFunction(
      () => document.querySelectorAll('#tracks .track').length === 1,
      { timeout: 30000 },
    );

    await page.click('#extract');
    await page.waitForFunction(
      () => document.querySelectorAll('#results .result').length === 1,
      { timeout: 300000 },
    );
    const produced = await page.evaluate(async () => {
      const link = document.querySelector('#results .result a');
      return { name: link.download, text: await (await fetch(link.href)).text() };
    });

    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assert.equal(produced.name, 'sample.ko.srt');
    assert.match(produced.text, /-->/, 'SRT 가 만들어지지 않았습니다');
  });
});

test('VobSub: .idx 를 먼저 골라도 이어진다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright())) return t.skip(skipReason);

  // 순서는 상관없어야 한다.
  await withPage(async (page) => {
    await page.setInputFiles('#file', fixture('sample.idx'));
    await page.waitForFunction(
      () => document.getElementById('status').classList.contains('waiting'),
      { timeout: 30000 },
    );
    const waiting = await page.textContent('#status');
    assert.match(waiting, /\.sub/, `이제 무엇을 고르면 되는지 알려 줘야 합니다: ${waiting}`);

    await page.setInputFiles('#file', fixture('sample.sub'));
    await page.waitForFunction(
      () => document.querySelectorAll('#tracks .track').length === 1,
      { timeout: 30000 },
    );
  });
});

/**
 * 자막이 많이 든 파일에서 고르고 받는 화면.
 *
 * 실제로 쓰는 블루레이 리믹스에는 자막이 28개씩 들어 있다. 그런 파일을 열었을
 * 때 하나씩 눌러야 하거나, 뽑은 뒤에 또 하나씩 받아야 하면 폰에서는 쓸 수가
 * 없다. 여기서 보는 것은 그 화면이 실제로 손에 맞는가다.
 */
test('자막이 많으면 스스로 고르지 않고, 전체 선택·언어별 고르기가 듣는다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright())) return t.skip(skipReason);

  await withPage(async (page, pageErrors) => {
    await page.setInputFiles('#file', fixture('many.mkv'));
    await page.waitForFunction(
      () => document.querySelectorAll('#tracks .track').length === 8,
      { timeout: 30000 },
    );

    const checked = () => page.evaluate(
      () => document.querySelectorAll('#tracks input[type="checkbox"]:checked').length,
    );

    // 많으면 스스로 다 골라 두지 않는다 — 두 개만 받고 싶은 사람이 훨씬 많다.
    assert.equal(await checked(), 0, '자막이 많은데도 스스로 골라 두었습니다');
    assert.equal(await page.textContent('#trackCount'), '8개 중 0개 선택');
    assert.ok(await page.isDisabled('#selectNone'), '고른 게 없으면 전체 해제는 눌리지 않아야 합니다');

    await page.click('#selectAll');
    assert.equal(await checked(), 8);
    assert.equal(await page.textContent('#trackCount'), '8개 중 8개 선택');

    await page.click('#selectNone');
    assert.equal(await checked(), 0);

    // 언어 알약: 한국어 하나만 집어낸다.
    await page.click('#langChips button[data-lang="KOR"]');
    assert.equal(await checked(), 1, '언어로 고르면 그 언어만 골라져야 합니다');
    assert.equal(
      await page.getAttribute('#langChips button[data-lang="KOR"]', 'aria-pressed'),
      'true',
    );

    await page.click('#selectAll');
    await page.click('#extract');
    await page.waitForFunction(
      () => document.querySelectorAll('#results .result').length === 8,
      { timeout: 300000 },
    );
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');
    assert.equal(await page.textContent('#resultCount'), '8개 중 8개 선택');
    assert.equal(await page.textContent('#downloadZip'), '8개 한 번에 받기 (zip)');

    await page.click('#resultNone');
    assert.ok(await page.isDisabled('#downloadZip'), '고른 게 없으면 받기는 눌리지 않아야 합니다');

    // 세 개만 골라 한 번에 받는다.
    for (const index of [0, 2, 5]) {
      await page.check(`#results .result:nth-child(${index + 1}) input[type="checkbox"]`);
    }
    assert.equal(await page.textContent('#downloadZip'), '3개 한 번에 받기 (zip)');

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#downloadZip'),
    ]);
    // 이름이 그대로 남아야 한다. 한글이 섞이면 크로뮴이 이름을 통째로 버리고
    // 확장자 없는 'download' 로 저장해 버리는 환경이 있다.
    assert.equal(download.suggestedFilename(), 'many.subtitles-3.zip');

    const saved = join(tmpdir(), `subex-${Date.now()}.zip`);
    await download.saveAs(saved);
    try {
      const names = execFileSync('python3', ['-c', [
        'import sys, zipfile',
        'z = zipfile.ZipFile(sys.argv[1])',
        'assert z.testzip() is None',
        'print("\\n".join(z.namelist()))',
      ].join('\n'), saved], { encoding: 'utf8' }).trim().split('\n');
      assert.equal(names.length, 3, `묶인 파일: ${names.join(', ')}`);
      assert.deepEqual(names, ['many.eng.srt', 'many.jpn.srt', 'many.spa.srt']);
    } finally {
      rmSync(saved, { force: true });
    }
  });
});

/**
 * 화면을 따라다니는 실행 막대.
 *
 * 자막이 28개인 파일에서는 추출 단추가 목록 맨 끝에 있어, 작은 폰에서 4화면을
 * 내려가야 닿았다. 누른 뒤에도 진행 막대가 페이지 맨 위에 있어 아무 일도
 * 일어나지 않는 것처럼 보였다.
 */
test('추출 단추가 화면을 따라다니고, 진행과 결과도 눈앞에서 보인다', { timeout: 300000 }, async (t) => {
  if (!(await loadPlaywright())) return t.skip(skipReason);

  await withPage(async (page, pageErrors) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.setInputFiles('#file', fixture('many.mkv'));
    await page.waitForFunction(
      () => document.querySelectorAll('#tracks .track').length === 8,
      { timeout: 30000 },
    );

    const seen = (selector) => page.evaluate((selector) => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }, selector);

    // 맨 위에 있어도 단추가 보여야 한다. (목록이 한 화면보다 길다는 전제)
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 1.5),
      '이 시험은 목록이 한 화면보다 길어야 뜻이 있습니다',
    );
    assert.ok(await seen('#extract'), '맨 위에서 추출 단추가 화면 밖입니다');

    // 목록 한가운데에서도 보여야 한다.
    await page.evaluate(() => window.scrollTo(0, 600));
    assert.ok(await seen('#extract'), '목록 가운데에서 추출 단추가 화면 밖입니다');

    // 맨 아래까지 내리면 막대가 제자리로 돌아가 마지막 트랙을 가리지 않는다.
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.click('#tracks .track:last-child input');
    assert.equal(
      await page.evaluate(() => document.querySelectorAll('#tracks input:checked').length),
      1,
      '막대가 마지막 트랙을 가려 누를 수 없습니다',
    );

    // 돌아가는 동안 단추에 진행이 적힌다. 누르기 전에 지켜볼 준비를 해 둔다.
    await page.click('#selectAll');
    await page.evaluate(() => {
      window.__labels = [];
      const button = document.getElementById('extract');
      new MutationObserver(() => window.__labels.push(button.textContent))
        .observe(button, { childList: true, characterData: true, subtree: true });
    });
    await page.click('#extract');
    await page.waitForFunction(
      () => document.querySelectorAll('#results .result').length === 8,
      { timeout: 300000 },
    );
    assert.deepEqual(pageErrors, [], '브라우저에서 오류가 났습니다');

    const labels = await page.evaluate(() => window.__labels);
    assert.ok(
      labels.some((text) => text.startsWith('추출 중…')),
      `단추에 진행이 적히지 않았습니다: ${labels.join(' / ')}`,
    );
    assert.equal(await page.textContent('#extract'), '선택한 자막 추출', '끝나면 원래 이름으로 돌아와야 합니다');
    assert.ok(
      await page.evaluate(() => document.getElementById('extractBar').hidden),
      '끝났는데 진행선이 남아 있습니다',
    );

    // 다 되면 결과로 데려다 주고, 받기 단추도 눈앞에 있다.
    await page.waitForFunction(() => {
      const box = document.getElementById('downloadZip').getBoundingClientRect();
      return box.top >= 0 && box.bottom <= window.innerHeight;
    }, { timeout: 10000 });
  });
});
