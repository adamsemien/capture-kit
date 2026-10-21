// What ck and the MCP server print for a capture: where its files are, then
// the report itself. Absolute paths, because an agent reads files by path.

import { readFileSync, statSync } from 'node:fs';

export function header(meta) {
  const lines = [
    `Capture ${meta.id} - ${new Date(meta.capturedAt).toISOString()}`,
    `Page: ${meta.title || '(untitled)'} - ${meta.url}`,
    `Report: ${meta.markdownPath}`,
    `Image: ${meta.imagePath}${meta.imageWidth ? ` (${meta.imageWidth}×${meta.imageHeight})` : ''}`,
  ];
  if (meta.slices?.length) {
    lines.push(`Slices (screen-sized pieces of a tall page, top to bottom):`);
    for (const s of meta.slices) lines.push(`  ${s.path}`);
  }
  for (const extra of meta.extras ?? []) lines.push(`Image (${extra.label}): ${extra.path}`);
  if (meta.changesPath) lines.push(`What changed since the last capture of this page: ${meta.changesPath}`);
  return lines.join('\n');
}

export function listLine(meta) {
  const when = new Date(meta.capturedAt).toLocaleString();
  const issues = [
    meta.errors ? `${meta.errors} error${meta.errors === 1 ? '' : 's'}` : null,
    meta.failures ? `${meta.failures} failed request${meta.failures === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(', ');
  const kind = meta.kind && meta.kind !== 'page' ? `  (${meta.kind})` : '';
  return `${meta.id}  ${when}  ${meta.url}${kind}${issues ? `  [${issues}]` : ''}`;
}

/** Bytes on disk, or Infinity when unreadable. */
export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return Infinity;
  }
}

export function readBase64(path) {
  return readFileSync(path).toString('base64');
}
