/*
 * Where "the last capture of this page" lives: one IndexedDB record per page,
 * in the extension's own storage on this computer. Each record holds a small
 * copy of the image (at most COMPARE_WIDTH px wide) and the signatures of the
 * errors and failed requests - enough to compare against, nothing more.
 *
 * Bounded: the oldest pages are forgotten past MAX_PAGES. "Forget saved
 * comparisons" in Settings empties it.
 */

import type { Signed } from './signatures';

const DB_NAME = 'capture-kit-compare';
const STORE = 'pages';
const DB_VERSION = 1;
export const MAX_PAGES = 50;

export interface PageRecord {
  /** pageKey(url) */
  key: string;
  url: string;
  capturedAt: number;
  imageFilename: string;
  /** Viewport width the capture was taken at, CSS px - different widths are not compared. */
  viewportWidth: number;
  /** Page size the image depicts, CSS px. */
  pageWidth: number;
  pageHeight: number;
  /** The small copy: PNG, `thumbWidth` px wide, covering the whole page top to bottom (or the first THUMB_MAX_HEIGHT rows). */
  thumb: Blob;
  thumbWidth: number;
  thumbHeight: number;
  errors: Signed[];
  failures: Signed[];
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('capturedAt', 'capturedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getPage(key: string): Promise<PageRecord | null> {
  const db = await open();
  try {
    return await new Promise<PageRecord | null>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result as PageRecord | undefined) ?? null);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export async function putPage(record: PageRecord): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.put(record);
    // Forget the oldest pages beyond the cap.
    const countReq = store.count();
    countReq.onsuccess = () => {
      let excess = countReq.result - MAX_PAGES;
      if (excess <= 0) return;
      const cursorReq = store.index('capturedAt').openCursor();
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || excess <= 0) return;
        cursor.delete();
        excess -= 1;
        cursor.continue();
      };
    };
    await done(tx);
  } finally {
    db.close();
  }
}

export async function clearPages(): Promise<void> {
  const db = await open();
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  } finally {
    db.close();
  }
}

export async function countPages(): Promise<number> {
  const db = await open();
  try {
    return await new Promise<number>((resolve, reject) => {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}
