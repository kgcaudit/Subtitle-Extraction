// .idx/.sub 짝으로 된 VobSub 자막 파일을 읽는다.
//
// DVD 자막을 따로 뽑아 두면 늘 이 두 파일이 같이 다닌다.
//
//   .idx  텍스트다. 16색 팔레트와 "몇 시 몇 분에 나오는 자막이 .sub 의 몇 번째
//         바이트에 있는지" 표가 들어 있다. 언어가 여러 개면 표도 여러 벌이다.
//   .sub  MPEG 프로그램 스트림이다. 자막 한 덩어리(SPU)가 2048바이트 조각(팩)
//         여러 개에 나뉘어 담겨 있다.
//
// 그래서 표가 가리키는 자리부터 조각을 이어 붙여 SPU 하나를 되살린다. 표가
// 자리를 알려 주므로 파일 전체를 훑지 않고 필요한 곳만 읽는다.

import { SliceReader, u16 } from './reader.js';

/** 프로그램 스트림의 시작 부호 뒤에 오는 종류 표시. */
const PACK_HEADER = 0xba;
const PRIVATE_STREAM_1 = 0xbd;

/** 자막은 private_stream_1 안에 0x20 부터 번호를 붙여 얹힌다. */
const SUBSTREAM_BASE = 0x20;

/** 망가진 파일에서 끝없이 이어 붙이지 않도록 둔 한계. */
const MAX_SPU_BYTES = 1 << 20;

/** 앞머리만 보고 .sub(프로그램 스트림)인지 가린다. */
export function looksLikeProgramStream(head) {
  return head.length >= 4 && head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && head[3] === PACK_HEADER;
}

/** 내용을 보고 .idx 인지 가린다. 확장자는 믿지 않는다. */
export function looksLikeIdx(text) {
  return /^\s*#\s*VobSub index file/i.test(text) || /^timestamp:\s*\d/m.test(text);
}

/** `00:01:03:480` → 밀리초. */
function parseTimestamp(text) {
  const match = /^(\d+):(\d+):(\d+):(\d+)$/.exec(text.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match.map(Number);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

/**
 * .idx 텍스트를 읽는다.
 *
 * `id:` 한 줄이 언어 하나를 열고, 그 뒤의 `timestamp:` 줄들이 그 언어의 표다.
 * 그래서 위에서부터 차례로 읽으며 '지금 열려 있는 언어' 에 붙인다.
 *
 * @returns { width, height, streams }
 */
export function parseIdx(text) {
  const streams = [];
  let current = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const id = /^id:\s*([A-Za-z-]+)\s*(?:,\s*index:\s*(\d+))?/.exec(line);
    if (id) {
      const index = id[2] === undefined ? streams.length : Number(id[2]);
      current = {
        language: id[1],
        index,
        substreamId: SUBSTREAM_BASE + index,
        subtitleIndex: streams.length,
        entries: [],
      };
      streams.push(current);
      continue;
    }

    const entry = /^timestamp:\s*([\d:]+)\s*,\s*filepos:\s*([0-9a-fA-F]+)/.exec(line);
    if (entry && current) {
      const startMs = parseTimestamp(entry[1]);
      if (startMs !== null) current.entries.push({ startMs, filePos: parseInt(entry[2], 16) });
    }
  }

  // 팔레트는 이 텍스트에서 vobsub.js 의 parseIdxPalette 가 따로 읽는다.
  const size = /^size:\s*(\d+)x(\d+)/m.exec(text);
  return {
    width: size ? Number(size[1]) : null,
    height: size ? Number(size[2]) : null,
    // 표가 비어 있는 언어는 트랙으로 내놓지 않는다.
    streams: streams.filter((stream) => stream.entries.length),
  };
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/**
 * filePos 부터 자막 한 덩어리(SPU)를 이어 붙여 되살린다.
 *
 * 프로그램 스트림은 '팩 머리 + 패킷들' 이 되풀이되는 구조다. 우리가 쓸 것은
 * private_stream_1(0xBD) 안에서 첫 바이트가 이 자막의 번호인 것뿐이고,
 * 나머지(팩 머리·시스템 머리·채움)는 길이만 보고 건너뛴다.
 *
 * SPU 는 자기 길이를 앞 2바이트에 적어 두므로, 그만큼 모이면 끝이다.
 */
async function readSpuAt(reader, filePos, substreamId) {
  const chunks = [];
  let total = 0;
  let expected = null;
  let offset = filePos;

  while (offset + 6 <= reader.size && total < MAX_SPU_BYTES) {
    const head = await reader.ensure(offset, 14);
    if (head.length < 6) break;
    if (!(head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01)) break;
    const streamId = head[3];

    if (streamId === PACK_HEADER) {
      // MPEG-2 는 14바이트 + 채움, MPEG-1 은 12바이트.
      const isMpeg2 = (head[4] & 0xc0) === 0x40;
      offset += isMpeg2 ? 14 + (head[13] & 0x07) : 12;
      continue;
    }

    const packetLength = u16(head, 4);
    if (packetLength <= 0) break;

    if (streamId !== PRIVATE_STREAM_1) {
      offset += 6 + packetLength;              // 시스템 머리, 채움, 영상·소리 패킷
      continue;
    }

    // 0xBD 는 '플래그 2바이트 + 머리 길이 1바이트' 뒤부터가 알맹이다.
    const headerLength = head[8];
    const payloadLength = packetLength - 3 - headerLength;
    if (payloadLength > 1) {
      const payload = await reader.ensure(offset + 9 + headerLength, payloadLength);
      if (payload.length > 1 && payload[0] === substreamId) {
        chunks.push(payload.slice(1));
        total += payload.length - 1;
        if (expected === null && total >= 2) {
          expected = u16(concat(chunks, total), 0);
        }
      }
    }

    offset += 6 + packetLength;
    if (expected !== null && total >= expected) break;
  }

  if (!total) return null;
  const spu = concat(chunks, total);
  // 마지막 조각에 다음 자막의 앞부분이 딸려 올 수 있으므로 적힌 길이에서 끊는다.
  return expected !== null && expected > 0 && expected < spu.length ? spu.subarray(0, expected) : spu;
}

/**
 * 트랙 하나의 자막 덩어리를 표 순서대로 모두 읽는다.
 *
 * 표의 자리는 앞에서 뒤로 늘어서 있어, 읽는 자리도 앞으로만 간다.
 * 그래서 앞뒤로 오가며 읽지 않아도 되고, 조각 읽기가 그대로 들어맞는다.
 */
export async function readVobsubSamples(file, stream, onProgress) {
  const reader = new SliceReader(file);
  const samples = [];

  for (const [position, entry] of stream.entries.entries()) {
    const data = await readSpuAt(reader, entry.filePos, stream.substreamId);
    // 길이는 다음 자막이 나올 때까지로 본다(extract.js). SPU 가 끝 시각을
    // 스스로 적어 두었으면 그쪽이 이긴다.
    if (data) samples.push({ startMs: entry.startMs, durationMs: null, data });
    onProgress?.(position + 1, stream.entries.length);
  }

  return { samples, bytesFetched: reader.bytesFetched };
}
