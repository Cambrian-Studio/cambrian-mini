// Pricing and chat against a loopback stand-in for NEAR AI Cloud. No key, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, fetchPricing, hasKey, priceCall, readKey, resolvePricedModel } from '../../near/nearai.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const TEST_KEY = 'test-key-not-a-real-credential';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearai-test-'));
const keyFile = path.join(dir, 'key');
fs.writeFileSync(keyFile, `${TEST_KEY}\n`, { mode: 0o600 });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The stand-in serves the recorded model list and one recorded completion, byte for byte.
const RESPONSE_BYTES = fs.readFileSync(path.join(FIX, 'tool.response.json'));
async function standIn(handler) {
  const seen = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      if (handler && handler(req, res, body)) return;
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `bad key ${req.headers.authorization}` } }));
      } else if (req.url === '/v1/models') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(fs.readFileSync(path.join(FIX, 'models.json')));
      } else if (req.url === '/v1/chat/completions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(RESPONSE_BYTES);
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(r)) };
}

test('readKey reads a mode-600 file and refuses one that others can read', () => {
  assert.equal(readKey(keyFile), TEST_KEY);
  assert.equal(hasKey(keyFile), true);
  assert.equal(hasKey(path.join(dir, 'absent')), false);
  const open = path.join(dir, 'open-key');
  fs.writeFileSync(open, TEST_KEY, { mode: 0o644 });
  assert.throws(() => readKey(open), (e) => /mode 600/.test(e.message) && !e.message.includes(TEST_KEY));
  assert.throws(() => readKey(path.join(dir, 'absent')), /not found/);
  const empty = path.join(dir, 'empty-key');
  fs.writeFileSync(empty, '\n', { mode: 0o600 });
  assert.throws(() => readKey(empty), /empty/);
});

test('fetchPricing returns USD per token for every priced model', async () => {
  const s = await standIn();
  try {
    const pricing = await fetchPricing({ keyFile, base: s.base });
    assert.equal(pricing.source, `${s.base}/models`);
    assert.ok(!Number.isNaN(Date.parse(pricing.fetched_at)));
    assert.deepEqual(pricing.models['deepseek-ai/DeepSeek-V4.1-Flash-1017'],
      { prompt: 0.0000003, completion: 0.0000012, input_cache_read: 0.000000006 });
    assert.equal(pricing.models['google/gemini-2.5-flash'].input_cache_read, null);
    assert.equal(Object.keys(pricing.models).length, 7);
    assert.equal(s.seen[0].headers.authorization, `Bearer ${TEST_KEY}`);
  } finally { await s.close(); }
});

test('fetchPricing fails loudly on a refusal and never repeats the key', async () => {
  const s = await standIn((req, res) => { res.writeHead(402).end('{}'); return true; });
  try {
    await assert.rejects(fetchPricing({ keyFile, base: s.base }), (e) => /HTTP 402/.test(e.message) && !e.message.includes(TEST_KEY));
  } finally { await s.close(); }
  const failing = async () => { throw new Error(`connect failed with Bearer ${TEST_KEY}`); };
  await assert.rejects(fetchPricing({ keyFile, base: 'http://127.0.0.1:9/v1', fetchImpl: failing }),
    (e) => /\[key\]/.test(e.message) && !e.message.includes(TEST_KEY));
});

test('priceCall prices by exact id, by an unambiguous provider prefix, and refuses the rest', () => {
  const pricing = {
    models: {
      'deepseek-ai/DeepSeek-V4.1-Flash-1017': { prompt: 0.0000003, completion: 0.0000012, input_cache_read: 0.000000006 },
      'anthropic/claude-haiku-5-5': { prompt: 0.0000001, completion: 0.0000005, input_cache_read: null },
      'a/twin': { prompt: 1, completion: 1, input_cache_read: null },
      'b/twin': { prompt: 2, completion: 2, input_cache_read: null },
    },
  };
  // 312 prompt tokens of which 256 cached, 56 completion: the recorded call.
  const usage = { prompt_tokens: 312, completion_tokens: 56, prompt_tokens_details: { cached_tokens: 256 } };
  assert.equal(priceCall(pricing, 'deepseek-ai/DeepSeek-V4.1-Flash-1017', usage), 0.000085536);
  // No cached rate published: cached tokens cost the prompt rate.
  assert.equal(priceCall(pricing, 'anthropic/claude-haiku-5-5', usage), 0.0000592);
  // The API serves proxied models without the provider prefix.
  assert.equal(resolvePricedModel(pricing, 'claude-haiku-5-5'), 'anthropic/claude-haiku-5-5');
  assert.equal(priceCall(pricing, 'claude-haiku-5-5', { prompt_tokens: 12, completion_tokens: 4 }), 0.0000032);
  // Two priced ids share the bare name: unpriced, not guessed.
  assert.equal(priceCall(pricing, 'twin', usage), null);
  assert.equal(priceCall(pricing, 'c/twin', usage), null);
  assert.equal(priceCall(pricing, 'a/twin', { prompt_tokens: 1, completion_tokens: 1 }), 2);
  // Unknown model, different case, missing or broken usage.
  assert.equal(priceCall(pricing, 'nobody/unknown', usage), null);
  assert.equal(priceCall(pricing, 'deepseek-ai/deepseek-v4.1-flash-1017', usage), null);
  assert.equal(priceCall(pricing, 'a/twin', null), null);
  assert.equal(priceCall(pricing, 'a/twin', { prompt_tokens: 'many' }), null);
  assert.equal(priceCall(pricing, 'toString', usage), null);
});

