// 자막 여러 개를 zip 하나로 묶는 부분.
//
// 우리가 만든 zip 이 진짜 규격에 맞는지는 **파이썬의 zipfile 로 풀어 보고** 확인한다.
// 우리 코드끼리만 맞춰 보면 둘 다 똑같이 틀려도 통과해 버린다 — 자막 픽스처를
// ffmpeg 으로 교차 확인하는 것과 같은 이유다.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { crc32, dosTimestamp, makeZip } from '../src/zip.js';

test('CRC-32 가 규격 값과 같다', () => {
  // zip 이 쓰는 CRC-32 의 널리 알려진 검사값이다.
  const bytes = new TextEncoder().encode('123456789');
  assert.equal(crc32(bytes), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
});

test('1980년 이전 날짜도 담을 수 있는 값으로 바꾼다', () => {
  // zip 의 날짜 칸은 1980년부터다. 그보다 이르면 담을 수 없어 1980으로 올린다.
  const old = dosTimestamp(new Date('1970-01-01T00:00:00'));
  assert.equal(old.date >>> 9, 0, '연도 칸이 1980 기준으로 0 이어야 한다');
  const now = dosTimestamp(new Date('2026-09-19T12:34:56'));
  assert.equal(now.date >>> 9, 2026 - 1980);
  assert.equal((now.date >> 5) & 0x0f, 9);
  assert.equal(now.date & 0x1f, 19);
});

test('파이썬 zipfile 이 우리 zip 을 그대로 읽는다', async () => {
  const entries = [
    { name: 'movie.kor.srt', text: '1\n00:00:01,000 --> 00:00:03,000\n한글 자막\n' },
    { name: 'movie.eng.srt', text: '1\n00:00:01,000 --> 00:00:03,000\nEnglish\n' },
    { name: '이름에 한글.srt', text: '이름이 한글이어도 된다\n' },
    { name: 'empty.srt', text: '' },
  ];

  const blob = makeZip(entries, new Date('2026-09-19T12:34:56'));
  const dir = mkdtempSync(join(tmpdir(), 'subex-zip-'));
  const path = join(dir, 'out.zip');
  writeFileSync(path, Buffer.from(await blob.arrayBuffer()));

  try {
    const script = `
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    assert z.testzip() is None, "CRC 가 맞지 않는다"
    print(json.dumps({i.filename: z.read(i.filename).decode("utf-8") for i in z.infolist()}))
`;
    const out = execFileSync('python3', ['-c', script, path], { encoding: 'utf8' });
    const got = JSON.parse(out);

    assert.deepEqual(Object.keys(got), entries.map((entry) => entry.name), '파일 이름과 차례');
    for (const entry of entries) {
      assert.equal(got[entry.name], entry.text, `${entry.name} 의 내용`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('이름 없는 항목은 조용히 넘어가지 않고 알려 준다', () => {
  // 이름 칸을 잘못 넘겨 본 적이 있다. 그때 만들어진 zip 은 푸는 쪽에서
  // 이름 없는 빈 항목만 나와, 자막이 통째로 사라진 것처럼 보였다.
  assert.throws(() => makeZip([{ text: '자막' }]), /이름/);
});
