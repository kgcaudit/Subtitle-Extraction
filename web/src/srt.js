// SRT 자막의 직렬화와 파싱.
//
// 파이썬판(subex/srt.py)과 같은 규칙을 따른다. 두 구현이 같은 영상에서 같은
// 결과를 내야 웹 결과를 파이썬판으로 대조할 수 있기 때문이다.

/** 밀리초를 `HH:MM:SS,mmm` 으로. 음수는 0 으로 눌러 준다. */
export function formatTimestamp(millis) {
  const value = Math.max(0, Math.round(millis));
  const pad = (n, width) => String(n).padStart(width, '0');
  return (
    `${pad(Math.floor(value / 3600000), 2)}:` +
    `${pad(Math.floor(value / 60000) % 60, 2)}:` +
    `${pad(Math.floor(value / 1000) % 60, 2)},` +
    `${pad(value % 1000, 3)}`
  );
}

export function render(cues) {
  return cues
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}\n${cue.text}\n`
    )
    .join('\n');
}

const TIMECODE = /(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})\s*-->\s*(\d+):([0-5]?\d):([0-5]?\d)[,.](\d{1,3})/g;

function toMillis(hours, minutes, seconds, fraction) {
  return (
    ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 +
    Number(fraction.padEnd(3, '0'))
  );
}

const isNumeric = (text) => text.length > 0 && /^\d+$/.test(text);

/**
 * SRT 문서를 읽는다.
 *
 * 번호 줄이 없거나 어긋나 있어도 타임코드 줄을 기준으로 자른다. 본문 마지막
 * 줄이 숫자로 끝나는 경우(`... English 2026`)를 다음 큐의 번호로 잘못 지우지
 * 않도록, '그 줄 전체가 숫자일 때'만 번호 줄로 보고 걷어낸다.
 */
export function parse(source) {
  const text = source.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  TIMECODE.lastIndex = 0;
  const matches = [...text.matchAll(TIMECODE)];
  const cues = [];

  matches.forEach((match, position) => {
    const bodyStart = text.indexOf('\n', match.index + match[0].length);
    if (bodyStart < 0) return;

    const hasNext = position + 1 < matches.length;
    // 다음 타임코드가 있는 '줄의 시작'까지가 이번 큐의 몫이다.
    const bodyEnd = hasNext ? text.lastIndexOf('\n', matches[position + 1].index) + 1 : text.length;
    if (bodyEnd <= bodyStart) return;

    const lines = text.slice(bodyStart + 1, bodyEnd).split('\n');
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    if (hasNext && lines.length && isNumeric(lines[lines.length - 1].trim())) lines.pop();
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

    const body = lines.join('\n').trim();
    if (body) {
      cues.push({
        startMs: toMillis(match[1], match[2], match[3], match[4]),
        endMs: toMillis(match[5], match[6], match[7], match[8]),
        text: body,
      });
    }
  });

  return cues;
}
