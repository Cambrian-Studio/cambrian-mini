// The committed wasm, its checksum file and the code hash a judge would read from the chain agree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { base58Decode, wasmCodeHash } from '../../near/rpc.mjs';
import { checkWasm } from '../../scripts/check-wasm.mjs';

const CONTRACTS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'contracts');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'baby-cambrian-wasm-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('checkWasm: matching sums pass, a changed wasm fails, a missing sums file fails', (t) => {
  const dir = scratch(t);
  const bytes = Buffer.from('0061736d01000000', 'hex');
  const sha = createHash('sha256').update(bytes).digest('hex');
  writeFileSync(join(dir, 'receipts.wasm'), bytes);

  assert.equal(checkWasm({ dir }).ok, false, 'no SHA256SUMS yet');
  assert.match(checkWasm({ dir }).why, /SHA256SUMS is missing/);

  writeFileSync(join(dir, 'SHA256SUMS'), `${sha}  receipts.wasm\n`);
  assert.deepEqual(checkWasm({ dir }), { ok: true, sha256: sha, expected: sha, why: 'receipts.wasm matches SHA256SUMS' });

  writeFileSync(join(dir, 'receipts.wasm'), Buffer.concat([bytes, Buffer.from([0])]));
  const changed = checkWasm({ dir });
  assert.equal(changed.ok, false);
  assert.equal(changed.expected, sha);
  assert.notEqual(changed.sha256, sha);
  assert.match(changed.why, /does not match/);

  writeFileSync(join(dir, 'SHA256SUMS'), `${sha}  other.wasm\n`);
  assert.match(checkWasm({ dir }).why, /no line for receipts\.wasm/);
});

test('checkWasm: no wasm yet is a skip, never a pass', (t) => {
  const result = checkWasm({ dir: scratch(t) });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.match(result.why, /no wasm yet/);
});

test('the committed wasm matches SHA256SUMS, and its code hash is that sha256 in base58', (t) => {
  if (!existsSync(join(CONTRACTS, 'receipts.wasm'))) return t.skip('contracts/receipts.wasm has not been built');
  const result = checkWasm();
  assert.equal(result.ok, true, result.why);
  const wasm = readFileSync(join(CONTRACTS, 'receipts.wasm'));
  assert.equal(Buffer.from(wasm.subarray(0, 4)).toString('hex'), '0061736d', 'a wasm module');
  assert.equal(Buffer.from(base58Decode(wasmCodeHash(wasm))).toString('hex'), result.sha256);
});
