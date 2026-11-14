import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  DEFAULT_RPC,
  NO_CONTRACT_CODE_HASH,
  base58Decode,
  base58Encode,
  compareCodeHash,
  contractCodeHash,
  receiptEventLine,
  rpcCall,
  rpcUrlFor,
  txStatus,
  viewCall,
  wasmCodeHash,
} from '../../near/rpc.mjs';
import { stubRpc, viewResult } from './rpc-stub.test.mjs';

const HASH = '9f86d081884c7d659a2feae0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const RPC = 'https://rpc.invalid';

test('base58: known values, leading zeros, round trip, bad characters refused', () => {
  assert.equal(base58Encode(Buffer.from('hello world')), 'StV1DL6CwTryKyV');
  assert.equal(base58Encode(new Uint8Array(32)), NO_CONTRACT_CODE_HASH);
  assert.equal(base58Encode(Uint8Array.of(0, 0, 1)), '112');
  assert.equal(base58Encode(new Uint8Array(0)), '');
  for (const hex of ['00', 'ff', '0000ff00', 'deadbeef', HASH]) {
    assert.equal(Buffer.from(base58Decode(base58Encode(Buffer.from(hex, 'hex')))).toString('hex'), hex);
  }
  assert.throws(() => base58Decode('0OIl'), /bad character/);
});

test('wasmCodeHash is the sha256 in base58, as view_account reports code_hash', () => {
  // sha256 of the empty input, a published constant in both encodings.
  assert.equal(createHash('sha256').update('').digest('hex'), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(wasmCodeHash(new Uint8Array(0)), 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn');
  assert.notEqual(wasmCodeHash(Uint8Array.of(0)), wasmCodeHash(new Uint8Array(0)));
});

test('network names map to public RPC urls; an unknown network throws', () => {
  assert.equal(rpcUrlFor('mainnet'), DEFAULT_RPC.mainnet);
  assert.equal(rpcUrlFor('testnet'), DEFAULT_RPC.testnet);
  assert.notEqual(DEFAULT_RPC.mainnet, DEFAULT_RPC.testnet);
  assert.throws(() => rpcUrlFor('betanet'), /unknown network/);
});

test('viewCall sends a call_function query with base64 JSON args and decodes the result bytes', async () => {
  const { fetchImpl, calls } = stubRpc({ 'query:call_function': () => viewResult({ n: 3, list: ['a'] }) });
  const answer = await viewCall({ rpcUrl: RPC, contractId: 'receipts.testnet', method: 'get_thing', args: { hash: HASH }, fetchImpl });
  assert.deepEqual(answer, { ok: true, value: { n: 3, list: ['a'] }, block_height: 77, block_hash: 'x', logs: [] });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, RPC);
  assert.equal(calls[0].jsonrpc, '2.0');
  assert.equal(calls[0].method, 'query');
  const p = calls[0].params;
  assert.equal(p.request_type, 'call_function');
  assert.equal(p.finality, 'final');
  assert.equal(p.account_id, 'receipts.testnet');
  assert.equal(p.method_name, 'get_thing');
  assert.deepEqual(JSON.parse(Buffer.from(p.args_base64, 'base64').toString('utf8')), { hash: HASH });
});

test('viewCall reports a node error, an in-result error and non-JSON bytes as ok:false, not offline', async () => {
  const rpcError = stubRpc({
    'query:call_function': () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, data: 'account missing' } }),
  });
  const a = await viewCall({ rpcUrl: RPC, contractId: 'nobody.testnet', method: 'm', fetchImpl: rpcError.fetchImpl });
  assert.equal(a.ok, false);
  assert.equal(a.offline, undefined);
  assert.match(a.why, /UNKNOWN_ACCOUNT: account missing/);

  const inResult = stubRpc({ 'query:call_function': () => ({ result: { error: 'wasm execution failed: MethodNotFound', logs: [] } }) });
  const b = await viewCall({ rpcUrl: RPC, contractId: 'c.testnet', method: 'm', fetchImpl: inResult.fetchImpl });
  assert.deepEqual(b, { ok: false, why: 'wasm execution failed: MethodNotFound' });

  const garbage = stubRpc({ 'query:call_function': () => ({ result: { result: [...Buffer.from('not json')], logs: [] } }) });
  const c = await viewCall({ rpcUrl: RPC, contractId: 'c.testnet', method: 'm', fetchImpl: garbage.fetchImpl });
  assert.equal(c.ok, false);
  assert.match(c.why, /not JSON/);
});

