import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, verify } from 'node:crypto';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_GAS,
  MAINNET_FLAG,
  buildRecordTransaction,
  checkAccessKeyPermission,
  encodeFunctionCall,
  encodeSignedTransaction,
  encodeTransaction,
  loadKeyFile,
  parseSecretKey,
  runCli,
  signRecordTransaction,
  transactionHash,
  verifySignature,
} from '../../near/record.mjs';
import { base58Decode, base58Encode, receiptEventLine } from '../../near/rpc.mjs';
import { stubRpc } from './rpc-stub.test.mjs';

const hex = (bytes) => Buffer.from(bytes).toString('hex');
const HASH = '9f86d081884c7d659a2feae0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const BLOCK_HASH = '244ZQ9cgj3CQ6bWBdytfrJMuMQ1jdXLFGnr4HhvtCTnM';

// ---- known-good vectors ------------------------------------------------------------------------
// From near-api-js, packages/transactions/test/serialize.test.ts at tag @near-js/transactions@1.3.0
// (github.com/near/near-api-js). Only public values are copied: serialized bytes, public keys, the
// expected hash and one published signature. No secret key is needed to check them.

// 'serialize transfer tx': test.near → whatever.near, nonce 1, one Transfer of 1 yocto.
const TRANSFER_TX_HEX =
  '09000000746573742e6e65617200917b3d268d4b58f7fec1b150bd68d69be3ee5d4cc39855e341538465bb77860d' +
  '01000000000000000d00000077686174657665722e6e6561720fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef6' +
  '010000000301000000000000000000000000000000';
const TRANSFER_PUBLIC_KEY = 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC';
// 'serialize and sign transfer tx': the signature near-api-js expects for that transaction.
const TRANSFER_SIGNATURE_B64 = 'lpqDMyGG7pdV5IOTJVJYBuGJo9LSu0tHYOlEQ+l+HE8i3u7wBZqOlxMQDtpuGRRNp+ig735TmyBwi6HY0CG9AQ==';
const TRANSFER_SIGNED_HEX =
  `${TRANSFER_TX_HEX}00969a83332186ee9755e4839325525806e189a3d2d2bb4b4760e94443e97e1c4f` +
  '22deeef0059a8e9713100eda6e19144da7e8a0ef7e539b20708ba1d8d021bd01';

// 'serialize and sign multi-action tx': eight actions; the third is functionCall('qqq', [1,2,3], 1000n, 1000000n).
const MULTI_HEADER_HEX =
  '09000000746573742e6e656172000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef8' +
  '0100000000000000030000003132330fa473fd26901df296be6adc4cc4df34d040efa2435224b6986910e630c2fef608000000';
const MULTI_ACTIONS_HEX = [
  '00',
  '0103000000010203',
  '020300000071717103000000010203e80300000000000040420f00000000000000000000000000',
  '037b000000000000000000000000000000',
  '0440420f00000000000000000000000000000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef8',
  '05000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef800000000000000000000030000007a7a7a0100000003000000777777',
  '06000f56a5f028dfc089ec7c39c1183b321b4d8f89ba5bec9e1762803cc2491f6ef8',
  '0703000000313233',
];
const MULTI_TX_HEX = MULTI_HEADER_HEX + MULTI_ACTIONS_HEX.join('');
const MULTI_TX_HASH = 'Fo3MJ9XzKjnKuDuQKhDAC6fra5H2UWawRejFSEpPNk3Y';

test('borsh: the transaction framing equals the near-api-js transfer vector', () => {
  const transferAction = Buffer.from('0301000000000000000000000000000000', 'hex'); // tag 3 + u128 1, from the vector
  const bytes = encodeTransaction({
    signerId: 'test.near',
    publicKey: TRANSFER_PUBLIC_KEY,
    nonce: 1n,
    receiverId: 'whatever.near',
    blockHash: base58Decode(BLOCK_HASH),
    actionBytes: [transferAction],
  });
  assert.equal(hex(bytes), TRANSFER_TX_HEX);

  // The other direction: any changed field changes the bytes.
  const other = encodeTransaction({
    signerId: 'test.near',
    publicKey: TRANSFER_PUBLIC_KEY,
    nonce: 2n,
    receiverId: 'whatever.near',
    blockHash: base58Decode(BLOCK_HASH),
    actionBytes: [transferAction],
  });
  assert.notEqual(hex(other), TRANSFER_TX_HEX);
});

