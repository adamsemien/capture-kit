#!/usr/bin/env node
// Runs the helper in the foreground. Started for you by ck and the MCP server.
import { loadConfig } from './config.mjs';
import { startDaemon } from './daemon.mjs';

const { port, token } = loadConfig();
const verbose = process.argv.includes('--verbose');
const daemon = startDaemon({ port, token, log: verbose ? (m) => console.error(`[capture-kit] ${m}`) : () => {} });
daemon.ready.then(
  () => {
    if (verbose) console.error(`[capture-kit] helper listening on 127.0.0.1:${port}`);
  },
  (error) => {
    console.error(`[capture-kit] could not listen on 127.0.0.1:${port}: ${error.message}`);
    process.exit(1);
  },
);
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { daemon.close(); process.exit(0); });
