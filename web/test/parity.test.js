// 파이썬판과 결과가 같은지 대조한다.
//
// 기준 파일 fixtures/parity.txt 는 실제 영상으로 검증을 끝낸 파이썬 구현이
// 만든 정답지다(`python3 tests/make_parity_golden.py` 로 다시 만들 수 있다).
// 두 구현이 갈라지면 이 테스트가 먼저 알려 준다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { parse, render } from '../src/srt.js';
import { tidy } from '../src/postprocess.js';

const MARKER = '========';

function loadCases() {
  const raw = readFileSync(fileURLToPath(new URL('./fixtures/parity.txt', import.meta.url)), 'utf8');
  const cases = [];
  let current = null;
  let section = '';

  for (const line of raw.split('\n')) {
    if (line.startsWith(`${MARKER} case `)) {
      current = { name: line.slice(`${MARKER} case `.length), note: '', input: '', expected: '' };
      section = '';
    } else if (line.startsWith(`${MARKER} note `)) {
      current.note = line.slice(`${MARKER} note `.length);
    } else if (line === `${MARKER} input`) {
      section = 'input';
    } else if (line === `${MARKER} expected`) {
      section = 'expected';
    } else if (line === `${MARKER} end`) {
      cases.push(current);
      section = '';
    } else if (section) {
      current[section] += `${line}\n`;
    }
  }
  return cases;
}

test('대조할 경우가 충분히 있다', () => {
  assert.ok(loadCases().length >= 10);
});

test('파이썬판과 결과가 같다', () => {
  for (const testCase of loadCases()) {
    const actual = render(tidy(parse(testCase.input)));
    assert.equal(actual, testCase.expected, `[${testCase.name}] ${testCase.note}`);
  }
});

test('대화 표시(-) 뒤 띄어쓰기를 되살리는 규칙이 파이썬판과 같다', async () => {
  const { cleanText } = await import('../src/postprocess.js');

  // 인식기가 가끔 흘린다(실측: '-' 로 시작하는 185줄 중 15줄).
  // 그림에는 띄어쓰기가 있으니 되살리는 것이 맞다. 음수는 건드리지 않는다.
  const cases = [
    ['-응', '- 응'],
    ['-네\n- 그래', '- 네\n- 그래'],
    ['—네', '— 네'],
    ['- 응', '- 응'],
    ['-5도 아래', '-5도 아래'],
    ['-', '-'],
    ['그-응', '그-응'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(cleanText(source), expected, `${JSON.stringify(source)} 처리 결과`);
  }
});