test('borsh: a FunctionCall action equals the one inside the near-api-js multi-action vector', () => {
  const action = encodeFunctionCall({ methodName: 'qqq', args: Uint8Array.of(1, 2, 3), gas: 1000n, deposit: 1000000n });
  assert.equal(hex(action), MULTI_ACTIONS_HEX[2]);
  const changed = encodeFunctionCall({ methodName: 'qqq', args: Uint8Array.of(1, 2, 3), gas: 1001n, deposit: 1000000n });
  assert.notEqual(hex(changed), MULTI_ACTIONS_HEX[2]);
});

test('borsh + hash: the multi-action vector reassembles byte for byte and hashes to the published tx hash', () => {
  const actionBytes = MULTI_ACTIONS_HEX.map((h) => Buffer.from(h, 'hex'));
  actionBytes[2] = encodeFunctionCall({ methodName: 'qqq', args: Uint8Array.of(1, 2, 3), gas: 1000n, deposit: 1000000n });
  const publicKey = `ed25519:${base58Encode(Buffer.from(MULTI_HEADER_HEX.slice(28, 92), 'hex'))}`;
  const bytes = encodeTransaction({
    signerId: 'test.near',
    publicKey,
    nonce: 1n,
    receiverId: '123',
    blockHash: base58Decode(BLOCK_HASH),
    actionBytes,
  });
  assert.equal(hex(bytes), MULTI_TX_HEX);
  assert.equal(base58Encode(transactionHash(bytes)), MULTI_TX_HASH);
});

test('signature framing: the published signature verifies over our hash and frames to the signed vector', () => {
  const txBytes = Buffer.from(TRANSFER_TX_HEX, 'hex');
  const signature = Buffer.from(TRANSFER_SIGNATURE_B64, 'base64');
  const message = transactionHash(txBytes);
  assert.equal(verifySignature({ publicKey: TRANSFER_PUBLIC_KEY, message, signature }), true);
  assert.equal(hex(encodeSignedTransaction(txBytes, signature)), TRANSFER_SIGNED_HEX);

  const wrongMessage = transactionHash(Buffer.concat([txBytes, Buffer.from([0])]));
  assert.equal(verifySignature({ publicKey: TRANSFER_PUBLIC_KEY, message: wrongMessage, signature }), false);
  assert.throws(() => encodeSignedTransaction(txBytes, signature.subarray(1)), /64 bytes/);
});

// ---- throwaway keys ----------------------------------------------------------------------------

/** A fresh in-memory ed25519 key in NEAR's text form. Never written to disk. */
function throwawayKey() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const seed = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);
  const pub = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return {
    nodePublicKey: publicKey,
    secret: `ed25519:${base58Encode(Buffer.concat([seed, pub]))}`,
    publicKey: `ed25519:${base58Encode(pub)}`,
    seedOnly: `ed25519:${base58Encode(seed)}`,
    wrongPair: `ed25519:${base58Encode(Buffer.concat([seed, Buffer.alloc(32, 7)]))}`,
  };
}

test('signing: a throwaway key signs the transaction hash and node:crypto verifies it', () => {
  const k = throwawayKey();
  const key = parseSecretKey(k.secret);
  assert.equal(key.publicKey, k.publicKey);
  assert.equal(parseSecretKey(k.seedOnly).publicKey, k.publicKey);
  assert.equal(parseSecretKey(JSON.stringify({ account_id: 'line.testnet', private_key: k.secret })).accountId, 'line.testnet');

  const tx = buildRecordTransaction({
    signerId: 'line.testnet',
    publicKey: key.publicKey,
    contractId: 'receipts.testnet',
    hash: HASH,
    nonce: 8n,
    blockHash: BLOCK_HASH,
  });
  const { signature, signedBytes } = signRecordTransaction(tx, key);
  const digest = createHash('sha256').update(tx.bytes).digest();
  assert.equal(verify(null, digest, k.nodePublicKey, Buffer.from(signature)), true);
  assert.equal(hex(signedBytes), `${hex(tx.bytes)}00${hex(signature)}`);

  const otherKey = throwawayKey();
  assert.equal(verify(null, digest, otherKey.nodePublicKey, Buffer.from(signature)), false);
  assert.equal(verify(null, createHash('sha256').update('other').digest(), k.nodePublicKey, Buffer.from(signature)), false);
});

