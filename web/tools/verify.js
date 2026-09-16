// 실제 영상으로 웹판을 검증한다.
//
//   node tools/verify.js 영상파일 [옵션]
//   node tools/verify.js 자막.idx 자막.sub [옵션]     DVD 자막은 두 파일이 짝이다
//
//     --lang auto       인식 언어: auto | kor | kor+eng | eng (기본 auto)
//     --scale 2         확대 배율 (기본 2)
//     --dump 5          해독한 그림과 인식에 넣은 그림을 앞에서 N장 저장
//     --out 폴더        결과를 저장할 폴더 (기본 verify-out)
//     --no-python       파이썬판 대조를 건너뛴다
//
// 파이썬판(ffmpeg + tesseract)이 이 컴퓨터에 있으면 같은 영상을 양쪽으로 돌려
// 자동으로 비교한다. 없으면 웹판 결과만 저장하고 넘어간다.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStaticServer } from './serve.js';

const CHROMIUM_CANDIDATES = [
  '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
];

function parseArgs(argv) {
  const options = { lang: 'auto', scale: 2, dump: 0, out: 'verify-out', python: true };
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--lang') options.lang = argv[++i];
    else if (arg === '--scale') options.scale = Number(argv[++i]);
    else if (arg === '--dump') options.dump = Number(argv[++i]);
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--no-python') options.python = false;
    else rest.push(arg);
  }
  // DVD 자막(.idx/.sub)은 두 파일을 함께 받는다. 그 밖에는 하나면 된다.
  options.inputs = rest;
  options.video = rest.find((name) => !name.toLowerCase().endsWith('.idx')) ?? rest[0];
  // 파이썬판은 .idx 를 받아야 표를 읽는다.
  options.pythonInput = rest.find((name) => name.toLowerCase().endsWith('.idx')) ?? options.video;
  return options;
}