test('chat sends the key, hashes the exact bytes both ways, and prices the call', async () => {
  const s = await standIn();
  try {
    const pricing = await fetchPricing({ keyFile, base: s.base });
    const out = await chat({
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 32, temperature: 0, keyFile, base: s.base, pricing,
    });
    const sent = s.seen.at(-1);
    assert.equal(sent.url, '/v1/chat/completions');
    assert.equal(sent.headers.authorization, `Bearer ${TEST_KEY}`);
    assert.equal(sent.headers['x-no-aliasing'], 'true');
    assert.deepEqual(JSON.parse(sent.body), {
      model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', messages: [{ role: 'user', content: 'hello' }], temperature: 0, max_tokens: 32,
    });
    assert.equal(out.ok, true);
    assert.equal(out.status, 200);
    assert.equal(out.id, 'chatcmpl-b81d43d3-3e81-4843-9823-241b81baaf89');
    assert.equal(out.model, 'deepseek-ai/DeepSeek-V4.1-Flash-1017');
    assert.equal(out.content, null); // the recorded reply is a tool call
    assert.equal(out.raw.choices[0].message.tool_calls[0].function.name, 'write_file');
    assert.equal(out.request_sha256, sha(sent.body));
    assert.equal(out.response_sha256, sha(RESPONSE_BYTES));
    assert.notEqual(out.request_sha256, sha(Buffer.concat([sent.body, Buffer.from(' ')])));
    // the exact bytes come back as text, so a caller can keep what the signature covers
    assert.equal(sha(Buffer.from(out.response_body, 'utf8')), out.response_sha256);
    assert.equal(sha(Buffer.from(out.request_body, 'utf8')), out.request_sha256);
    assert.equal(out.request_body, sent.body.toString('utf8'));
    assert.deepEqual(out.usage.prompt_tokens_details, { cached_tokens: 256, created_cache_tokens: 0 });
    assert.equal(out.usd, 0.000085536);
    assert.ok(!JSON.stringify(out).includes(TEST_KEY));
    // Without pricing the call is reported unpriced rather than free.
    const bare = await chat({ model: 'x/y', messages: [{ role: 'user', content: 'hello' }], keyFile, base: s.base });
    assert.equal(bare.usd, null);
  } finally { await s.close(); }
});

test('chat reports a refusal as ok:false and keeps the key out of the result', async () => {
  const wrongKey = path.join(dir, 'wrong-key');
  fs.writeFileSync(wrongKey, 'another-test-key', { mode: 0o600 });
  const s = await standIn();
  try {
    const out = await chat({ model: 'x/y', messages: [{ role: 'user', content: 'hi' }], keyFile: wrongKey, base: s.base });
    assert.equal(out.ok, false);
    assert.equal(out.status, 401);
    assert.equal(out.id, null);
    assert.equal(out.usd, null);
    assert.match(out.error, /bad key Bearer \[key\]/);
    assert.equal(out.response_body, null, 'a response that repeats the key is not handed back as text');
    assert.match(out.response_sha256, /^[0-9a-f]{64}$/);
    assert.equal(typeof out.request_body, 'string');
    assert.ok(!JSON.stringify(out).includes('another-test-key'));
  } finally { await s.close(); }
  const down = await chat({
    model: 'x/y', messages: [{ role: 'user', content: 'hi' }], keyFile,
    fetchImpl: async () => { throw new Error(`socket closed (${TEST_KEY})`); },
  });
  assert.equal(down.ok, false);
  assert.equal(down.status, 0);
  assert.equal(down.response_sha256, null);
  assert.ok(!JSON.stringify(down).includes(TEST_KEY));
});

test('chat refuses streaming, a missing model, and an unreadable key before any request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
  const messages = [{ role: 'user', content: 'hi' }];
  await assert.rejects(chat({ model: 'x/y', messages, stream: true, keyFile, fetchImpl }), /non-streaming/);
  await assert.rejects(chat({ messages, keyFile, fetchImpl }), /model is required/);
  await assert.rejects(chat({ model: 'x/y', messages: [], keyFile, fetchImpl }), /messages are required/);
  await assert.rejects(chat({ model: 'x/y', messages, keyFile: path.join(dir, 'absent'), fetchImpl }), /not found/);
  assert.equal(calls, 0);
});