test('parseSecretKey refuses a mismatched pair, another curve and junk', () => {
  const k = throwawayKey();
  assert.throws(() => parseSecretKey(k.wrongPair), /inconsistent/);
  assert.throws(() => parseSecretKey(k.secret.replace('ed25519', 'secp256k1')), /not an ed25519 NEAR key/);
  assert.throws(() => parseSecretKey('hello'), /not an ed25519 NEAR key/);
  assert.throws(() => parseSecretKey('ed25519:abc'), /not an ed25519 NEAR key/);
});

test('buildRecordTransaction: exactly one FunctionCall record_receipt, args = the 32 raw hash bytes, deposit 0', () => {
  const k = throwawayKey();
  const base = { signerId: 'line.testnet', publicKey: k.publicKey, contractId: 'receipts.testnet', nonce: 8n, blockHash: BLOCK_HASH };
  const tx = buildRecordTransaction({ ...base, hash: HASH });
  const args = Buffer.from(HASH, 'hex');
  assert.equal(args.length, 32);
  const expected = encodeTransaction({
    signerId: 'line.testnet',
    publicKey: k.publicKey,
    nonce: 8n,
    receiverId: 'receipts.testnet',
    blockHash: base58Decode(BLOCK_HASH),
    actionBytes: [encodeFunctionCall({ methodName: 'record_receipt', args, gas: DEFAULT_GAS, deposit: 0n })],
  });
  assert.equal(hex(tx.bytes), hex(expected));
  assert.equal(tx.hash, base58Encode(createHash('sha256').update(expected).digest()));
  assert.deepEqual(tx.summary.actions, [
    { FunctionCall: { method_name: 'record_receipt', args: args.toString('base64'), gas: '30000000000000', deposit: '0' } },
  ]);

  // Read the action back out of the bytes: tag 2, the method name, then u32 32 and the raw hash,
  // u64 gas, and sixteen zero bytes of deposit at the very end. No JSON, no hex text.
  const tail = Buffer.from(tx.bytes).subarray(-(1 + 4 + 14 + 4 + 32 + 8 + 16));
  assert.equal(tail[0], 2);
  assert.equal(tail.readUInt32LE(1), 14);
  assert.equal(tail.subarray(5, 19).toString('utf8'), 'record_receipt');
  assert.equal(tail.readUInt32LE(19), 32);
  assert.equal(hex(tail.subarray(23, 55)), HASH);
  assert.equal(tail.readBigUInt64LE(55), DEFAULT_GAS);
  assert.equal(hex(tail.subarray(63)), '00'.repeat(16));
  assert.equal(Buffer.from(tx.bytes).includes(Buffer.from(HASH, 'utf8')), false, 'the hex text is not in the transaction');

  // The other direction: another hash gives other args and another transaction hash.
  const other = buildRecordTransaction({ ...base, hash: HASH.replace('9f', '8f') });
  assert.notEqual(other.hash, tx.hash);

  assert.throws(() => buildRecordTransaction({ ...base, hash: HASH.toUpperCase() }), /64 lowercase hex/);
  assert.throws(() => buildRecordTransaction({ ...base, hash: HASH.slice(2) }), /64 lowercase hex/);
  assert.throws(() => buildRecordTransaction({ ...base, hash: HASH, contractId: 'Bad Account' }), /not a NEAR account id/);
});

test('access key check: only a function-call key for this contract and record_receipt alone passes', () => {
  const contractId = 'receipts.testnet';
  const fc = (over) => ({
    FunctionCall: { allowance: '250000000000000000000000', receiver_id: contractId, method_names: ['record_receipt'], ...over },
  });

  assert.deepEqual(checkAccessKeyPermission(fc(), { contractId }), { ok: true, allowance: '250000000000000000000000' });

  const full = checkAccessKeyPermission('FullAccess', { contractId });
  assert.equal(full.ok, false);
  assert.match(full.why, /FullAccess/);
  assert.match(checkAccessKeyPermission(fc({ receiver_id: 'other.testnet' }), { contractId }).why, /is for contract other\.testnet/);
  assert.match(checkAccessKeyPermission(fc({ method_names: [] }), { contractId }).why, /any method/);
  assert.match(checkAccessKeyPermission(fc({ method_names: ['record_receipt', 'add_recorder'] }), { contractId }).why, /limited to/);
  assert.match(checkAccessKeyPermission(fc({ method_names: ['add_recorder'] }), { contractId }).why, /limited to/);
  assert.equal(checkAccessKeyPermission(undefined, { contractId }).ok, false);
  assert.equal(checkAccessKeyPermission({ Something: {} }, { contractId }).ok, false);
});

