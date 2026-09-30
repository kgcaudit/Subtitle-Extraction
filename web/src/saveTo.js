// 내려받을 폴더를 골라 기억한다.
//
// 브라우저가 알아서 내려받으면 '다운로드' 폴더에 떨어지고, 폰에서는 그걸 다시
// 찾아 들어가야 한다. 폴더를 한 번 골라 두면 그 뒤로는 거기에 바로 쓴다.
//
// 이 기능은 File System Access 로, 되는 곳과 안 되는 곳이 갈린다.
//   크롬(PC)·엣지 86+, 크롬(안드로이드) 132+ 는 되고,
//   사파리(맥·아이폰)와 파이어폭스는 안 된다.
// 그래서 늘 '있으면 쓰고 없으면 예전처럼' 이다. 쓰기가 막히거나 실패해도
// 예전 방식으로 내려받아, 자막을 못 받는 일은 없게 한다.

const DB_NAME = 'subex';
const STORE = 'handles';
const KEY = 'saveDir';

/** 이 브라우저에서 폴더를 고를 수 있나. */
export function canPickFolder() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function withStore(mode, run) {
  return openDb().then(
    (db) =>
      new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request?.result ?? null);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

/**
 * 지난번에 고른 폴더를 되찾는다.
 *
 * 폴더 손잡이(handle)는 IndexedDB 에 그대로 담을 수 있어서, 창을 닫았다 열어도
 * 남는다. 비공개 창처럼 IndexedDB 가 막힌 곳에서는 조용히 없는 셈 친다.
 */
export async function loadFolder() {
  if (!canPickFolder()) return null;
  try {
    return (await withStore('readonly', (store) => store.get(KEY))) ?? null;
  } catch {
    return null;
  }
}

export async function rememberFolder(handle) {
  try {
    await withStore('readwrite', (store) => store.put(handle, KEY));
  } catch {
    // 못 담아도 이번 판에서는 쓸 수 있다. 굳이 알릴 일은 아니다.
  }
}

export async function forgetFolder() {
  try {
    await withStore('readwrite', (store) => store.delete(KEY));
  } catch {
    // 위와 같다.
  }
}

/** 폴더 고르기 창을 띄운다. 사용자가 취소하면 null. */
export async function pickFolder() {
  try {
    return await globalThis.showDirectoryPicker({
      id: 'subex-save',       // 다음에도 같은 자리에서 열리게 한다
      mode: 'readwrite',
      startIn: 'downloads',
    });
  } catch (error) {
    if (error?.name === 'AbortError') return null;   // 그냥 닫은 것
    throw error;
  }
}

/**
 * 쓸 수 있는 상태인지 확인하고, 아니면 허락을 구한다.
 *
 * 허락을 묻는 창은 사용자가 누른 직후에만 뜬다. 그래서 이 함수는 단추를 누른
 * 흐름 안에서 불러야 한다.
 */
export async function ensureWritable(handle) {
  if (!handle?.queryPermission) return false;
  const options = { mode: 'readwrite' };
  try {
    if ((await handle.queryPermission(options)) === 'granted') return true;
    return (await handle.requestPermission(options)) === 'granted';
  } catch {
    return false;
  }
}

/**
 * 고른 폴더에 파일들을 쓴다. 같은 이름이 있으면 덮어쓴다 — 같은 영상을 다시
 * 뽑은 경우이기 때문이다.
 */
export async function writeFiles(handle, entries) {
  for (const entry of entries) {
    const file = await handle.getFileHandle(entry.name, { create: true });
    const stream = await file.createWritable();
    await stream.write(entry.text);
    await stream.close();
  }
}
