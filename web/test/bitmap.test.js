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
import { looksLikeIdx, parseIdx } from '../src/vobsubFile.js';

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

test('VobSub: .idx/.sub 짝을 직접 넣은 것이 파이썬판과 같다', async () => {
  // DVD 자막을 따로 뽑아 두면 늘 이 두 파일이 같이 다닌다. 영상 없이 이 짝만
  // 넣어도 읽혀야 한다. 파이썬판은 ffprobe 로, 웹판은 프로그램 스트림을 직접
  // 훑어 읽으므로, 서로 완전히 다른 길로 같은 답에 닿는지를 보는 시험이다.
  const file = fileFrom('sample.sub');
  const indexText = readFileSync(fixture('sample.idx'), 'utf8');

  const { tracks, container, context } = await listTracks(file, { indexText });
  assert.equal(container, 'vobsub');
  assert.equal(tracks.length, 1, '자막 트랙 개수');
  assert.equal(tracks[0].language, 'ko', '언어');
  assert.equal(tracks[0].mimeType, 'application/vobsub');

  const cues = await readTrackCues(file, tracks[0], container, context);
  const expected = golden.vobsubFromIdx;

  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
    assertSameImage(cue.image, expected[index], `idx/sub ${index}번`);
  });
});

test('VobSub: .sub 만 주면 .idx 도 필요하다고 알려 준다', async () => {
  // 짝이 안 맞으면 말없이 실패하지 않고 무엇이 더 필요한지 말해 줘야 한다.
  await assert.rejects(() => listTracks(fileFrom('sample.sub')), (error) => {
    assert.match(error.message, /\.idx/, '어느 파일이 더 필요한지 알려 줘야 합니다');
    return true;
  });
});

test('VobSub: .idx 표를 언어별로 갈라 읽는다', () => {
  const text = [
    '# VobSub index file, v7',
    'size: 720x480',
    'palette: 000000, ffffff, 000000, 808080',
    '',
    'id: ko, index: 0',
    'timestamp: 00:00:01:000, filepos: 000000000',
    'timestamp: 00:01:02:340, filepos: 000000800',
    '',
    'id: en, index: 1',
    'timestamp: 01:02:03:456, filepos: 0000ff000',
    '',
    'id: ja, index: 2',   // 표가 비어 있는 언어는 트랙으로 내놓지 않는다
    '',
  ].join('\n');

  assert.ok(looksLikeIdx(text), '.idx 로 알아봐야 합니다');
  const index = parseIdx(text);

  assert.equal(index.width, 720);
  assert.equal(index.height, 480);
  assert.equal(index.streams.length, 2, '표가 있는 언어만 남아야 합니다');

  const [korean, english] = index.streams;
  assert.equal(korean.language, 'ko');
  assert.equal(korean.substreamId, 0x20, '자막 번호는 0x20 부터 매긴다');
  assert.deepEqual(
    korean.entries,
    [{ startMs: 1000, filePos: 0 }, { startMs: 62340, filePos: 0x800 }],
    '시각(시:분:초:밀리초)과 자리(16진수)',
  );

  assert.equal(english.language, 'en');
  assert.equal(english.substreamId, 0x21);
  assert.deepEqual(english.entries, [{ startMs: 3723456, filePos: 0xff000 }]);
});

