// 그림 자막 해독기가 파이썬판과 픽셀 단위로 같은 결과를 내는지 대조한다.
//
// 기준 자료는 `python3 tests/make_web_fixtures.py` 가 만든다. 파이썬판이 해독한
// 그림을 RGBA 원본 그대로 떠 놓은 것이라, 한 픽셀이라도 어긋나면 잡힌다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { decodeSupFile } from '../src/pgs.js';
import { listTracks, readTrackCues } from '../src/extract.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const golden = JSON.parse(readFileSync(fixture('bitmaps.json'), 'utf8'));

function fileFrom(name) {
  const bytes = readFileSync(fixture(name));
  return new File([bytes], name);
}

/**
 * 색 변환의 반올림 규칙이 파이썬(짝수 반올림)과 자바스크립트(올림)에서 한 단계
 * 다를 수 있다. 모양(투명도)은 정확히 같아야 하고 색은 1 까지만 봐준다.
 */
function assertSameImage(actual, expectedRecord, label) {
  assert.ok(actual, `${label}: 그림이 없습니다`);
  assert.equal(actual.width, expectedRecord.width, `${label}: 가로 크기`);
  assert.equal(actual.height, expectedRecord.height, `${label}: 세로 크기`);

  const expected = readFileSync(fixture(expectedRecord.rgba));
  assert.equal(actual.data.length, expected.length, `${label}: 픽셀 수`);

  let alphaMismatch = 0;
  let colorOffBy = 0;
  for (let i = 0; i < expected.length; i += 4) {
    if (actual.data[i + 3] !== expected[i + 3]) alphaMismatch += 1;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = Math.abs(actual.data[i + channel] - expected[i + channel]);
      if (difference > colorOffBy) colorOffBy = difference;
    }
  }
  assert.equal(alphaMismatch, 0, `${label}: 투명도가 다른 픽셀 ${alphaMismatch}개`);
  assert.ok(colorOffBy <= 1, `${label}: 색이 ${colorOffBy} 만큼 다릅니다`);
}

test('PGS: .sup 파일 해독이 파이썬판과 같다', () => {
  const bytes = new Uint8Array(readFileSync(fixture('sample.sup')));
  const cues = decodeSupFile(bytes);
  const expected = golden.pgsFromSup;

  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
    assertSameImage(cue.image, expected[index], `sup ${index}번`);
  });
});

test('PGS: 영상(MKV) 안의 자막 해독이 파이썬판과 같다', async () => {
  const file = fileFrom('sample.mkv');
  const { tracks, container, context } = await listTracks(file);
  const track = tracks.find((t) => t.mimeType === 'application/pgs');
  assert.ok(track, 'PGS 트랙을 찾지 못했습니다');

  const cues = await readTrackCues(file, track, container, context);
  const expected = golden.pgsFromMkv;

  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
    assertSameImage(cue.image, expected[index], `mkv pgs ${index}번`);
  });
});

test('VobSub: 영상(MKV) 안의 자막 해독이 파이썬판과 같다', async () => {
  const file = fileFrom('sample.mkv');
  const { tracks, container, context } = await listTracks(file);
  const track = tracks.find((t) => t.mimeType === 'application/vobsub');
  assert.ok(track, 'VobSub 트랙을 찾지 못했습니다');

  const cues = await readTrackCues(file, track, container, context);
  const expected = golden.vobsubFromMkv;

  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
    assertSameImage(cue.image, expected[index], `mkv vobsub ${index}번`);
  });
});

test('글자 자막은 그대로 읽힌다', async () => {
  const file = fileFrom('sample.mkv');
  const { tracks, container, context } = await listTracks(file);
  const track = tracks.find((t) => t.mimeType === 'application/x-subrip');
  assert.ok(track, 'SubRip 트랙을 찾지 못했습니다');

  const cues = await readTrackCues(file, track, container, context);
  assert.deepEqual(
    cues.map((cue) => cue.text),
    golden.texts,
  );
});

test('자막 트랙 목록이 세 개 모두 잡힌다', async () => {
  const { tracks } = await listTracks(fileFrom('sample.mkv'));
  assert.deepEqual(
    tracks.map((t) => t.mimeType),
    ['application/x-subrip', 'application/pgs', 'application/vobsub'],
  );
  assert.deepEqual(tracks.map((t) => t.language), ['eng', 'kor', 'kor']);
});