// ---- key file ----------------------------------------------------------------------------------

test('loadKeyFile: a real file must be mode 600 (no key is written to disk here)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-keyfile-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'placeholder.txt');
  writeFileSync(path, 'this is not a key\n');

  for (const mode of [0o644, 0o640, 0o604, 0o700, 0o666]) {
    chmodSync(path, mode);
    const refused = loadKeyFile(path);
    assert.equal(refused.ok, false);
    assert.match(refused.why, new RegExp(`is mode ${mode.toString(8)}; it must be 600`));
  }
  // Mode 600 gets past the mode check; the placeholder is then refused for not being a key.
  chmodSync(path, 0o600);
  const parsed = loadKeyFile(path);
  assert.equal(parsed.ok, false);
  assert.match(parsed.why, /not an ed25519 NEAR key/);

  assert.match(loadKeyFile(join(dir, 'missing')).why, /cannot be read/);
  assert.match(loadKeyFile(dir).why, /not a regular file/);
});

// ---- the command -------------------------------------------------------------------------------

/** An in-memory key file: the throwaway key exists only in this object. */
function memoryFs(secretText, mode = 0o100600) {
  const written = [];
  return {
    written,
    statSync: () => ({ isFile: () => true, mode }),
    readFileSync: () => secretText,
    writeFileSync: (path, text) => written.push({ path, text }),
  };
}

/** What a node answers after a record_receipt call that ran: the contract's outcome carries `logs`. */
function committed(logs = [receiptEventLine(HASH)]) {
  return {
    status: { SuccessValue: '' },
    transaction: { hash: 'stubbed-tx-hash' },
    transaction_outcome: { block_hash: 'stubbed-block-hash', outcome: { receipt_ids: ['r1'] } },
    receipts_outcome: [{ id: 'r1', outcome: { executor_id: 'receipts.testnet', logs, status: { SuccessValue: '' } } }],
  };
}

function chain({ network = 'testnet', permission, nonce = 41, logs } = {}) {
  const sent = [];
  const stub = stubRpc({
    status: () => ({ result: { chain_id: network } }),
    'query:view_access_key': () => ({ result: { nonce, permission, block_hash: BLOCK_HASH, block_height: 5 } }),
    broadcast_tx_commit: (params) => {
      sent.push(Buffer.from(params[0], 'base64'));
      return { result: committed(logs) };
    },
  });
  return { ...stub, sent };
}

const RESTRICTED = {
  FunctionCall: { allowance: '250000000000000000000000', receiver_id: 'receipts.testnet', method_names: ['record_receipt'] },
};

function cliArgs(over = {}, extra = []) {
  const flags = {
    '--network': 'testnet',
    '--contract': 'receipts.testnet',
    '--signer': 'line.testnet',
    '--key-file': '/nowhere/key.json',
    '--hash': HASH,
    ...over,
  };
  const argv = [];
  for (const [flag, value] of Object.entries(flags)) if (value !== undefined) argv.push(flag, value);
  return [...argv, ...extra];
}

async function run(argv, { node, key = throwawayKey(), mode } = {}) {
  const lines = [];
  const fs = memoryFs(key.secret, mode);
  const code = await runCli(argv, {
    fetchImpl: node ? node.fetchImpl : async () => assert.fail('no request expected'),
    fs,
    out: (line) => lines.push(line),
    timeoutMs: 500,
    now: () => new Date('2026-01-02T03:04:05.000Z'),
  });
  return { code, text: lines.join('\n'), key, written: fs.written };
}

test('cli: refuses unless --network, --contract, --signer, --key-file (and --hash) are all given', async () => {
  for (const flag of ['--network', '--contract', '--signer', '--key-file', '--hash']) {
    const { code, text } = await run(cliArgs({ [flag]: undefined }));
    assert.equal(code, 2, flag);
    assert.match(text, new RegExp(`\\[refused\\] missing ${flag}`));
  }
  assert.equal((await run([])).code, 2);
  assert.match((await run(cliArgs({}, ['--send-everything']))).text, /unknown argument --send-everything/);
  assert.match((await run(cliArgs({ '--network': 'betanet' }))).text, /must be mainnet or testnet/);
  assert.match((await run(cliArgs({ '--hash': HASH.toUpperCase() }))).text, /64 lowercase hex/);
});

