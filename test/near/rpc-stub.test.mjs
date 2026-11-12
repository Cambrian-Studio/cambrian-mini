// Test-only stand-in for a NEAR RPC node: answers JSON-RPC from a table and remembers every request.
export function stubRpc(handlers) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    calls.push({ url, ...request });
    const key = request.method === 'query' ? `query:${request.params.request_type}` : request.method;
    const handler = handlers[key];
    if (!handler) throw new Error(`stub RPC has no answer for ${key}`);
    const answer = await handler(request.params, request);
    return { status: 200, json: async () => ({ jsonrpc: '2.0', id: request.id, ...answer }) };
  };
  return { fetchImpl, calls };
}

/** The result of a call_function query whose return value is `value`. */
export function viewResult(value) {
  return { result: { result: [...Buffer.from(JSON.stringify(value), 'utf8')], logs: [], block_height: 77, block_hash: 'x' } };
}

// This file is named *.test.mjs so it sits with the tests that share it; it checks itself here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

test('the stub node answers from its table, records the request, and fails loudly on anything else', async () => {
  const { fetchImpl, calls } = stubRpc({ status: () => ({ result: { chain_id: 'testnet' } }) });
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'status', params: [] });
  const response = await fetchImpl('https://rpc.invalid', { body });
  assert.deepEqual((await response.json()).result, { chain_id: 'testnet' });
  assert.equal(calls.length, 1);
  const other = JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'broadcast_tx_commit', params: [] });
  await assert.rejects(fetchImpl('https://rpc.invalid', { body: other }), /no answer for broadcast_tx_commit/);
});
