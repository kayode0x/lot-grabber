// The save folder is a FileSystemDirectoryHandle the user picks once in Settings.
// Handles are structured-cloneable, so they persist in IndexedDB and are visible
// to every page of this extension (settings, popup, offscreen).

const DB = 'lot-grabber';
const STORE = 'handles';
const KEY = 'saveRoot';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  });
}

export const getRoot = () => tx('readonly', (s) => s.get(KEY));
export const setRoot = (handle) => tx('readwrite', (s) => s.put(handle, KEY));

// 'granted' | 'prompt' | 'denied' | 'unset'
export async function rootStatus() {
  const root = await getRoot();
  if (!root) return { state: 'unset', root: null };
  const state = await root.queryPermission({ mode: 'readwrite' });
  return { state, root };
}