test('cli: refuses a key file that is not mode 600 before any request', async () => {
  const { code, text } = await run(cliArgs(), { mode: 0o100644 });
  assert.equal(code, 2);
  assert.match(text, /is mode 644; it must be 600/);
});

test('cli: refuses mainnet without the human flag, with no request made; with the flag it goes on', async () => {
  const refused = await run(cliArgs({ '--network': 'mainnet', '--contract': 'receipts.near', '--signer': 'line.near' }));
  assert.equal(refused.code, 2);
  assert.match(refused.text, /mainnet needs a human/);

  const node = chain({ network: 'mainnet', permission: { FunctionCall: { ...RESTRICTED.FunctionCall, receiver_id: 'receipts.near' } } });
  const argv = cliArgs({ '--network': 'mainnet', '--contract': 'receipts.near', '--signer': 'line.near' }, [MAINNET_FLAG, '--dry-run']);
  const allowed = await run(argv, { node });
  assert.equal(allowed.code, 0, allowed.text);
  assert.equal(node.sent.length, 0);
});

test('cli: refuses when the node serves another chain than --network', async () => {
  const node = chain({ network: 'mainnet', permission: RESTRICTED });
  const { code, text } = await run(cliArgs(), { node });
  assert.equal(code, 2);
  assert.match(text, /serves chain "mainnet", not "testnet"/);
  assert.equal(node.sent.length, 0);
});

test('cli: refuses a FullAccess key and a key for other methods or contracts; nothing is sent', async () => {
  const cases = [
    ['FullAccess', /FullAccess key/],
    [{ FunctionCall: { ...RESTRICTED.FunctionCall, method_names: [] } }, /any method/],
    [{ FunctionCall: { ...RESTRICTED.FunctionCall, method_names: ['record_receipt', 'add_recorder'] } }, /limited to record_receipt only/],
    [{ FunctionCall: { ...RESTRICTED.FunctionCall, receiver_id: 'elsewhere.testnet' } }, /is for contract elsewhere\.testnet/],
  ];
  for (const [permission, why] of cases) {
    const node = chain({ permission });
    const { code, text } = await run(cliArgs(), { node });
    assert.equal(code, 2);
    assert.match(text, why);
    assert.equal(node.sent.length, 0);
    assert.equal(node.calls.some((c) => c.method === 'broadcast_tx_commit'), false);
  }
});

test('cli: refuses a key file that belongs to another account', async () => {
  const k = throwawayKey();
  const key = { ...k, secret: JSON.stringify({ account_id: 'someone-else.testnet', private_key: k.secret }) };
  const { code, text } = await run(cliArgs(), { key });
  assert.equal(code, 2);
  assert.match(text, /belongs to someone-else\.testnet/);
});

test('cli --dry-run: prints the unsigned transaction and its hash, sends nothing, prints no secret', async () => {
  const node = chain({ permission: RESTRICTED, nonce: 41 });
  const { code, text, key } = await run(cliArgs({}, ['--dry-run']), { node });
  assert.equal(code, 0, text);
  assert.equal(node.sent.length, 0);
  assert.deepEqual(node.calls.map((c) => (c.method === 'query' ? c.params.request_type : c.method)), ['status', 'view_access_key']);
  assert.equal(node.calls[1].params.account_id, 'line.testnet');
  assert.equal(node.calls[1].params.public_key, key.publicKey);

  const expected = buildRecordTransaction({
    signerId: 'line.testnet',
    publicKey: key.publicKey,
    contractId: 'receipts.testnet',
    hash: HASH,
    nonce: 42n,
    blockHash: BLOCK_HASH,
  });
  assert.ok(text.includes(`unsigned     ${Buffer.from(expected.bytes).toString('base64')}`));
  assert.ok(text.includes(`tx hash      ${expected.hash}`));
  assert.match(text, /"nonce": "42"/);
  assert.ok(text.includes(`"args": "${Buffer.from(HASH, 'hex').toString('base64')}"`), 'args shown as base64 of the 32 bytes');
  assert.match(text, /"deposit": "0"/);
  assert.match(text, /\[dry-run\] nothing was signed, nothing was sent/);
  assert.equal(text.includes(key.secret.slice(8)), false, 'the secret is never printed');
});

