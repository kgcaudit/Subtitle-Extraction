// 화면 동작. 파일 고르기 → 트랙 목록 → 추출 → 내려받기.

import { ensureTesseract } from './config.js';
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
import { classify, resolveSource } from './source.js';
import { prepareForOcr } from './bitmapPrep.js';
import { OcrPool, pickLanguage } from './ocr.js';
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
  ocrLang: document.getElementById('ocrLang'),
  ocrScale: document.getElementById('ocrScale'),
};

/** 그림 자막 인식 설정. 측정해 보면 자료에 따라 최선이 달라 고를 수 있게 했다. */
function ocrSettings() {
  return {
    language: ui.ocrLang?.value || 'auto',
    scale: Number(ui.ocrScale?.value) || 2,
  };
}

const state = {
  file: null,
  indexText: null,
  // DVD 자막(.idx/.sub)은 하나씩 와도 되도록, 먼저 온 것을 들고 있는다.
  held: { indexFile: null, mainFile: null },
  tracks: [],
  container: null,
  context: {},
  selected: new Set(),
  busy: false,
  objectUrls: [],
  languageNotice: null,
};

let assetsPromise = null;

// --- 화면 갱신 -------------------------------------------------------------

function say(message, isError = false) {
  ui.status.textContent = message;
  ui.status.classList.toggle('error', isError);
  ui.status.classList.remove('waiting');
}

/** 짝이 되는 파일을 더 기다리는 중. 오류가 아니라 '다음 차례' 안내다. */
function sayWaiting(message) {
  ui.status.replaceChildren();
  // **굵게** 표시한 부분만 강조한다.
  message.split(/\*\*(.+?)\*\*/g).forEach((part, index) => {
    ui.status.append(index % 2 ? Object.assign(document.createElement('strong'), { textContent: part }) : part);
  });
  ui.status.classList.remove('error');
  ui.status.classList.add('waiting');
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
  if (ui.ocrLang) ui.ocrLang.disabled = busy;
  if (ui.ocrScale) ui.ocrScale.disabled = busy;
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

async function openFiles(files) {
  setBusy(true);
  let handedOver = false;

  try {
    const picked = await classify(files);

    // 새로 고른 것을 앞서 고른 것 위에 얹는다. 같은 자리면 새것이 이긴다.
    if (picked.indexFile) state.held.indexFile = picked.indexFile;
    if (picked.mainFile) state.held.mainFile = picked.mainFile;

    const source = await resolveSource(state.held);
    if (!source.ready) {
      // 아직 짝이 덜 왔다. 들고 있으면서 무엇을 더 고르면 되는지 알려 준다.
      clearResults();
      ui.trackSection.hidden = true;
      if (source.message) sayWaiting(source.message);
      return;
    }

    state.held = { indexFile: null, mainFile: null };
    handedOver = true;
    await openFile(source.file, source.indexText);
  } catch (error) {
    say(`파일을 읽지 못했습니다: ${error.message}`, true);
  } finally {
    // openFile 로 넘겼으면 그쪽이 스스로 푼다. 아니면 여기서 풀어야
    // 기다리는 동안에도 다음 파일을 고를 수 있다.
    if (!handedOver) setBusy(false);
  }
}

async function openFile(file, indexText = null) {
  state.file = file;
  state.indexText = indexText;
  state.tracks = [];
  state.selected = new Set();
  clearResults();
  ui.trackSection.hidden = true;
  setBusy(true);
  say(`${file.name} — 자막 트랙을 찾는 중…`);

  try {
    const { container, tracks, context } = await listTracks(file, { indexText });
    state.container = container;
    state.tracks = tracks;
    state.context = context;

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
  state.languageNotice = null;

  const chosen = state.tracks.filter((t) => state.selected.has(t.subtitleIndex) && isSupported(t));
  const usedNames = new Set();
  const settings = ocrSettings();
  let pool = null;

  try {
    for (const [position, track] of chosen.entries()) {
      const label = `트랙 #${track.subtitleIndex} (${formatName(track.mimeType)})`;
      const startedAt = performance.now();

      say(`${label} — 자막을 꺼내는 중…`);
      const cues = track.standaloneSup
        ? await readStandaloneSup(state.file)
        : await readTrackCues(state.file, track, state.container, state.context, (read, total) =>
            showProgress(total ? read / total : null),
          );
      showProgress(null);

      let textCues = cues;
      if (cues.some((cue) => cue.image)) {
        const prepared = prepareImages(cues, settings.scale);
        pool ??= await startOcr(settings.language, prepared.images);
        textCues = await recognizeCues(cues, prepared, pool, label);
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
      const note = state.languageNotice ? ` · ${state.languageNotice}` : '';
      say(`${label} 완료 (${tidied.length}줄, ${seconds}초) — ${position + 1}/${chosen.length}${note}`);
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

const LANGUAGE_LABELS = { kor: '한국어만', 'kor+eng': '한국어+영어', eng: '영어만' };

async function startOcr(language, images) {
  say('문자 인식 엔진을 준비하는 중…');
  assetsPromise ??= ensureTesseract();
  const assets = await assetsPromise;

  let chosen = language;
  if (language === 'auto') {
    say('어느 언어로 읽을지 앞부분을 살펴보는 중…');
    const decision = await pickLanguage(assets, images);
    chosen = decision.language;
    const detail = decision.latinWords
      ? `낱말 ${decision.totalWords}개 중 영문 ${decision.latinWords}개` +
        `(${(decision.latinShare * 100).toFixed(0)}%), 확신도 ${decision.latinConfidence.toFixed(0)}`
      : '영문이 보이지 않음';
    const notice = `인식 언어를 '${LANGUAGE_LABELS[chosen] ?? chosen}' 로 정했습니다 (${detail})`;
    state.languageNotice = notice;
    say(notice);
  }
  return OcrPool.create(assets, { language: chosen });
}

/** 그림 자막을 인식기에 넣을 수 있게 다듬는다. 어느 자막의 것인지도 함께 기억한다. */
function prepareImages(cues, scale) {
  const images = [];
  const index = [];
  cues.forEach((cue, position) => {
    if (!cue.image) return;
    const image = prepareForOcr(cue.image, { scale });
    if (!image) return;
    images.push(image);
    index.push(position);
  });
  return { images, index };
}

async function recognizeCues(cues, prepared, pool, label) {
  say(`${label} — 글자를 읽는 중 0/${prepared.images.length}`);
  const texts = await pool.recognizeAll(prepared.images, (done, total) => {
    showProgress(done / total);
    say(`${label} — 글자를 읽는 중 ${done}/${total}`);
  });
  showProgress(null);

  const result = cues.map((cue) => ({ ...cue }));
  prepared.index.forEach((position, order) => {
    result[position].text = texts[order];
  });
  return result;
}

// --- 붙이기 ---------------------------------------------------------------

ui.file.addEventListener('change', () => {
  const files = [...(ui.file.files ?? [])];
  // 값을 비워 둬야 같은 파일을 다시 골라도 change 가 난다.
  ui.file.value = '';
  if (files.length) openFiles(files);
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
  const files = [...(event.dataTransfer?.files ?? [])];
  if (files.length && !state.busy) openFiles(files);
});

setBusy(false);
say('영상 파일을 고르면 자막 트랙을 보여 드립니다.');
