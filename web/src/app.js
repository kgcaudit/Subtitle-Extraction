// 화면 동작. 파일 고르기 → 트랙 목록 → 추출 → 내려받기.

import { loadScript, resolveAssets } from './config.js';
import {
  describeTrack,
  formatName,
  isBitmap,
  isSupported,
  listTracks,
  readTrackCues,
  uniqueFileName,
} from './extract.js';
import { decodeSupFile } from './pgs.js';
import { prepareForOcr } from './bitmapPrep.js';
import { OcrPool } from './ocr.js';
import { tidy } from './postprocess.js';
import { render } from './srt.js';

const ui = {
  drop: document.getElementById('drop'),
  file: document.getElementById('file'),
  status: document.getElementById('status'),
  bar: document.getElementById('bar'),
  barFill: document.getElementById('barFill'),
  trackSection: document.getElementById('trackSection'),
  tracks: document.getElementById('tracks'),
  extract: document.getElementById('extract'),
  resultSection: document.getElementById('resultSection'),
  results: document.getElementById('results'),
};

const state = {
  file: null,
  tracks: [],
  timestampScale: 1000000,
  selected: new Set(),
  busy: false,
  objectUrls: [],
};

let assetsPromise = null;

// --- 화면 갱신 -------------------------------------------------------------

function say(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
}

function showProgress(ratio) {
  if (ratio === null) {
    ui.bar.hidden = true;
    return;
  }
  ui.bar.hidden = false;
  ui.barFill.style.width = `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`;
}

function setBusy(busy) {
  state.busy = busy;
  ui.extract.disabled = busy || state.selected.size === 0;
  ui.file.disabled = busy;
}

function renderTracks() {
  ui.tracks.replaceChildren();
  for (const track of state.tracks) {
    const supported = isSupported(track);
    const item = document.createElement('li');
    item.className = supported ? 'track' : 'track unsupported';

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = supported && state.selected.has(track.subtitleIndex);
    checkbox.disabled = !supported;
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.selected.add(track.subtitleIndex);
      else state.selected.delete(track.subtitleIndex);
      setBusy(state.busy);
    });

    const main = document.createElement('div');
    main.className = 'track-main';
    const title = document.createElement('div');
    title.className = 'track-title';
    title.textContent = describeTrack(track);
    const note = document.createElement('div');
    note.className = 'track-note';
    note.textContent = !supported
      ? `${formatName(track.mimeType)} 은(는) 아직 지원하지 않습니다`
      : isBitmap(track)
        ? '그림 자막 — 글자로 읽어 내는 데 시간이 걸립니다'
        : '글자 자막 — 바로 변환됩니다';

    main.append(title, note);
    item.append(checkbox, main);
    ui.tracks.append(item);
  }
  ui.trackSection.hidden = state.tracks.length === 0;
}