test('cli: with a restricted key it sends exactly one signed record_receipt transaction (to the stub node)', async () => {
  const node = chain({ permission: RESTRICTED, nonce: 41 });
  const { code, text, key } = await run(cliArgs(), { node });
  assert.equal(code, 0, text);
  assert.match(text, /\[recorded\] receipt 9f86d081.* tx stubbed-tx-hash/);
  assert.equal(node.sent.length, 1);

  const signed = node.sent[0];
  const txBytes = signed.subarray(0, signed.length - 65);
  const expected = buildRecordTransaction({
    signerId: 'line.testnet',
    publicKey: key.publicKey,
    contractId: 'receipts.testnet',
    hash: HASH,
    nonce: 42n,
    blockHash: BLOCK_HASH,
  });
  assert.equal(hex(txBytes), hex(expected.bytes));
  assert.equal(signed[signed.length - 65], 0, 'ed25519 signature tag');
  const digest = createHash('sha256').update(txBytes).digest();
  assert.equal(verify(null, digest, key.nodePublicKey, signed.subarray(-64)), true);
  assert.equal(text.includes(key.secret.slice(8)), false, 'the secret is never printed');
});

test('cli: without --out no file is written; with --out the record is written after success only', async () => {
  const plain = await run(cliArgs(), { node: chain({ permission: RESTRICTED }) });
  assert.equal(plain.code, 0, plain.text);
  assert.deepEqual(plain.written, []);

  const withOut = await run(cliArgs({ '--out': 'runs/7/onchain.json' }), { node: chain({ permission: RESTRICTED }) });
  assert.equal(withOut.code, 0, withOut.text);
  assert.match(withOut.text, /\[written\] runs\/7\/onchain\.json/);
  assert.equal(withOut.written.length, 1);
  assert.equal(withOut.written[0].path, 'runs/7/onchain.json');
  assert.deepEqual(JSON.parse(withOut.written[0].text), {
    network: 'testnet',
    contract: 'receipts.testnet',
    signer: 'line.testnet',
    tx_hash: 'stubbed-tx-hash',
    receipt_sha256: HASH,
    block_hash: 'stubbed-block-hash',
    recorded_at: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(withOut.written[0].text.includes(withOut.key.secret.slice(8)), false, 'no secret in the file');

  // Nothing is written by a dry run, a refusal, or a call that did not log the receipt.
  const dry = await run(cliArgs({ '--out': 'x.json' }, ['--dry-run']), { node: chain({ permission: RESTRICTED }) });
  assert.deepEqual([dry.code, dry.written], [0, []]);
  const refused = await run(cliArgs({ '--out': 'x.json' }), { node: chain({ permission: 'FullAccess' }) });
  assert.deepEqual([refused.code, refused.written], [2, []]);
  const silent = await run(cliArgs({ '--out': 'x.json' }), { node: chain({ permission: RESTRICTED, logs: [] }) });
  assert.deepEqual([silent.code, silent.written], [1, []]);
});

test('cli: a call that went through without the receipt event in its logs is reported as failed', async () => {
  for (const logs of [[], ['hello'], [receiptEventLine(HASH.replace('9f', '8f'))]]) {
    const { code, text } = await run(cliArgs(), { node: chain({ permission: RESTRICTED, logs }) });
    assert.equal(code, 1);
    assert.match(text, /\[failed\] the call went through but the receipt event is not in its logs/);
    assert.doesNotMatch(text, /\[recorded\]/);
  }
});

test('cli: an unreachable node is a printed [skip] with its own exit code; a chain failure is reported', async () => {
  const lines = [];
  const k = throwawayKey();
  const code = await runCli(cliArgs(), {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    fs: memoryFs(k.secret),
    out: (line) => lines.push(line),
  });
  assert.equal(code, 3);
  assert.match(lines.join('\n'), /^\[skip\] cannot reach .*Nothing was signed or sent\.$/);

  const failing = stubRpc({
    status: () => ({ result: { chain_id: 'testnet' } }),
    'query:view_access_key': () => ({ result: { nonce: 1, permission: RESTRICTED, block_hash: BLOCK_HASH } }),
    broadcast_tx_commit: () => ({
      result: { status: { Failure: { ActionError: { kind: 'Smart contract panicked: record_receipt: no deposit' } } }, transaction: {} },
    }),
  });
  const failed = await run(cliArgs(), { node: failing });
  assert.equal(failed.code, 1);
  assert.match(failed.text, /\[failed\] the transaction failed on chain: .*no deposit/);
});
