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

test('대화 표시(-) 띄어쓰기 규칙이 파이썬판과 같다 — 자막의 관습을 따른다', async () => {
  const { tidy } = await import('../src/postprocess.js');

  const run = (texts) =>
    tidy(texts.map((text, i) => ({ startMs: i * 1000, endMs: (i + 1) * 1000 - 1, text })))
      .map((cue) => cue.text);

  // 대부분 띄어쓰는 자막 → 붙은 것도 띄운다.
  const spaced = ['- 그래요', '- 가자', '- 응', '- 네', '-음', '- 좋아', '- 알았어', '- 그럼'];
  assert.equal(run(spaced)[4], '- 음');

  // 모두 붙여 쓰는 자막 → 그대로 둔다 (실측: 어떤 자막은 49줄 모두 붙여 쓴다).
  const tight = ['-안 돼요', '-로지타!', '-네', '-그래'];
  assert.deepEqual(run(tight), tight);

  // 음수는 어느 쪽이든 건드리지 않는다.
  assert.equal(run(['- 그래요', '- 가자', '- 응', '-5도 아래'])[3], '-5도 아래');

  // 대시가 아예 없으면 아무 일도 없다.
  assert.deepEqual(run(['그래요', '가자']), ['그래요', '가자']);
});
