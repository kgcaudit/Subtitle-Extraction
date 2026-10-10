// 언어 이름과 자막 종류 표시.
//
// 화면에 'ko', 'en' 같은 코드만 있으면 무엇을 뽑는지 알 수가 없다. 특히 영어
// 자막이 다섯 개씩 들어 있는 파일에서는 코드만으로 고를 수가 없다.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { defaultIsMeaningful, languageName, trackBadges, trackHeadline } from '../src/label.js';

test('언어 코드를 우리말 이름으로 바꾼다 — 코드 모양이 제각각이어도', () => {
  // 두 글자(BCP 47)와 세 글자(ISO 639-2) 둘 다 쓰인다. 마트로스카는 한 파일에
  // 둘 다 담기도 한다.
  assert.equal(languageName('ko'), '한국어');
  assert.equal(languageName('kor'), '한국어');
  assert.equal(languageName('en'), '영어');
  assert.equal(languageName('eng'), '영어');

  // 서지용 코드. 마트로스카의 옛 Language 요소가 실제로 이걸 쓴다
  // (mkvmerge 가 쓴 파일에서 ger·fre 를 확인했다).
  assert.equal(languageName('ger'), '독일어');
  assert.equal(languageName('fre'), '프랑스어');
  assert.equal(languageName('chi'), '중국어');

  // 지역·문자까지 붙은 태그.
  assert.equal(languageName('pt-BR'), '포르투갈어(브라질)');
  assert.equal(languageName('zh-Hans'), '중국어(간체)');

  // 대소문자는 가리지 않는다 — 언어 알약은 코드를 대문자로 들고 다닌다.
  assert.equal(languageName('KO'), '한국어');
  assert.equal(languageName('GER'), '독일어');
});

test('언어가 아닌 코드와 모르는 코드도 말이 되게 적는다', () => {
  // 'und' 는 언어가 아니라 '밝히지 않음' 이다.
  assert.equal(languageName('und'), '언어 미지정');
  assert.equal(languageName(''), '언어 미지정');
  assert.equal(languageName(null), '언어 미지정');
  assert.equal(languageName(undefined), '언어 미지정');
  assert.equal(languageName('mul'), '여러 언어');
  assert.equal(languageName('zxx'), '언어 없음');
  // 이름표가 모르는 서지용 코드 하나.
  assert.equal(languageName('tib'), '티베트어');
  // 그 밖에 모르는 것은 코드를 그대로 — 감추는 것보다 낫다.
  assert.equal(languageName('xyz'), 'xyz');
  assert.equal(languageName('!!'), '!!');
});

test('자막 종류를 파일에 적힌 대로만 표시한다', () => {
  assert.deepEqual(trackBadges({ forced: true }), ['강제']);
  assert.deepEqual(trackBadges({ hearingImpaired: true }), ['청각장애인용']);
  assert.deepEqual(trackBadges({ visualImpaired: true }), ['시각장애인용']);
  assert.deepEqual(trackBadges({ textDescriptions: true }), ['화면 해설']);
  assert.deepEqual(trackBadges({ commentary: true }), ['코멘터리']);
  assert.deepEqual(trackBadges({ original: true }), ['원어']);
  assert.deepEqual(trackBadges({ forced: true, hearingImpaired: true, default: true }),
                   ['강제', '청각장애인용', '기본']);
  assert.deepEqual(trackBadges({}), []);

  // 이름에 'SDH' 라고 적혀 있다고 짐작해서 붙이지는 않는다. 짐작이 틀리면
  // 엉뚱한 자막을 뽑게 된다 — 이름은 따로 그대로 보여 준다.
  assert.deepEqual(trackBadges({ name: 'English SDH (Forced)' }), []);
});

test("모든 트랙이 '기본' 이면 그 표시는 뺀다", () => {
  // 마트로스카는 FlagDefault 가 없으면 1 로 친다. mkvmerge 는 이 요소를 아예
  // 쓰지 않기도 해서, 그런 파일은 모든 트랙이 '기본' 이 된다. 전부에 붙는
  // 표시는 아무것도 가려 주지 못한다.
  const all = [{ default: true }, { default: true }];
  assert.equal(defaultIsMeaningful(all), false);
  assert.deepEqual(trackBadges(all[0], { showDefault: false }), []);

  const some = [{ default: true }, { default: false }];
  assert.equal(defaultIsMeaningful(some), true);
  assert.deepEqual(trackBadges(some[0], { showDefault: true }), ['기본']);
});

test('목록 머리글은 번호 · 언어 · 형식 차례다', () => {
  assert.equal(trackHeadline({ subtitleIndex: 3, language: 'kor' }, 'SubRip'), '#3 한국어 · SubRip');
  assert.equal(trackHeadline({ subtitleIndex: 0, language: null }, 'PGS'), '#0 언어 미지정 · PGS');
});
