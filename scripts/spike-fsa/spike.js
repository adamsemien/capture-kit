import { getHandle, putHandle } from './idb.js';

const out = document.getElementById('out');

function show(label, value) {
  out.textContent =
    `${label} @ ${new Date().toISOString()}\n` +
    `chrome ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] ?? '?'}\n\n` +
    (typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

document.getElementById('choose').addEventListener('click', async () => {
  try {
    const handle = await showDirectoryPicker({ id: 'capture-kit-spike', mode: 'readwrite' });
    await putHandle(handle);
    const permission = await handle.queryPermission({ mode: 'readwrite' });
    show('CHOOSE', { picked: handle.name, storedInIDB: true, permission });
  } catch (error) {
    show('CHOOSE failed', String(error));
  }
});

document.getElementById('write').addEventListener('click', async () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fromPage = { attempted: false };
  // Page-context control: if the SW write fails but this succeeds, the answer
  // is "SW context specifically", not "FSA is broken here".
  try {
    const handle = await getHandle();
    fromPage.attempted = true;
    fromPage.handle = handle ? handle.name : null;
    fromPage.permission = handle ? await handle.queryPermission({ mode: 'readwrite' }) : null;
  } catch (error) {
    fromPage.error = String(error);
  }
  const report = await chrome.runtime.sendMessage({
    type: 'SPIKE_WRITE',
    filename: `spike-${stamp}.txt`,
    text: `capture-kit FSA spike, written from the MV3 service worker at ${stamp}\n`,
  });
  show('WRITE', { fromPage, fromServiceWorker: report });
});

document.getElementById('probe').addEventListener('click', async () => {
  const sw = await chrome.runtime.sendMessage({ type: 'SPIKE_PROBE' });
  show('PROBE', {
    page: {
      hasShowDirectoryPicker: typeof showDirectoryPicker,
      hasCreateWritable: typeof FileSystemFileHandle.prototype.createWritable,
    },
    serviceWorker: sw,
  });
});
