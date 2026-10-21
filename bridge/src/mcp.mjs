// The MCP server: the same captures, as tools an MCP client (Claude Desktop,
// Claude Code, Cursor) can call. A thin layer over the helper - every tool is
// one helper request - per the 2026-08-17 decision that MCP sits on top of
// the helper rather than being the foundation.

import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';
import { createClient } from './client.mjs';
import { fileSize, header, listLine, readBase64 } from './format.mjs';

/** Images an MCP client can take inline: keep each under ~4 MB and 8000 px tall. */
const MAX_INLINE_BYTES = 4 * 1024 * 1024;
const MAX_INLINE_HEIGHT = 8000;
const MAX_SLICES_INLINE = 6;
/**
 * All images in one answer together. MCP clients cap one message at about
 * 10 MB by default, and base64 adds a third; 5 MB of files stays under it.
 */
const MAX_INLINE_TOTAL = 5 * 1024 * 1024;

function mimeOf(path) {
  return /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';
}

/** Text first (paths, then the report), then the pictures that fit. */
function captureContent(meta, includeImage) {
  const content = [{ type: 'text', text: `${header(meta)}\n\n${meta.markdown}` }];
  if (!includeImage) return content;
  const notes = [];
  let budget = MAX_INLINE_TOTAL;
  const attach = (path, mimeType) => {
    const size = fileSize(path);
    if (size > MAX_INLINE_BYTES || size > budget) return false;
    budget -= size;
    content.push({ type: 'image', data: readBase64(path), mimeType });
    return true;
  };
  if (meta.slices?.length) {
    let shown = 0;
    for (const slice of meta.slices.slice(0, MAX_SLICES_INLINE)) {
      if (!attach(slice.path, mimeOf(slice.path))) break;
      shown += 1;
    }
    if (shown < meta.slices.length) {
      notes.push(`Showing the first ${shown} of ${meta.slices.length} slices; the rest are at the paths above.`);
    }
  } else if ((meta.imageHeight ?? 0) > MAX_INLINE_HEIGHT || !attach(meta.imagePath, meta.imageMime || mimeOf(meta.imagePath))) {
    notes.push('The image is too large to attach here; read it from the path above.');
  }
  if (meta.changesPath && fileSize(meta.changesPath) <= Math.min(MAX_INLINE_BYTES, budget)) {
    content.push({ type: 'text', text: 'What changed since the last capture of this page (changed areas outlined):' });
    content.push({ type: 'image', data: readBase64(meta.changesPath), mimeType: 'image/png' });
  }
  if (notes.length) content.push({ type: 'text', text: notes.join('\n') });
  return content;
}

function failure(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

export async function runMcpServer() {
  const client = createClient();
  const server = new McpServer({ name: 'capture-kit', version: '0.1.0' });

  server.registerTool(
    'get_latest_capture',
    {
      title: 'Latest capture',
      description:
        'The most recent Capture Kit capture from the user\'s Chrome: a full-page screenshot plus a report with the page\'s console errors, failed network requests (secrets redacted), source-mapped stack lines, and - when the page was captured before - what changed since then. Use after the user says they captured something, or to see the page they are looking at.',
      inputSchema: z.object({
        include_image: z.boolean().optional().describe('Attach the screenshot (default true). Set false to get just the report text.'),
      }),
    },
    async ({ include_image }) => {
      const r = await client.latest();
      if (!r.ok) return failure(r.error === 'no captures yet' ? 'No captures yet. Ask the user to press Cmd/Ctrl+Shift+9 in Chrome, or use capture_tab.' : r.error);
      return { content: captureContent(r.capture, include_image !== false) };
    },
  );

  server.registerTool(
    'get_capture',
    {
      title: 'Capture by id',
      description: 'One earlier capture by its id (from list_captures).',
      inputSchema: z.object({ id: z.string(), include_image: z.boolean().optional() }),
    },
    async ({ id, include_image }) => {
      const r = await client.get(id);
      return r.ok ? { content: captureContent(r.capture, include_image !== false) } : failure(r.error);
    },
  );

  server.registerTool(
    'list_captures',
    {
      title: 'Recent captures',
      description: 'Recent captures, newest first: id, time, page, and how many errors and failed requests each found.',
      inputSchema: z.object({ limit: z.number().int().min(1).max(50).optional() }),
    },
    async ({ limit }) => {
      const r = await client.list(limit ?? 10);
      if (!r.ok) return failure(r.error);
      const text = r.captures.length ? r.captures.map(listLine).join('\n') : 'No captures yet.';
      return { content: [{ type: 'text', text }] };
    },
  );

  server.registerTool(
    'capture_tab',
    {
      title: 'Capture a tab',
      description:
        'Ask Capture Kit to capture a tab in the user\'s Chrome now and return the result. Only works if the user has allowed agent captures in Capture Kit\'s settings, and only for the sites they allowed. Use list_tabs to see which tabs can be captured. Set scroll for apps that only draw what is on screen (canvas apps, panels that scroll on their own).',
      inputSchema: z.object({
        url_contains: z.string().optional().describe('Part of the tab\'s address, e.g. "localhost:3000/settings". Omit to capture the tab in front.'),
        scroll: z.boolean().optional().describe('Scroll and stitch instead of rendering the page tall.'),
        include_image: z.boolean().optional(),
      }),
    },
    async ({ url_contains, scroll, include_image }) => {
      const r = await client.capture({ urlContains: url_contains, scroll: scroll === true });
      return r.ok ? { content: captureContent(r.capture, include_image !== false) } : failure(r.error);
    },
  );

  server.registerTool(
    'wait_for_capture',
    {
      title: 'Wait for the user to capture',
      description:
        'Wait until the user takes their next capture in Chrome, then return it. Use when you have asked the user to reproduce something and press Cmd/Ctrl+Shift+9.',
      inputSchema: z.object({
        timeout_seconds: z.number().int().min(5).max(900).optional().describe('How long to wait (default 300).'),
        include_image: z.boolean().optional(),
      }),
    },
    async ({ timeout_seconds, include_image }) => {
      const r = await client.wait(timeout_seconds ?? 300);
      return r.ok ? { content: captureContent(r.capture, include_image !== false) } : failure(r.error);
    },
  );

  server.registerTool(
    'list_tabs',
    {
      title: 'Tabs that can be captured',
      description: 'Tabs in the user\'s Chrome that agents are allowed to capture (only sites the user allowed).',
      inputSchema: z.object({}),
    },
    async () => {
      const r = await client.tabs();
      if (!r.ok) return failure(r.error);
      const text = r.tabs.length
        ? r.tabs.map((t) => `${t.active ? '* ' : '  '}${t.title || '(untitled)'} - ${t.url}`).join('\n')
        : 'No open tabs on allowed sites.';
      return { content: [{ type: 'text', text }] };
    },
  );

  await server.connect(new StdioServerTransport());
}