test('receiptEventLine: the one line the contract logs for a hash; a malformed hash throws', () => {
  assert.equal(
    receiptEventLine(HASH),
    `EVENT_JSON:{"standard":"cambrian-receipt","version":"1.0.0","event":"record_receipt","data":[{"sha256":"${HASH}"}]}`,
  );
  assert.notEqual(receiptEventLine(HASH), receiptEventLine(HASH.replace('9', '8')));
  for (const bad of [HASH.toUpperCase(), HASH.slice(1), `${HASH.slice(0, 63)}g`, undefined]) {
    assert.throws(() => receiptEventLine(bad), /64 lowercase hex/);
  }
});

test('the log-only contract has no receipt view: rpc.mjs exports no getReceiptOnChain', async () => {
  const rpc = await import('../../near/rpc.mjs');
  assert.equal(rpc.getReceiptOnChain, undefined);
  assert.equal(typeof rpc.viewCall, 'function', 'the generic view call stays');
});

test('txStatus asks `tx` with wait_until NONE and returns the node answer; unknown and busy are told apart', async () => {
  const answer = { final_execution_status: 'FINAL', transaction: { hash: 'h' }, transaction_outcome: {}, receipts_outcome: [] };
  const found = stubRpc({ tx: () => ({ result: answer }) });
  const ok = await txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'line.testnet', fetchImpl: found.fetchImpl });
  assert.deepEqual(ok, { ok: true, result: answer });
  assert.equal(found.calls[0].method, 'tx');
  assert.deepEqual(found.calls[0].params, { tx_hash: 'h', sender_account_id: 'line.testnet', wait_until: 'NONE' });

  const error = (name) => stubRpc({ tx: () => ({ error: { name: 'HANDLER_ERROR', cause: { name }, data: `${name} happened` } }) });
  const unknown = await txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'a.testnet', fetchImpl: error('UNKNOWN_TRANSACTION').fetchImpl });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.unknown, true);
  assert.equal(unknown.offline, undefined);
  const busy = await txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'a.testnet', fetchImpl: error('TIMEOUT_ERROR').fetchImpl });
  assert.deepEqual(busy, { ok: false, offline: true, why: 'TIMEOUT_ERROR: TIMEOUT_ERROR happened' });
  const other = await txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'a.testnet', fetchImpl: error('INTERNAL_ERROR').fetchImpl });
  assert.equal(other.ok, false);
  assert.equal(other.unknown, false);

  const partial = stubRpc({ tx: () => ({ result: { final_execution_status: 'NONE' } }) });
  const thin = await txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'a.testnet', fetchImpl: partial.fetchImpl });
  assert.equal(thin.ok, false);
  assert.match(thin.why, /without transaction/);
});

