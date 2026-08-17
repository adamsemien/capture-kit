// Minimal IndexedDB get/put for one directory handle. Shared verbatim by the
// spike page (window context, where the picker lives) and the spike service
// worker (where the write has to happen) — the whole question is whether a
// handle stored in one context still works in the other.
const DB_NAME = 'capture-kit-spike';
const STORE = 'settings';
const KEY = 'outputDir';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putHandle(handle) {
  const db = await open();
  try {
    await tx(db, 'readwrite', (store) => store.put(handle, KEY));
  } finally {
    db.close();
  }
}

export async function getHandle() {
  const db = await open();
  try {
    return (await tx(db, 'readonly', (store) => store.get(KEY))) ?? null;
  } finally {
    db.close();
  }
}
