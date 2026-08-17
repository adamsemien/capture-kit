// Spike service worker. Everything here answers one question: can an MV3
// service worker take a FileSystemDirectoryHandle that a window context put in
// IndexedDB and actually write a file through it?
import { getHandle } from './idb.js';

function probe() {
  return {
    context: 'service worker',
    hasShowDirectoryPicker: typeof self.showDirectoryPicker,
    hasFileSystemDirectoryHandle: typeof self.FileSystemDirectoryHandle,
    hasFileSystemFileHandle: typeof self.FileSystemFileHandle,
    hasCreateWritable:
      typeof self.FileSystemFileHandle !== 'undefined' &&
      typeof self.FileSystemFileHandle.prototype.createWritable,
    hasWritableStream: typeof self.FileSystemWritableFileStream,
  };
}

async function write(filename, text) {
  const report = { probe: probe(), steps: [] };
  const step = (name, value) => report.steps.push({ [name]: value });
  try {
    const handle = await getHandle();
    step('handle loaded from IDB', handle ? `${handle.kind} "${handle.name}"` : 'NULL');
    if (!handle) {
      report.ok = false;
      report.error = 'no handle in IndexedDB — run "Choose folder" on the spike page first';
      return report;
    }

    step('typeof handle.queryPermission', typeof handle.queryPermission);
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    step('queryPermission({mode:readwrite})', permission);
    report.permission = permission;
    if (permission !== 'granted') {
      // requestPermission needs a user gesture; from a worker it should reject
      // or return 'prompt'. Recording which it does is part of the finding.
      try {
        const requested = await handle.requestPermission({ mode: 'readwrite' });
        step('requestPermission from SW (no gesture)', requested);
      } catch (error) {
        step('requestPermission from SW threw', String(error));
      }
    }

    const fileHandle = await handle.getFileHandle(filename, { create: true });
    step('getFileHandle({create:true})', fileHandle.name);
    step('typeof fileHandle.createWritable', typeof fileHandle.createWritable);

    const writable = await fileHandle.createWritable();
    step('createWritable()', writable.constructor.name);
    await writable.write(text);
    await writable.close();
    step('write + close', 'done');

    const file = await fileHandle.getFile();
    step('readback size', `${file.size} bytes`);
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = `${error && error.name ? error.name : 'Error'}: ${
      error && error.message ? error.message : String(error)
    }`;
  }
  return report;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'SPIKE_PROBE') {
    sendResponse(probe());
    return false;
  }
  if (message?.type === 'SPIKE_WRITE') {
    void write(message.filename, message.text).then(sendResponse);
    return true;
  }
  return false;
});
