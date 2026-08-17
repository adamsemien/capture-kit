// The chosen output directory: one FileSystemDirectoryHandle, picked on the
// options page and persisted in IndexedDB so the service worker can write
// through it. chrome.storage cannot hold a handle (it JSON-serializes);
// IndexedDB structured-clones it, which is what keeps the handle alive.
//
// What the 2026-08-17 spike proved about this, since the code below only makes
// sense in light of it:
//   - A handle stored from the options page works in an MV3 service worker:
//     queryPermission → getFileHandle({create:true}) → createWritable → write.
//   - The permission does NOT survive a full Chrome restart on a
//     chrome-extension:// origin. Chrome's "allow on every visit" extended
//     permission does not apply here — tested directly against the pref.
//   - Getting it back costs one user-activated click in any extension page;
//     Chrome remembers the folder, so nobody re-picks anything. That grant is
//     origin-wide for the browser session and outlives the page that asked.
// Hence: the worker never requests permission (it cannot), it only checks. The
// asking lives in the options page and the result tab.

const DB_NAME = 'capture-kit';
const DB_VERSION = 1;
const STORE = 'settings';
const HANDLE_KEY = 'outputDir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = fn(transaction.objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveOutputDir(handle: FileSystemDirectoryHandle): Promise<void> {
  const db = await openDb();
  try {
    await run(db, 'readwrite', (store) => store.put(handle, HANDLE_KEY));
  } finally {
    db.close();
  }
}

export async function loadOutputDir(): Promise<FileSystemDirectoryHandle | null> {
  try {
    const db = await openDb();
    try {
      const handle = await run<FileSystemDirectoryHandle | undefined>(db, 'readonly', (store) =>
        store.get(HANDLE_KEY),
      );
      return handle ?? null;
    } finally {
      db.close();
    }
  } catch {
    // A missing or unreadable database means "no chosen folder" — never an
    // error the user sees, because the capture still has Downloads.
    return null;
  }
}

export async function clearOutputDir(): Promise<void> {
  const db = await openDb();
  try {
    await run(db, 'readwrite', (store) => store.delete(HANDLE_KEY));
  } finally {
    db.close();
  }
}

/** 'none' = nothing chosen, 'granted' = writable now, 'lapsed' = chosen but needs a click. */
export type OutputDirState = 'none' | 'granted' | 'lapsed';

export interface OutputDirStatus {
  state: OutputDirState;
  /** Folder name — the File System Access API never exposes a full path. */
  name: string | null;
}

export async function outputDirStatus(): Promise<OutputDirStatus> {
  const handle = await loadOutputDir();
  if (!handle) return { state: 'none', name: null };
  try {
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    return { state: permission === 'granted' ? 'granted' : 'lapsed', name: handle.name };
  } catch {
    return { state: 'lapsed', name: handle.name };
  }
}

/**
 * Re-arm the permission. Only callable from a window context during a user
 * gesture — the service worker gets SecurityError, proven by the spike.
 */
export async function requestOutputDirPermission(): Promise<OutputDirStatus> {
  const handle = await loadOutputDir();
  if (!handle) return { state: 'none', name: null };
  try {
    const permission = await handle.requestPermission({ mode: 'readwrite' });
    return { state: permission === 'granted' ? 'granted' : 'lapsed', name: handle.name };
  } catch {
    return { state: 'lapsed', name: handle.name };
  }
}

/**
 * Chrome's downloads API uniquifies colliding names for us; the File System
 * Access API has no such thing, so the same semantics are rebuilt here:
 * "name.ext" → "name (1).ext" → "name (2).ext". An existing file is never
 * renamed or truncated — the collision moves the NEW file out of the way.
 */
async function uniqueName(dir: FileSystemDirectoryHandle, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  for (let n = 0; n < 1000; n++) {
    const candidate = n === 0 ? filename : `${stem} (${n})${ext}`;
    try {
      await dir.getFileHandle(candidate);
      // It exists — try the next suffix.
    } catch (error) {
      // NotFoundError is the answer we want; anything else (a permission that
      // lapsed between the check and here) belongs to the caller.
      if ((error as DOMException)?.name === 'NotFoundError') return candidate;
      throw error;
    }
  }
  return filename;
}

/**
 * Resolve nested paths like "session_2026-08-17_10-35/index.md" the way
 * downloads.download() does: every segment before the last is a subdirectory,
 * created on demand.
 */
async function resolveDir(
  root: FileSystemDirectoryHandle,
  segments: string[],
): Promise<FileSystemDirectoryHandle> {
  let dir = root;
  for (const segment of segments) {
    dir = await dir.getDirectoryHandle(segment, { create: true });
  }
  return dir;
}

export interface FsaWriteResult {
  /** Name actually written — may carry a " (1)" suffix. */
  filename: string;
  /** Folder name the file landed in, for the result tab's output line. */
  root: string;
}

/**
 * Write one file into the chosen directory. Throws if there is no handle or
 * the permission has lapsed; the caller falls back to Downloads.
 */
export async function writeToOutputDir(
  path: string,
  mime: string,
  base64: string,
  overwrite: boolean,
): Promise<FsaWriteResult> {
  const handle = await loadOutputDir();
  if (!handle) throw new Error('no output directory chosen');
  const permission = await handle.queryPermission({ mode: 'readwrite' });
  if (permission !== 'granted') throw new Error('output directory permission lapsed');

  const segments = path.split('/').filter(Boolean);
  const filename = segments.pop() as string;
  const dir = await resolveDir(handle, segments);
  // latest.* and the pointer folder overwrite by contract; everything else
  // gets Chrome's uniquify behavior.
  const target = overwrite ? filename : await uniqueName(dir, filename);

  const fileHandle = await dir.getFileHandle(target, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(base64ToBlob(base64, mime));
  } finally {
    await writable.close();
  }
  return { filename: target, root: handle.name };
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}
