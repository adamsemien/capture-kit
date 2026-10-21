#!/usr/bin/env node
// ck - Capture Kit from the command line, for agents with a shell (Claude
// Code, Codex) and for people.
//
//   ck latest            the newest capture: file paths, then the report
//   ck list [-n 10]      recent captures
//   ck show <id>         one capture
//   ck wait [-t 300]     wait for your next capture, then print it
//   ck capture [match]   capture a tab now (needs agent captures turned on)
//   ck tabs              tabs agents may capture
//   ck pair              copy the pairing code for Capture Kit's settings
//   ck status            is the helper running, is Chrome connected
//   ck stop              stop the helper
//   ck mcp               run the MCP server on stdio
//
// Add --json to latest, list, show, wait or capture for machine-readable output.

import { spawn } from 'node:child_process';
import { createClient } from '../src/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { header, listLine } from '../src/format.mjs';

const args = process.argv.slice(2);
const command = args[0] ?? 'help';
const json = args.includes('--json');
const flag = (short, long) => {
  const i = args.findIndex((a) => a === short || a === long);
  return i === -1 ? undefined : args[i + 1];
};
const positional = args.slice(1).filter((a, i, all) => !a.startsWith('-') && !['-n', '--limit', '-t', '--timeout'].includes(all[i - 1]));

function out(text) {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function fail(message) {
  process.stderr.write(`ck: ${message}\n`);
  process.exit(1);
}

function printCapture(r) {
  if (!r.ok) fail(r.error);
  if (json) return out(JSON.stringify(r.capture, null, 2));
  const { markdown, ...meta } = r.capture;
  out(`${header(meta)}\n\n${markdown}`);
}

/** Puts the pairing code on the clipboard without it ever touching argv or the terminal. */
function copyToClipboard(text) {
  const tools =
    process.platform === 'darwin'
      ? [['pbcopy', []]]
      : process.platform === 'win32'
        ? [['clip', []]]
        : [['wl-copy', []], ['xclip', ['-selection', 'clipboard']], ['xsel', ['--clipboard', '--input']]];
  return new Promise((resolve) => {
    const tryNext = (i) => {
      if (i >= tools.length) return resolve(false);
      const [cmd, cmdArgs] = tools[i];
      const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => tryNext(i + 1));
      child.on('exit', (code) => (code === 0 ? resolve(true) : tryNext(i + 1)));
      child.stdin.end(text);
    };
    tryNext(0);
  });
}

const client = createClient();

switch (command) {
  case 'latest':
    printCapture(await client.latest());
    break;
  case 'show':
    if (!positional[0]) fail('usage: ck show <id>');
    printCapture(await client.get(positional[0]));
    break;
  case 'list': {
    const r = await client.list(Number(flag('-n', '--limit')) || 10);
    if (!r.ok) fail(r.error);
    if (json) out(JSON.stringify(r.captures, null, 2));
    else out(r.captures.length ? r.captures.map(listLine).join('\n') : 'No captures yet.');
    break;
  }
  case 'wait': {
    const seconds = Number(flag('-t', '--timeout')) || 300;
    if (!json) process.stderr.write(`Waiting up to ${seconds} s for your next capture (Cmd/Ctrl+Shift+9 in Chrome)…\n`);
    printCapture(await client.wait(seconds));
    break;
  }
  case 'capture':
    printCapture(await client.capture({ urlContains: positional[0], scroll: args.includes('--scroll') }));
    break;
  case 'tabs': {
    const r = await client.tabs();
    if (!r.ok) fail(r.error);
    out(r.tabs.length ? r.tabs.map((t) => `${t.active ? '* ' : '  '}${t.title || '(untitled)'} - ${t.url}`).join('\n') : 'No open tabs on allowed sites.');
    break;
  }
  case 'status': {
    const r = await client.status();
    if (!r.ok) fail(r.error);
    if (json) out(JSON.stringify(r, null, 2));
    else out([
      `Helper: running on 127.0.0.1:${client.port} (pid ${r.pid})`,
      `Chrome: ${r.connected ? `connected (Capture Kit ${r.extension?.version || ''})` : 'not connected - in Capture Kit\'s settings, turn on Agent bridge and paste the code from "ck pair". Chrome connects within a minute.'}`,
      `Captures kept: ${r.captures}`,
    ].join('\n'));
    break;
  }
  case 'pair': {
    const { token, path } = loadConfig();
    await client.ensureDaemon();
    if (await copyToClipboard(token)) {
      out([
        'Pairing code copied to your clipboard.',
        'In Chrome: Capture Kit icon → right-click → Options → Agent bridge → paste it into "Pairing code".',
        'Then check with: ck status',
      ].join('\n'));
    } else {
      out(`No clipboard tool found. Open ${path} and copy the "token" value into Capture Kit's settings (Agent bridge → Pairing code).`);
    }
    break;
  }
  case 'stop':
    await client.stop();
    out('Helper stopped.');
    break;
  case 'mcp': {
    const { runMcpServer } = await import('../src/mcp.mjs');
    await runMcpServer();
    break;
  }
  default:
    out([
      'ck - Capture Kit from the command line',
      '',
      '  ck latest            the newest capture: file paths, then the report',
      '  ck list [-n 10]      recent captures',
      '  ck show <id>         one capture',
      '  ck wait [-t 300]     wait for your next capture, then print it',
      '  ck capture [match] [--scroll]   capture a tab now (agent captures must be on)',
      '  ck tabs              tabs agents may capture',
      '  ck pair              copy the pairing code for Capture Kit\'s settings',
      '  ck status            is the helper running, is Chrome connected',
      '  ck stop              stop the helper',
      '  ck mcp               run the MCP server on stdio',
      '',
      'Add --json to latest, list, show, wait or capture for machine-readable output.',
    ].join('\n'));
}
