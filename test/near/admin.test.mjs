// The set-up transactions, checked against near-api-js's published multi-action vector
// (@near-js/transactions, serialize.test.ts): the same bytes for deploy, add-key and delete-key.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import { encodeDeployContract, encodeAddFunctionCallKey, encodeDeleteKey, signSelfTransaction } from '../../near/admin.mjs';
import { base58Encode } from '../../near/rpc.mjs';
import { verifySignature, transactionHash } from '../../near/record.mjs';

const hex = (b) => Buffer.from(b).toString('hex');
// the PUBLIC key used in that published vector (written in two halves so a secret scanner does not mistake it for one)
const KEY_HEX = ['0f56a5f028dfc089ec7c39c1183b321b', '4d8f89ba5bec9e1762803cc2491f6ef8'].join('');
const KEY = `ed25519:${base58Encode(Buffer.from(KEY_HEX, 'hex'))}`;
// the three actions as they appear in the published vector
const DEPLOY = '0103000000010203';
const ADD_KEY = `0500${KEY_HEX}00000000000000000000030000007a7a7a0100000003000000777777`;
const DELETE_KEY = `0600${KEY_HEX}`;

test('DeployContract equals the published bytes, and carries the code it was given', () => {
  assert.equal(hex(encodeDeployContract(Uint8Array.of(1, 2, 3))), DEPLOY);
  assert.notEqual(hex(encodeDeployContract(Uint8Array.of(1, 2, 4))), DEPLOY);
});

test('AddKey of a function-call key equals the published bytes; receiver, methods and allowance all matter', () => {
  const base = { publicKey: KEY, receiverId: 'zzz', methodNames: ['www'], allowance: null };
  assert.equal(hex(encodeAddFunctionCallKey(base)), ADD_KEY);
  for (const change of [{ receiverId: 'zzy' }, { methodNames: ['wwx'] }, { methodNames: ['www', 'other'] }, { allowance: 1n }]) {
    assert.notEqual(hex(encodeAddFunctionCallKey({ ...base, ...change })), ADD_KEY, JSON.stringify(change, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
  }
  // permission tag 0 is FunctionCall; a full-access key (tag 1) cannot be produced by this module at all
  assert.equal(hex(encodeAddFunctionCallKey(base)).slice(2 + 2 + 64 + 16, 2 + 2 + 64 + 16 + 2), '00');
  assert.throws(() => encodeAddFunctionCallKey({ ...base, methodNames: [] }), /at least one method/);
});

test('DeleteKey equals the published bytes', () => {
  assert.equal(hex(encodeDeleteKey(KEY)), DELETE_KEY);
});

test('a self-transaction is signed by the given key over the sha256 of its bytes', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');   // throwaway, in memory only
  const pub = `ed25519:${base58Encode(publicKey.export({ format: 'der', type: 'spki' }).subarray(-32))}`;
  const key = { publicKey: pub, sign: (m) => Uint8Array.from(nodeSign(null, Buffer.from(m), privateKey)) };
  const account = 'a'.repeat(64);
  const t = signSelfTransaction({ accountId: account, key, nonce: 7n, blockHash: base58Encode(Buffer.alloc(32, 9)), action: encodeDeleteKey(pub) });
  assert.equal(t.hash, base58Encode(transactionHash(t.bytes)));
  const signature = t.signedBytes.slice(-64);
  assert.equal(verifySignature({ publicKey: pub, message: transactionHash(t.bytes), signature }), true);
  const other = signSelfTransaction({ accountId: account, key, nonce: 8n, blockHash: base58Encode(Buffer.alloc(32, 9)), action: encodeDeleteKey(pub) });
  assert.notEqual(other.hash, t.hash);
});