const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)}초`;

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

/**
 * 파이썬판을 같은 영상에 돌려 SRT 를 받아 온다. 없으면 null.
 *
 * 인식 언어는 웹판이 실제로 쓴 것과 맞춘다. 안 맞추면 양쪽이 다른 언어로 읽은
 * 결과를 견주게 되어, 해독이 멀쩡한데도 글자가 다르다고 나온다.
 */
function runPython(video, outDir, ocrLang) {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const probe = spawnSync('python3', ['-c', 'import subex'], { cwd: root });
  if (probe.status !== 0) return null;

  const temp = join(outDir, 'python');
  rmSync(temp, { recursive: true, force: true });
  mkdirSync(temp, { recursive: true });

  // 파이썬판은 저장소 뿌리에서 돌리므로 경로를 절대 경로로 바꿔 넘긴다.
  const result = spawnSync(
    'python3',
    [
      '-m', 'subex', resolve(video),
      '--outdir', resolve(temp),
      ...(ocrLang ? ['--ocr-lang', ocrLang] : []),
      '--overwrite', '-q',
    ],
    { cwd: root, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.log(`  (파이썬판 실행 실패 — 건너뜁니다)\n  ${(result.stderr || '').trim().split('\n').slice(-3).join('\n  ')}`);
    return null;
  }
  return Object.fromEntries(
    readdirSync(temp)
      .filter((name) => name.endsWith('.srt'))
      .map((name) => [name, readFileSync(join(temp, name), 'utf8')]),
  );
}

const TIMECODES = /(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g;
const timecodesOf = (text) => [...text.matchAll(TIMECODES)].map((match) => match[0]);

function compare(name, webSrt, pythonSrt) {
  const webTimes = timecodesOf(webSrt);
  const pythonTimes = timecodesOf(pythonSrt);
  const sameTimes =
    webTimes.length === pythonTimes.length && webTimes.every((value, i) => value === pythonTimes[i]);

  const distance = levenshtein(pythonSrt, webSrt);
  const accuracy = pythonSrt.length ? (1 - distance / pythonSrt.length) * 100 : 100;

  console.log(`  ${name}`);
  console.log(`    자막 수      : 웹 ${webTimes.length} / 파이썬 ${pythonTimes.length}`);
  console.log(`    시각         : ${sameTimes ? '완전히 같음' : '다름 ← 자막을 꺼내는 쪽을 봐야 합니다'}`);
  console.log(`    글자 일치율  : ${accuracy.toFixed(2)}%`);

  if (accuracy < 100) {
    const webCues = webSrt.split('\n\n');
    const pythonCues = pythonSrt.split('\n\n');
    let shown = 0;
    for (let i = 0; i < Math.max(webCues.length, pythonCues.length) && shown < 5; i += 1) {
      if (webCues[i] === pythonCues[i]) continue;
      console.log(`    ── 다른 곳 ${shown + 1}`);
      console.log(`       파이썬: ${(pythonCues[i] ?? '(없음)').replace(/\n/g, ' / ')}`);
      console.log(`       웹    : ${(webCues[i] ?? '(없음)').replace(/\n/g, ' / ')}`);
      shown += 1;
    }
  }
  return { sameTimes, accuracy };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const missing = options.inputs.filter((name) => !existsSync(name));
  if (!options.inputs.length || missing.length) {
    console.error(
      missing.length ? `찾을 수 없는 파일: ${missing.join(', ')}` : '영상 파일을 지정하세요.',
    );
    console.error('  node tools/verify.js 영상파일 [--lang kor+eng] [--scale 2] [--dump 5]');
    console.error('  node tools/verify.js 자막.idx 자막.sub          (DVD 자막은 두 파일이 짝)');
    process.exit(1);
  }

  const outDir = options.out;
  mkdirSync(outDir, { recursive: true });

  const { chromium } = await import('playwright');
  const server = createStaticServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const executablePath = CHROMIUM_CANDIDATES.find(existsSync);
  const browser = await chromium.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox'],
  });

  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.goto(`http://127.0.0.1:${port}/tools/verify.html`);
    await page.waitForFunction(() => document.getElementById('out').textContent === 'ready');
    await page.setInputFiles('#file', options.inputs);

    console.log(`\n== ${basename(options.video)} ==`);
    const report = await page.evaluate(
      (settings) => window.runVerify(settings),
      { language: options.lang, scale: options.scale, dumpCount: options.dump },
    );

    console.log(`파일          : ${megabytes(report.fileSize)} (${report.container.toUpperCase()})`);
    console.log(`트랙 찾기     : ${report.probeMs.toFixed(0)} ms`);
    console.log(`자막 트랙     : ${report.tracks.length}개`);
    if (report.languageDecision) {
      const d = report.languageDecision;
      const detail = d.latinWords
        ? `표본 ${d.sampleSize}장에서 영문 낱말 ${d.latinWords}/${d.totalWords}개 ` +
          `(${(d.latinShare * 100).toFixed(1)}%), 확신도 ${d.latinConfidence.toFixed(1)}`
        : `표본 ${d.sampleSize}장에서 영문이 보이지 않음`;
      console.log(`인식 언어     : ${report.language} (자동 선택 — ${detail})`);
    }
    for (const track of report.tracks) {
      const mark = track.supported ? (track.bitmap ? '그림 → 문자인식' : '글자') : '지원 안 함';
      console.log(`  - ${track.description}  (${mark})`);
    }

    if (!report.results.length) {
      console.log('\n뽑아낼 수 있는 자막이 없습니다.');
    }

    for (const result of report.results) {
      writeFileSync(join(outDir, result.name), result.srt, 'utf8');
      console.log(
        `\n${result.name}: ${result.cueCount}줄  ` +
          `(꺼내기 ${seconds(result.readMs)}${result.ocrMs ? `, 문자인식 ${seconds(result.ocrMs)}` : ''})`,
      );
    }
    console.log(`\n전체 ${seconds(report.totalMs)}, 결과는 ${outDir}/ 에 저장했습니다.`);

    for (const dump of report.dumps) {
      for (const kind of ['raw', 'prepared']) {
        const name = `dump.track${dump.track}.${String(dump.index).padStart(3, '0')}.${kind}.png`;
        writeFileSync(join(outDir, name), Buffer.from(dump[kind].split(',')[1], 'base64'));
      }
    }
    if (report.dumps.length) {
      console.log(`그림 ${report.dumps.length * 2}장을 저장했습니다 (raw = 해독 결과, prepared = 인식에 넣은 것).`);
    }

    if (pageErrors.length) {
      console.log(`\n[!] 브라우저 오류:\n  ${pageErrors.join('\n  ')}`);
    }

    if (options.python) {
      // 웹판이 자동으로 고른 언어가 있으면 그것을, 없으면 지정한 것을 쓴다.
      const ocrLang = report.language ?? (options.lang === 'auto' ? null : options.lang);
      console.log(`\n-- 파이썬판과 대조 -- ${ocrLang ? `(양쪽 다 인식 언어 ${ocrLang})` : ''}`);
      const pythonSrt = runPython(options.pythonInput, outDir, ocrLang);
      if (!pythonSrt) {
        console.log('  파이썬판을 쓸 수 없어 건너뜁니다 (ffmpeg·tesseract 가 필요합니다).');
      } else {
        for (const result of report.results) {
          const match = pythonSrt[result.name];
          if (!match) {
            console.log(`  ${result.name}: 파이썬판에 같은 이름의 결과가 없습니다 (${Object.keys(pythonSrt).join(', ')})`);
            continue;
          }
          compare(result.name, result.srt, match);
        }
      }
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