test('code hash comparison: the committed bytes match, other bytes do not, no contract is reported', async () => {
  const wasm = Buffer.from('0061736d01000000', 'hex');
  const deployed = stubRpc({ 'query:view_account': () => ({ result: { code_hash: wasmCodeHash(wasm), block_height: 9 } }) });

  const onchain = await contractCodeHash({ rpcUrl: RPC, accountId: 'receipts.testnet', fetchImpl: deployed.fetchImpl });
  assert.deepEqual(onchain, { ok: true, code_hash: wasmCodeHash(wasm), has_contract: true, block_height: 9 });
  assert.equal(deployed.calls[0].params.request_type, 'view_account');
  assert.equal(deployed.calls[0].params.account_id, 'receipts.testnet');

  const same = await compareCodeHash({ rpcUrl: RPC, accountId: 'receipts.testnet', wasmBytes: wasm, fetchImpl: deployed.fetchImpl });
  assert.equal(same.ok, true);
  assert.equal(same.match, true);
  assert.equal(same.onchain, same.local);

  const tampered = Buffer.concat([wasm, Buffer.from([0])]);
  const differs = await compareCodeHash({ rpcUrl: RPC, accountId: 'receipts.testnet', wasmBytes: tampered, fetchImpl: deployed.fetchImpl });
  assert.equal(differs.ok, true);
  assert.equal(differs.match, false);
  assert.match(differs.why, /is not the committed wasm/);

  const empty = stubRpc({ 'query:view_account': () => ({ result: { code_hash: NO_CONTRACT_CODE_HASH, block_height: 9 } }) });
  const none = await compareCodeHash({ rpcUrl: RPC, accountId: 'plain.testnet', wasmBytes: wasm, fetchImpl: empty.fetchImpl });
  assert.equal(none.match, false);
  assert.match(none.why, /no contract is deployed/);
  const plain = await contractCodeHash({ rpcUrl: RPC, accountId: 'plain.testnet', fetchImpl: empty.fetchImpl });
  assert.equal(plain.has_contract, false);
});

test('offline: a failed fetch, a timeout and a non-JSON gateway answer all give offline:true', async () => {
  const down = async () => {
    throw new TypeError('fetch failed');
  };
  for (const run of [
    () => viewCall({ rpcUrl: RPC, contractId: 'c.testnet', method: 'm', fetchImpl: down }),
    () => txStatus({ rpcUrl: RPC, txHash: 'h', senderId: 'c.testnet', fetchImpl: down }),
    () => contractCodeHash({ rpcUrl: RPC, accountId: 'c.testnet', fetchImpl: down }),
    () => compareCodeHash({ rpcUrl: RPC, accountId: 'c.testnet', wasmBytes: new Uint8Array(1), fetchImpl: down }),
  ]) {
    const r = await run();
    assert.equal(r.ok, false);
    assert.equal(r.offline, true);
    assert.match(r.why, /cannot reach https:\/\/rpc\.invalid: fetch failed/);
  }

  const hangs = (url, init) =>
    new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  const slow = await rpcCall({ rpcUrl: RPC, method: 'status', params: [], fetchImpl: hangs, timeoutMs: 20 });
  assert.deepEqual(slow, { ok: false, offline: true, why: 'no answer from https://rpc.invalid within 20 ms' });

  const gateway = async () => ({
    status: 502,
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
  });
  const bad = await rpcCall({ rpcUrl: RPC, method: 'status', params: [], fetchImpl: gateway });
  assert.equal(bad.offline, true);
  assert.match(bad.why, /HTTP 502/);

  // The other direction: a node that answers is not reported offline.
  const up = stubRpc({ status: () => ({ result: { chain_id: 'testnet' } }) });
  const fine = await rpcCall({ rpcUrl: RPC, method: 'status', params: [], fetchImpl: up.fetchImpl });
  assert.deepEqual(fine, { ok: true, result: { chain_id: 'testnet' } });
});

// ---- a rate limit is asked again, then asked elsewhere, then skipped: never a FAIL ----
function limited(plan) {
  // plan: url → list of answers, one per request, the last one repeating. 'limit' | 'limit429' | 'ok' | 'wrong' | 'down'
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    const list = plan[url] || ['down']; const what = list[Math.min(calls.filter((u) => u === url).length - 1, list.length - 1)];
    if (what === 'down') throw new TypeError('fetch failed');
    if (what === 'limit429') return { status: 429, json: async () => { throw new Error('not json'); } };
    if (what === 'limit') {
      return { status: 200, json: async () => ({ error: { message: 'Rate limits exceeded. For higher rate limits get a subscription' } }) };
    }
    if (what === 'wrong') return { status: 200, json: async () => ({ error: { cause: { name: 'UNKNOWN_TRANSACTION' }, data: 'Transaction x not found' } }) };
    return { status: 200, json: async () => ({ result: { chain_id: 'mainnet' } }) };
  };
  return { fetchImpl, calls };
}
async function quick(fn) {
  const { retry } = await import('../../near/rpc.mjs'); const keep = { ...retry }; const waits = [];
  retry.sleep = async (ms) => { waits.push(ms); };
  try { return { out: await fn(), waits }; } finally { Object.assign(retry, keep); }
}

