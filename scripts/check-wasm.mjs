#!/usr/bin/env node
// Recomputes the sha256 of contracts/receipts.wasm and compares it with contracts/SHA256SUMS.
// Exit 0: they match. Exit 1: mismatch or unreadable sums. Exit 0 with a printed [skip]: no wasm
// has been built yet (a skip is not a pass; checkWasm() reports ok:false, skipped:true).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTRACTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts');
const WASM_NAME = 'receipts.wasm';

/** → { ok, sha256, expected, why, skipped? }. ok is true only when the wasm exists and matches. */
export function checkWasm({ dir = CONTRACTS_DIR } = {}) {
  const wasmPath = join(dir, WASM_NAME);
  const sumsPath = join(dir, 'SHA256SUMS');
  if (!existsSync(wasmPath)) {
    return { ok: false, skipped: true, sha256: null, expected: null, why: `no wasm yet: ${WASM_NAME} has not been built` };
  }
  const sha256 = createHash('sha256').update(readFileSync(wasmPath)).digest('hex');
  if (!existsSync(sumsPath)) return { ok: false, sha256, expected: null, why: 'SHA256SUMS is missing' };
  const line = readFileSync(sumsPath, 'utf8')
    .split('\n')
    .map((l) => /^([0-9a-f]{64}) [ *](.+)$/.exec(l.trim()))
    .find((m) => m && m[2] === WASM_NAME);
  if (!line) return { ok: false, sha256, expected: null, why: `SHA256SUMS has no line for ${WASM_NAME}` };
  const expected = line[1];
  if (sha256 !== expected) return { ok: false, sha256, expected, why: `${WASM_NAME} does not match SHA256SUMS` };
  return { ok: true, sha256, expected, why: `${WASM_NAME} matches SHA256SUMS` };
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (runDirectly) {
  const result = checkWasm();
  // --require (used in CI): a missing wasm is a failure there, not a skip
  if (result.skipped && process.argv.includes('--require')) { console.log(`[fail] ${result.why}`); process.exitCode = 1; }
  else if (result.skipped) console.log(`[skip] ${result.why}`);
  else if (result.ok) console.log(`[ok] ${result.why}: ${result.sha256}`);
  else {
    console.log(`[fail] ${result.why}\n  computed ${result.sha256}\n  expected ${result.expected}`);
    process.exitCode = 1;
  }
}
