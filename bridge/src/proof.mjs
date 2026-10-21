// Proving you hold the pairing code without sending it (Codex review on #28).
//
// Every connection to the helper is a challenge and response both ways: each
// side picks a random nonce and the other answers with an HMAC of both nonces
// keyed by the pairing code. The helper proves itself first, so neither the
// extension nor ck nor the MCP server ever sends anything to a program that
// merely took the helper's port - on a computer shared with other accounts,
// one of them could listen there while the real helper is stopped. And
// because the code itself never crosses the connection, there is nothing to
// learn by listening.
//
// The roles are part of what is signed, so a proof made by one side can never
// be replayed as the other's.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function nonce() {
  return randomBytes(18).toString('base64url');
}

/** HMAC-SHA256 over "role|a|b", keyed by the pairing code, base64url. */
export function proof(token, role, a, b) {
  return createHmac('sha256', token).update(`${role}|${a}|${b}`).digest('base64url');
}

export function proofMatches(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string') return false;
  const x = Buffer.from(given);
  const y = Buffer.from(expected);
  return x.length === y.length && timingSafeEqual(x, y);
}