test('rate limit: the same node is asked again after 1, 3 and 9 s, and an answer on a later try is the answer', async () => {
  const { rpcCall } = await import('../../near/rpc.mjs');
  const node = limited({ 'http://a.test': ['limit', 'limit429', 'ok'] });
  const { out, waits } = await quick(() => rpcCall({ rpcUrl: 'http://a.test', method: 'status', params: [], fetchImpl: node.fetchImpl }));
  assert.equal(out.ok, true);
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(node.calls.length, 3);
});

test('rate limit: after the tries a second node is asked; its answer counts, right or wrong', async () => {
  const { rpcCall, FALLBACK_RPC } = await import('../../near/rpc.mjs');
  const node = limited({ 'http://a.test': ['limit'], 'http://b.test': ['ok'] });
  const { out, waits } = await quick(() => rpcCall({ rpcUrl: 'http://a.test', fallbackUrl: 'http://b.test', method: 'status', params: [], fetchImpl: node.fetchImpl }));
  assert.equal(out.ok, true);
  assert.equal(out.via, 'http://b.test');
  assert.deepEqual(waits, [1000, 3000, 9000]);
  assert.deepEqual(node.calls, ['http://a.test', 'http://a.test', 'http://a.test', 'http://a.test', 'http://b.test']);
  // a wrong answer from the second node is a wrong answer: it is passed on as an error, not turned into a skip
  const bad = limited({ 'http://a.test': ['limit'], 'http://b.test': ['wrong'] });
  const wrong = (await quick(() => rpcCall({ rpcUrl: 'http://a.test', fallbackUrl: 'http://b.test', method: 'tx', params: {}, fetchImpl: bad.fetchImpl }))).out;
  assert.equal(wrong.ok, false);
  assert.equal(wrong.offline, undefined);
  assert.equal(wrong.error.cause.name, 'UNKNOWN_TRANSACTION');
  // the node the repository names has a second node; a node given by hand has none unless one is named
  assert.equal(FALLBACK_RPC['https://archival-rpc.mainnet.fastnear.com'], 'https://near.drpc.org');
});

test('rate limit: limited everywhere is "no answer" with the reason, which callers print as a skip, never a FAIL', async () => {
  const { rpcCall, chainId } = await import('../../near/rpc.mjs');
  for (const second of [['limit'], ['down']]) {
    const node = limited({ 'http://a.test': ['limit'], 'http://b.test': second });
    const { out } = await quick(() => rpcCall({ rpcUrl: 'http://a.test', fallbackUrl: 'http://b.test', method: 'status', params: [], fetchImpl: node.fetchImpl }));
    assert.equal(out.ok, false);
    assert.equal(out.offline, true);
    assert.match(out.why, /^rate limited by http:\/\/a\.test after 3 more tries, and http:\/\/b\.test gave no answer/);
  }
  const alone = limited({ 'http://a.test': ['limit'] });
  const { out } = await quick(() => chainId({ rpcUrl: 'http://a.test', fetchImpl: alone.fetchImpl }));
  assert.equal(out.offline, true);
  assert.match(out.why, /^rate limited by http:\/\/a\.test after 3 more tries/);
});

test('rate limit: a node that answers wrongly on the first try still fails at once, with no retry', async () => {
  const { rpcCall } = await import('../../near/rpc.mjs');
  const node = limited({ 'http://a.test': ['wrong'] });
  const { out, waits } = await quick(() => rpcCall({ rpcUrl: 'http://a.test', fallbackUrl: 'http://b.test', method: 'tx', params: {}, fetchImpl: node.fetchImpl }));
  assert.equal(out.ok, false);
  assert.equal(out.offline, undefined);
  assert.deepEqual(waits, []);
  assert.equal(node.calls.length, 1);
});