test('PGS: 안티에일리어싱·여러 객체 자막도 파이썬판과 같다', (t) => {
  // 실제 블루레이 자막에 가까운 자료. 색이 수십 가지이고, 두 줄을 각각 다른
  // 객체로 얹은 경우가 들어 있다. 단순한 3색 자료로는 못 밟아 보는 경로다.
  const expected = golden.pgsRich;
  if (!expected?.length) return t.skip('한글 글꼴이 없어 만들지 못한 자료입니다');

  const cues = decodeSupFile(new Uint8Array(readFileSync(fixture('rich.sup'))));
  assert.equal(cues.length, expected.length, '자막 개수');
  cues.forEach((cue, index) => {
    assert.equal(cue.startMs, expected[index].startMs, `${index}번 시작 시각`);
    assert.equal(cue.endMs, expected[index].endMs, `${index}번 끝 시각`);
    assertSameImage(cue.image, expected[index], `rich ${index}번`);
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

test('인식 언어 고르기: 실측한 세 경우를 그대로 가른다', async () => {
  // 실제로 재어 본 값이다. 여기가 어긋나면 자동 선택이 뒤집힌 것이다.
  const { decideLanguage } = await import('../src/ocr.js');

  assert.equal(
    decideLanguage({ latinWords: 0, totalWords: 31, latinConfidence: 0 }).language,
    'kor',
    '한글 전용(합성): 영문이 아예 없다',
  );

  assert.equal(
    decideLanguage({ latinWords: 5, totalWords: 88, latinConfidence: 54.8 }).language,
    'kor',
    '한글 전용(실제 DVD 자막): 기울어진 노래 가사가 영문으로 잘못 읽히지만 몇 개뿐이다',
  );

  assert.equal(
    decideLanguage({ latinWords: 7, totalWords: 13, latinConfidence: 95.4 }).language,
    'kor+eng',
    '한·영 혼합: 낱말의 절반이 영문이고 확신도도 높다',
  );

  // 비율만 높고 확신도가 낮으면(한글을 통째로 영문으로 오독) 영어를 붙이지 않는다.
  assert.equal(
    decideLanguage({ latinWords: 20, totalWords: 30, latinConfidence: 16.8 }).language,
    'kor',
    '확신도가 낮으면 비율이 높아도 진짜 영문이 아니다',
  );
});

/** 시험용 MPEG 프로그램 스트림 조각을 만든다: 팩 머리 + private_stream_1 패킷. */
function programStreamPacket(substreamId, payload) {
  const pack = [0x00, 0x00, 0x01, 0xba, 0x44, 0x00, 0x04, 0x00, 0x04, 0x01, 0x00, 0x00, 0x03, 0xf8];
  const packetLength = 3 + payload.length + 1; // 플래그 2 + 머리길이 1 + 자막번호 1 + 알맹이
  const pes = [
    0x00, 0x00, 0x01, 0xbd,
    (packetLength >> 8) & 0xff, packetLength & 0xff,
    0x81, 0x00, 0x00,          // 플래그 2바이트 + 머리 길이 0
    substreamId,
    ...payload,
  ];
  return [...pack, ...pes];
}

test('VobSub: 언어가 여러 개면 그 언어의 자막만 골라 이어 붙인다', async () => {
  // .sub 안에서는 여러 언어의 자막이 섞여 있다. 자막 번호(0x20, 0x21 …)로
  // 갈라 읽지 않으면 남의 언어 조각이 딸려 들어온다.
  const { readVobsubSamples } = await import('../src/vobsubFile.js');

  // 우리가 찾는 자막(0x21)은 두 조각에 나뉘어 있고, 그 사이에 다른 언어(0x20)가 끼어 있다.
  const bytes = new Uint8Array([
    ...programStreamPacket(0x21, [0x00, 0x08, 0xaa, 0xbb]),   // 길이 8 이라 적고 4바이트
    ...programStreamPacket(0x20, [0xff, 0xff, 0xff, 0xff]),   // 남의 언어 — 건너뛰어야 한다
    ...programStreamPacket(0x21, [0xcc, 0xdd, 0xee, 0xff]),   // 나머지 4바이트
  ]);

  const file = new File([bytes], 'two.sub');
  const stream = { substreamId: 0x21, entries: [{ startMs: 1000, filePos: 0 }] };
  const { samples } = await readVobsubSamples(file, stream);

  assert.equal(samples.length, 1, '자막 덩어리 개수');
  assert.equal(samples[0].startMs, 1000);
  assert.deepEqual(
    [...samples[0].data],
    [0x00, 0x08, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff],
    '앞 2바이트에 적힌 길이(8)만큼, 남의 언어는 빼고 이어 붙여야 합니다',
  );
});

/** 기울어진 글자 그림을 만든다. 아래를 기준으로 위를 오른쪽으로 민 세로획들. */
function slantedStrokes(slant) {
  const width = 120;
  const height = 40;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (const base of [20, 50, 80]) {
      const x = Math.round(base + slant * (height - 1 - y));
      for (const dx of [0, 1, 2]) {
        const at = ((y * width) + x + dx) * 4;
        data[at] = data[at + 1] = data[at + 2] = 255;   // 흰 글자
        data[at + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

test('기울기 재기: 똑바른 글자는 0, 기울어진 글자는 그만큼', async () => {
  const { estimateSlant } = await import('../src/bitmapPrep.js');

  // prepareForOcr 안에서 재는 것과 같은 모양(흰 바탕에 검은 글자)으로 만든다.
  const grayOf = (image) => {
    const gray = new Uint8ClampedArray(image.width * image.height);
    for (let i = 0; i < gray.length; i += 1) gray[i] = 255 - image.data[i * 4 + 3];
    return gray;
  };

  for (const slant of [0, 0.15, 0.3]) {
    const image = slantedStrokes(slant);
    const found = estimateSlant(grayOf(image), image.width, image.height);
    assert.ok(
      Math.abs(found - slant) <= 0.05,
      `기울기 ${slant} 인 글자를 ${found} 로 쟀습니다`,
    );
  }
});

test('기울기 되돌리기: 되돌린 뒤에는 기울기가 0으로 잡힌다', async () => {
  const { estimateSlant, deslant } = await import('../src/bitmapPrep.js');
  const image = slantedStrokes(0.3);
  const gray = new Uint8ClampedArray(image.width * image.height);
  for (let i = 0; i < gray.length; i += 1) gray[i] = 255 - image.data[i * 4 + 3];

  const straightened = deslant({ data: gray, width: image.width, height: image.height }, 0.3);
  assert.ok(straightened.width > image.width, '잘리지 않게 폭이 넓어져야 합니다');

  const left = estimateSlant(straightened.data, straightened.width, straightened.height);
  assert.ok(left <= 0.05, `되돌린 뒤에도 기울기가 ${left} 남아 있습니다`);
});

test('기울기 되돌리기: 똑바른 그림은 손대지 않는다', async () => {
  const { deslant } = await import('../src/bitmapPrep.js');
  const image = { data: new Uint8ClampedArray(9).fill(128), width: 3, height: 3 };
  assert.equal(deslant(image, 0), image, '기울기가 0이면 그대로 돌려줘야 합니다');
});

/**
 * 글자처럼 생긴 그림을 만든다 — 줄마다 세로획 몇 개, 줄 사이는 빈칸.
 *
 * 꽉 채우면 안 된다. 잉크가 너무 많으면 '어두운 글자 + 밝은 박스' 로 보여
 * 전처리가 색을 한 번 더 뒤집는다(실제 자막에 있는 경우다).
 */
function textLike(lineHeight, gap, count) {
  const width = 60;
  const height = count * lineHeight + (count - 1) * gap;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let line = 0; line < count; line += 1) {
    const top = line * (lineHeight + gap);
    for (let row = 0; row < lineHeight; row += 1) {
      for (const base of [8, 24, 40]) {
        for (const dx of [0, 1, 2]) {
          const at = ((top + row) * width + base + dx) * 4;
          data[at] = data[at + 1] = data[at + 2] = 255;
          data[at + 3] = 255;
        }
      }
    }
  }
  return { width, height, data };
}

test('줄 높이 재기: 글자 띠의 높이를 찾아낸다', async () => {
  const { textLineHeight } = await import('../src/bitmapPrep.js');
  const grayOf = (image) => {
    const gray = new Uint8ClampedArray(image.width * image.height);
    for (let i = 0; i < gray.length; i += 1) gray[i] = 255 - image.data[i * 4 + 3];
    return gray;
  };

  for (const [lineHeight, count] of [[20, 1], [20, 2], [48, 2], [12, 3]]) {
    const image = textLike(lineHeight, 10, count);
    const found = textLineHeight(grayOf(image), image.width, image.height);
    assert.equal(found, lineHeight, `${count}줄짜리 ${lineHeight}px 를 ${found} 로 쟀습니다`);
  }
});

test('글자 크기 맞춤: 큰 글자만 줄이고 작은 글자는 그대로 둔다', async () => {
  const { prepareForOcr, TARGET_LINE_HEIGHT } = await import('../src/bitmapPrep.js');
  const MARGIN = 16;

  // 확실히 큰 글자(한 줄 80px)는 줄어들어야 한다.
  const big = textLike(80, 20, 2);
  const shrunk = prepareForOcr(big, { straighten: false });
  assert.ok(
    shrunk.height - MARGIN * 2 < big.height,
    `큰 글자가 줄지 않았습니다 (${big.height} → ${shrunk.height - MARGIN * 2})`,
  );

  // 작은 글자(한 줄 20px)는 건드리지 않는다 — 키우면 오히려 나빠진다.
  const small = textLike(20, 10, 2);
  const kept = prepareForOcr(small, { straighten: false });
  assert.equal(kept.height - MARGIN * 2, small.height, '작은 글자는 그대로여야 합니다');
  assert.equal(kept.width - MARGIN * 2, small.width, '작은 글자는 그대로여야 합니다');

  // 끄면 아무것도 하지 않는다.
  const off = prepareForOcr(big, { targetLineHeight: 0, straighten: false });
  assert.equal(off.height - MARGIN * 2, big.height, '꺼 두면 원본 크기 그대로여야 합니다');
  assert.ok(TARGET_LINE_HEIGHT > 0);
});

/** 기준자료로 떠 놓은 RGBA 그림을 읽는다. */
function rgbaFixture(record) {
  const bytes = readFileSync(fixture(record.rgba));
  return { width: record.width, height: record.height, data: new Uint8ClampedArray(bytes) };
}

/** 앞쪽 글자를 다른 것으로 바꾼 그림. 음표 자리에 네모를 두는 식으로 쓴다. */
function replaceLeading(image, drawn) {
  const data = new Uint8ClampedArray(image.data);
  // 앞의 40픽셀을 지우고
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < 40; x += 1) data[(y * image.width + x) * 4 + 3] = 0;
  }
  // 그 자리에 주어진 모양을 그린다
  drawn(data, image.width, image.height);
  return { width: image.width, height: image.height, data };
}

test('줄 가르기: 글자 줄마다 하나씩 나눈다', async () => {
  const { prepareLines } = await import('../src/bitmapPrep.js');
  for (const count of [1, 2, 3]) {
    const lines = prepareLines(textLike(30, 14, count), { straighten: false });
    assert.equal(lines.length, count, `${count}줄짜리를 ${lines.length}개로 나눴습니다`);
    for (const line of lines) assert.equal(line.prefix, '', '음표가 없는데 붙었습니다');
  }
});

test('음표 찾기: 진짜 ♪ 는 찾아 떼어 내고, 글자는 건드리지 않는다', async (t) => {
  // 손으로 그린 흉내가 아니라 글꼴이 그린 진짜 ♪ 로 시험한다.
  // (기준자료는 `python3 tests/make_web_fixtures.py` 가 만든다)
  if (!golden.noteLine) return t.skip('♪ 를 가진 글꼴이 없어 만들지 못한 자료입니다');
  const { prepareLines } = await import('../src/bitmapPrep.js');

  const line = rgbaFixture(golden.noteLine);
  const found = prepareLines(line, { straighten: false });
  assert.equal(found.length, 1, '한 줄이어야 합니다');
  assert.equal(found[0].prefix, '♪', '음표를 못 찾았습니다');

  // 음표 자리에 네모를 두면 음표로 보면 안 된다.
  const block = replaceLeading(line, (data, width, height) => {
    for (let y = 8; y < height - 8; y += 1) {
      for (let x = 10; x < 34; x += 1) {
        const at = (y * width + x) * 4;
        data[at] = data[at + 1] = data[at + 2] = 255;
        data[at + 3] = 255;
      }
    }
  });
  assert.equal(
    prepareLines(block, { straighten: false })[0].prefix,
    '',
    '글자를 음표로 잘못 봤습니다',
  );

  // 꺼 두면 찾지 않는다.
  assert.equal(prepareLines(line, { straighten: false, findNotes: false })[0].prefix, '');
});
