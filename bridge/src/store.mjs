// The captures the extension hands over, kept as files an agent can read.
//
// Each capture gets its own folder under ~/.capture-kit/captures/<id>/ with
// the report, the image, its slices and the "what changed" image, named as
// they were in your output folder, so every relative path inside the report
// still resolves. Only the most recent MAX_CAPTURES are kept.

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, normalize, sep } from 'node:path';
import { capturesDir } from './config.mjs';

export const MAX_CAPTURES = 20;

/** A name from the extension, made safe to use as one path segment. */
function safeSegment(name) {
  const cleaned = String(name ?? '')
    .replace(/[^A-Za-z0-9._ ()-]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 160);
  return cleaned || 'capture';
}

/** A relative path from the extension ("x_slices/slice-01.jpg"), kept inside `root`. */
function safeRelative(root, rel) {
  const parts = String(rel).split(/[\\/]+/).filter((p) => p && p !== '.' && p !== '..').map(safeSegment);
  if (parts.length === 0) throw new Error('empty file name');
  const full = normalize(join(root, ...parts));
  if (!full.startsWith(root + sep)) throw new Error('file name escapes the capture folder');
  return full;
}

function writeBase64(path, base64) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, Buffer.from(base64, 'base64'));
}

export class CaptureStore {
  constructor(dir = capturesDir()) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  /** Every stored capture's metadata, newest first. */
  list() {
    const out = [];
    for (const name of readdirSync(this.dir)) {
      const meta = join(this.dir, name, 'meta.json');
      if (!existsSync(meta)) continue;
      try {
        out.push(JSON.parse(readFileSync(meta, 'utf8')));
      } catch {
        /* a half-written folder; skipped */
      }
    }
    return out.sort((a, b) => b.capturedAt - a.capturedAt);
  }

  get(id) {
    const meta = join(this.dir, safeSegment(id), 'meta.json');
    if (!existsSync(meta)) return null;
    return JSON.parse(readFileSync(meta, 'utf8'));
  }

  latest() {
    return this.list()[0] ?? null;
  }

  /** Writes one capture from the extension and returns its metadata. */
  save(record) {
    let id = safeSegment(record.id);
    let folder = join(this.dir, id);
    for (let n = 2; existsSync(folder); n++) {
      id = `${safeSegment(record.id)}-${n}`;
      folder = join(this.dir, id);
    }
    mkdirSync(folder, { recursive: true, mode: 0o700 });
    const imagePath = safeRelative(folder, record.image.filename);
    writeBase64(imagePath, record.image.base64);
    const slicePaths = [];
    for (const slice of record.slices ?? []) {
      const p = safeRelative(folder, slice.path);
      writeBase64(p, slice.base64);
      slicePaths.push({ path: p, top: slice.top, height: slice.height });
    }
    const extras = [];
    for (const extra of record.extras ?? []) {
      const p = safeRelative(folder, extra.filename);
      writeBase64(p, extra.base64);
      extras.push({ path: p, label: String(extra.label ?? ''), mime: String(extra.mime ?? 'image/jpeg') });
    }
    let changesPath = null;
    if (record.changes?.base64) {
      changesPath = safeRelative(folder, record.changes.filename);
      writeBase64(changesPath, record.changes.base64);
    }
    const markdownPath = safeRelative(folder, record.markdownFilename || `${id}.md`);
    writeFileSync(markdownPath, String(record.markdown ?? ''));
    const meta = {
      id,
      capturedAt: Number(record.capturedAt) || Date.now(),
      url: String(record.url ?? ''),
      title: String(record.title ?? ''),
      trigger: String(record.trigger ?? ''),
      kind: String(record.kind ?? 'page'),
      errors: Number(record.errors) || 0,
      failures: Number(record.failures) || 0,
      folder,
      markdownPath,
      imagePath,
      imageMime: String(record.image.mime ?? 'image/jpeg'),
      imageWidth: Number(record.image.width) || null,
      imageHeight: Number(record.image.height) || null,
      slices: slicePaths,
      changesPath,
      extras,
    };
    writeFileSync(join(folder, 'meta.json'), JSON.stringify(meta, null, 2));
    this.prune();
    return meta;
  }

  markdown(meta) {
    return readFileSync(meta.markdownPath, 'utf8');
  }

  prune() {
    const all = this.list();
    for (const old of all.slice(MAX_CAPTURES)) {
      const folder = join(this.dir, basename(old.folder));
      rmSync(folder, { recursive: true, force: true });
    }
  }
}
