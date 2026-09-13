// MP4 자막 트랙을 파이썬판과 대조한다.
//
// MP4 는 MKV 와 달리 자막 조각이 파일 여기저기 흩어져 있고 그 위치가 moov 의
// 표에 들어 있다. 표를 잘못 엮으면 시각이나 순서가 어긋나므로, 파이썬판이 낸
// SRT 와 글자·시각을 그대로 맞춰 본다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { listTracks, readTrackCues } from '../src/extract.js';
import { sniff } from '../src/container.js';
import { tidy } from '../src/postprocess.js';
import { parse, render } from '../src/srt.js';

const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function fileFrom(name) {
  return new File([readFileSync(fixture(name))], name);
}

test('파일 종류를 앞머리만 보고 가려낸다', async () => {
  assert.equal(await sniff(fileFrom('sample.mp4')), 'mp4');
  assert.equal(await sniff(fileFrom('sample.mkv')), 'mkv');
  assert.equal(await sniff(fileFrom('sample.sup')), 'sup');
  assert.equal(await sniff(new File([new Uint8Array(32)], 'empty.bin')), 'unknown');
});

test('MP4 의 자막 트랙 두 개를 언어까지 찾아낸다', async () => {
  const { container, tracks } = await listTracks(fileFrom('sample.mp4'));
  assert.equal(container, 'mp4');
  assert.deepEqual(
    tracks.map((t) => [t.subtitleIndex, t.language, t.mimeType]),
    [
      [0, 'kor', 'application/x-quicktime-tx3g'],
      [1, 'eng', 'application/x-quicktime-tx3g'],
    ],
  );
});

test('MP4 자막이 파이썬판과 같은 SRT 가 된다', async () => {
  const file = fileFrom('sample.mp4');
  const { container, context, tracks } = await listTracks(file);

  for (const track of tracks) {
    const cues = await readTrackCues(file, track, container, context);
    const actual = render(tidy(cues.map(({ startMs, endMs, text }) => ({ startMs, endMs, text }))));
    const expected = readFileSync(fixture(`expected.mp4.${track.language}.srt`), 'utf8');
    assert.equal(actual, expected, `${track.language} 트랙이 파이썬판과 다릅니다`);
  }
});

test('MP4 자막의 시각이 파이썬판과 밀리초까지 같다', async () => {
  const file = fileFrom('sample.mp4');
  const { container, context, tracks } = await listTracks(file);
  const cues = await readTrackCues(file, tracks[0], container, context);
  const expected = parse(readFileSync(fixture('expected.mp4.kor.srt'), 'utf8'));

  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
  });
});

test('자막이 없는 영상은 빈 목록을 돌려준다', async () => {
  const { container, tracks } = await listTracks(fileFrom('nosubs.mp4'));
  assert.equal(container, 'mp4');
  assert.deepEqual(tracks, []);
});

test('읽을 수 없는 형식은 이유를 알려 준다', async () => {
  const junk = new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])], 'junk.bin');
  await assert.rejects(() => listTracks(junk), /읽을 수 있는 형식이 아닙니다/);
});