function addResult(fileName, cues) {
  const text = render(cues);
  const blob = new Blob([text], { type: 'application/x-subrip;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  state.objectUrls.push(url);

  const item = document.createElement('li');
  item.className = 'result';

  const head = document.createElement('div');
  head.className = 'result-head';

  const label = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'result-name';
  name.textContent = fileName;
  const count = document.createElement('div');
  count.className = 'result-count';
  count.textContent = `${cues.length}줄`;
  label.append(name, count);

  const download = document.createElement('a');
  download.className = 'button';
  download.href = url;
  download.download = fileName;
  download.textContent = '내려받기';

  head.append(label, download);

  const preview = document.createElement('pre');
  preview.className = 'preview';
  preview.textContent = cues
    .slice(0, 5)
    .map((cue) => cue.text)
    .join('\n');

  item.append(head, preview);
  ui.results.append(item);
  ui.resultSection.hidden = false;
}

function clearResults() {
  for (const url of state.objectUrls) URL.revokeObjectURL(url);
  state.objectUrls = [];
  ui.results.replaceChildren();
  ui.resultSection.hidden = true;
}

// --- 동작 -----------------------------------------------------------------

async function openFile(file) {
  state.file = file;
  state.tracks = [];
  state.selected = new Set();
  clearResults();
  ui.trackSection.hidden = true;
  setBusy(true);
  say(`${file.name} — 자막 트랙을 찾는 중…`);

  try {
    if (file.name.toLowerCase().endsWith('.sup')) {
      // 독립된 .sup 자막 파일. 트랙이라는 개념이 없으니 하나로 취급한다.
      state.tracks = [
        {
          trackNumber: 0,
          subtitleIndex: 0,
          mimeType: 'application/pgs',
          language: null,
          standaloneSup: true,
        },
      ];
    } else {
      const { tracks, timestampScale } = await listTracks(file);
      state.tracks = tracks;
      state.timestampScale = timestampScale;
    }

    state.selected = new Set(state.tracks.filter(isSupported).map((t) => t.subtitleIndex));
    renderTracks();
    say(
      state.tracks.length
        ? `자막 트랙 ${state.tracks.length}개를 찾았습니다.`
        : '자막 트랙이 없습니다. 화면에 새겨진(번인) 자막이거나 자막이 없는 영상일 수 있습니다.',
      state.tracks.length === 0,
    );
  } catch (error) {
    say(`파일을 열지 못했습니다: ${error.message}`, true);
  } finally {
    setBusy(false);
  }
}

async function extractSelected() {
  if (!state.file || state.busy) return;
  clearResults();
  setBusy(true);

  const chosen = state.tracks.filter((t) => state.selected.has(t.subtitleIndex) && isSupported(t));
  const usedNames = new Set();
  let pool = null;

  try {
    for (const [position, track] of chosen.entries()) {
      const label = `트랙 #${track.subtitleIndex} (${formatName(track.mimeType)})`;
      const startedAt = performance.now();

      say(`${label} — 자막을 꺼내는 중…`);
      const cues = track.standaloneSup
        ? await readStandaloneSup(state.file)
        : await readTrackCues(state.file, track, state.timestampScale, (read, total) =>
            showProgress(total ? read / total : null),
          );
      showProgress(null);

      let textCues = cues;
      if (cues.some((cue) => cue.image)) {
        pool ??= await startOcr();
        textCues = await recognizeCues(cues, pool, label);
      }

      const tidied = tidy(
        textCues.map((cue) => ({ startMs: cue.startMs, endMs: cue.endMs, text: cue.text ?? '' })),
        // 글자 자막에는 ASS 스타일 태그가 섞여 있을 수 있지만 인식 결과에는 없다.
        { stripStyling: !isBitmap(track) },
      );

      if (tidied.length) {
        const fileName = uniqueFileName(state.file.name, track, usedNames);
        usedNames.add(fileName);
        addResult(fileName, tidied);
      }
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      say(`${label} 완료 (${tidied.length}줄, ${seconds}초) — ${position + 1}/${chosen.length}`);
    }

    if (!ui.results.childElementCount) say('추출된 자막이 없습니다.', true);
  } catch (error) {
    say(`추출 중 문제가 생겼습니다: ${error.message}`, true);
  } finally {
    showProgress(null);
    await pool?.terminate();
    setBusy(false);
  }
}

async function readStandaloneSup(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return decodeSupFile(bytes);
}

async function startOcr() {
  say('문자 인식 엔진을 준비하는 중…');
  assetsPromise ??= resolveAssets();
  const assets = await assetsPromise;
  if (!globalThis.Tesseract) await loadScript(assets.script);
  return OcrPool.create(assets);
}

async function recognizeCues(cues, pool, label) {
  const prepared = [];
  const index = [];
  cues.forEach((cue, position) => {
    if (!cue.image) return;
    const image = prepareForOcr(cue.image);
    if (!image) return;
    prepared.push(image);
    index.push(position);
  });

  say(`${label} — 글자를 읽는 중 0/${prepared.length}`);
  const texts = await pool.recognizeAll(prepared, (done, total) => {
    showProgress(done / total);
    say(`${label} — 글자를 읽는 중 ${done}/${total}`);
  });
  showProgress(null);

  const result = cues.map((cue) => ({ ...cue }));
  index.forEach((position, order) => {
    result[position].text = texts[order];
  });
  return result;
}

// --- 붙이기 ---------------------------------------------------------------

ui.file.addEventListener('change', () => {
  const file = ui.file.files?.[0];
  if (file) openFile(file);
});

ui.extract.addEventListener('click', extractSelected);

for (const type of ['dragenter', 'dragover']) {
  ui.drop.addEventListener(type, (event) => {
    event.preventDefault();
    ui.drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  ui.drop.addEventListener(type, () => ui.drop.classList.remove('over'));
}
ui.drop.addEventListener('drop', (event) => {
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0];
  if (file && !state.busy) openFile(file);
});

setBusy(false);
say('영상 파일을 고르면 자막 트랙을 보여 드립니다.');
