// Where the bridge keeps its state, and the pairing code.
//
// ~/.capture-kit/bridge.json holds the port and a random pairing code. The
// folder is readable by you only (0700) and the file likewise (0600). The
// same code is pasted once into Capture Kit's settings; without it the
// extension's connection is refused, and so is every request from ck or the
// MCP server.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_PORT = 47823;

export function homeDir() {
  return process.env.CAPTURE_KIT_HOME ?? join(homedir(), '.capture-kit');
}

export function capturesDir() {
  return join(homeDir(), 'captures');
}

function configPath() {
  return join(homeDir(), 'bridge.json');
}

/** Reads the config, creating it (with a fresh pairing code) the first time. */
export function loadConfig() {
  const dir = homeDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    /* not ours to fix on every platform */
  }
  const path = configPath();
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed.token === 'string' && parsed.token.length >= 32) {
      const port = Number(process.env.CAPTURE_KIT_PORT ?? parsed.port ?? DEFAULT_PORT);
      return { port, token: parsed.token, path };
    }
  }
  const config = { port: DEFAULT_PORT, token: randomBytes(32).toString('base64url') };
  writeFileSync(path, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  chmodSync(path, 0o600);
  return { port: Number(process.env.CAPTURE_KIT_PORT ?? config.port), token: config.token, path };
}

/** Constant-time comparison, so the code cannot be guessed a character at a time. */
export function tokenMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
