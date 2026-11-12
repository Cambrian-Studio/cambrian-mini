// Attestation, proven on real data recorded from NEAR AI Cloud on 2026-11-12 (see fixtures/source.json).
// Offline: the recorded bytes are served by a loopback stand-in; nothing here needs a key or the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  detachReport, fetchAttestation, fetchReport, keccak256, parseTdxQuote, recoverEthAddress, sha256Hex,
  trimReport, verifyAttestation, verifyTextSignature,
} from '../../near/nearai.mjs';

const FIX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const bytes = (name) => fs.readFileSync(path.join(FIX, name));
const json = (name) => JSON.parse(bytes(name).toString('utf8'));
const SOURCE = json('source.json');
const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
const TEST_KEY = 'test-key-not-a-real-credential';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nearai-att-test-'));
const keyFile = path.join(dir, 'key');
fs.writeFileSync(keyFile, TEST_KEY, { mode: 0o600 });
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

// The three recorded completions: [fixture prefix, response file, chat id, model, expected kind].
const CASES = {
  tool: ['tool', 'tool.response.json', SOURCE.chats.tool.chat_id, MODEL, 'provider_tee'],
  stream: ['stream', 'stream.response.sse', SOURCE.chats.stream.chat_id, MODEL, 'gateway'],
  proxied: ['proxied', 'proxied.response.json', SOURCE.chats.proxied.chat_id, 'anthropic/claude-haiku-5-5', 'gateway'],
};
const hashes = (name) => ({
  requestSha256: sha256Hex(bytes(`${CASES[name][0]}.request.json`)),
  responseSha256: sha256Hex(bytes(CASES[name][1])),
});

// Stand-in for the two attestation endpoints, serving the recorded bodies unchanged.
async function standIn({ notFoundFirst = 0 } = {}) {
  let misses = notFoundFirst;
  const seen = [];
  const send = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    seen.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), authorization: req.headers.authorization });
    const algo = url.searchParams.get('signing_algo');
    if (url.pathname === '/v1/attestation/report') {
      if ((url.searchParams.get('model') || MODEL) !== MODEL) return send(res, 503, '{"error":{"message":"not supported"}}');
      return send(res, 200, bytes(`report.${algo}.json`));
    }
    if (url.pathname.startsWith('/v1/signature/')) {
      if (req.headers.authorization !== `Bearer ${TEST_KEY}`) return send(res, 401, '{"error":{"message":"Missing authorization header"}}');
      const id = decodeURIComponent(url.pathname.slice('/v1/signature/'.length));
      const hit = Object.values(CASES).find((c) => c[2] === id);
      const file = hit && path.join(FIX, `${hit[0]}.sig.${algo}.json`);
      if (id === 'unavailable') return send(res, 200, '{"error_code":"signature_unavailable","message":"none"}');
      if (!file || !fs.existsSync(file)) return send(res, 404, '{"error":{"message":"Signature not found"}}');
      if (misses > 0) { misses -= 1; return send(res, 404, '{"error":{"message":"Signature not found"}}'); }
      return send(res, 200, fs.readFileSync(file));
    }
    return send(res, 404, '{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}/v1`, seen, close: () => new Promise((r) => server.close(r)) };
}

async function recorded(name, signingAlgo = 'ed25519') {
  const [, , chatId, model] = CASES[name];
  const s = await standIn();
  try {
    const report = await fetchReport({ model: MODEL, signingAlgo, nonce: SOURCE.report.nonce, base: s.base });
    report.fetched_at = SOURCE.report.fetched_at; // when the real report was taken
    return await fetchAttestation({ chatId, model, ...hashes(name), keyFile, base: s.base, signingAlgo, report, retryMs: 1 });
  } finally { await s.close(); }
}
const names = (v) => v.checks.filter((c) => !c.skipped && !c.ok).map((c) => c.name);
const flip = (hex, at = 10) => hex.slice(0, at) + (hex[at] === '0' ? '1' : '0') + hex.slice(at + 1);

test('keccak256 and Ethereum signer recovery match known vectors', () => {
  assert.equal(keccak256(Buffer.alloc(0)).toString('hex'), 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470');
  assert.equal(keccak256(Buffer.from('abc')).toString('hex'), '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  // 200 bytes crosses the 136-byte block boundary.
  assert.equal(keccak256(Buffer.alloc(200, 0xa3)).toString('hex'), '3a57666b048777f2c953dc4456f45a2588e1cb6f2da760122d530ac2ce607d4a');
  const sig = json('tool.sig.ecdsa.json');
  assert.equal(recoverEthAddress(sig.text, sig.signature), sig.signing_address);
  assert.notEqual(recoverEthAddress(`${sig.text} `, sig.signature), sig.signing_address);
  assert.equal(recoverEthAddress(sig.text, '0x00'), null);
});

test('a real completion by a TEE-hosted model verifies offline (ed25519)', async () => {
  const att = await recorded('tool');
  assert.equal(att.kind, 'provider_tee');
  assert.equal(att.chat_id, SOURCE.chats.tool.chat_id);
  assert.equal(att.signing_algo, 'ed25519');
  assert.equal(att.signing_address, '236f5a6b91dd47dc3b7b36e43d4eb531a042ffb8f8fbf3a1555b78cef4fdda4c');
  assert.equal(att.text, `${MODEL}:${hashes('tool').requestSha256}:${hashes('tool').responseSha256}`);
  assert.equal(att.report.model_name, MODEL);
  assert.equal(att.report.preflight, true);
  assert.equal(att.report.request_nonce, SOURCE.report.nonce);
  assert.ok(!('nvidia_payload' in att.report) && /^[0-9a-f]{64}$/.test(att.report.nvidia_payload_sha256));
  const v = verifyAttestation(att, hashes('tool'));
  assert.equal(v.ok, true, v.why);
  assert.deepEqual(v.checks.filter((c) => !c.skipped).map((c) => [c.name, c.ok]), [
    ['signature', true], ['text_binds_hashes', true], ['report_names_signer', true], ['quote_parses', true],
    ['quote_binds_signer', true], ['quote_signature_chain', true], ['config_measured', true], ['event_log_replays', true],
  ]);
  // Online-only checks are listed as skipped with a reason, never as passed.
  const skipped = v.checks.filter((c) => c.skipped);
  assert.deepEqual(skipped.map((c) => c.name), ['tcb_status', 'gpu_evidence', 'image_provenance', 'report_freshness']);
  assert.ok(skipped.every((c) => c.ok === undefined && c.detail.length > 20));
  // The attestation survives a JSON round trip (it is stored in a run record).
  assert.equal(verifyAttestation(JSON.parse(JSON.stringify(att))).ok, true);
});

test('the same completion verifies with the secp256k1 (Ethereum) signature', async () => {
  const att = await recorded('tool', 'ecdsa');
  assert.equal(att.signing_algo, 'ecdsa');
  assert.equal(att.signing_address, '0xfe0071895500a9755c18044948ab4f4e1a7f337e');
  assert.equal(verifyAttestation(att, hashes('tool')).ok, true);
  assert.deepEqual(names(verifyAttestation({ ...att, signature: flip(att.signature) }, hashes('tool'))), ['signature']);
  assert.deepEqual(names(verifyAttestation({ ...att, text: flip(att.text, 60) }, hashes('tool'))), ['signature', 'text_binds_hashes']);
});

test('a streamed completion and a proxied model carry a gateway signature, which verifies', async () => {
  for (const [name, algo] of [['stream', 'ed25519'], ['stream', 'ecdsa'], ['proxied', 'ed25519']]) {
    const att = await recorded(name, algo);
    assert.equal(att.kind, 'gateway');
    assert.equal(att.text, `${hashes(name).requestSha256}:${hashes(name).responseSha256}`);
    assert.equal(att.report.model_name, null); // the gateway's report, not a model's
    const v = verifyAttestation(att, hashes(name));
    assert.equal(v.ok, true, v.why);
    // A gateway signature must not be passed off as a model-TEE signature.
    const asModel = verifyAttestation({ ...att, kind: 'provider_tee' }, hashes(name));
    assert.deepEqual(names(asModel), ['text_binds_hashes', 'report_names_signer']);
  }
});

test('one changed character in the text, the signature or either hash fails', async () => {
  const att = await recorded('tool');
  const h = hashes('tool');
  assert.equal(verifyAttestation(att, h).ok, true);
  assert.deepEqual(names(verifyAttestation({ ...att, text: flip(att.text, 60) }, h)), ['signature', 'text_binds_hashes']);
  assert.deepEqual(names(verifyAttestation({ ...att, text: att.text.replace('V4.1', 'V4.2') }, h)), ['signature', 'text_binds_hashes']);
  assert.deepEqual(names(verifyAttestation({ ...att, signature: flip(att.signature) }, h)), ['signature']);
  assert.deepEqual(names(verifyAttestation({ ...att, signature: flip(att.signature, 127) }, h)), ['signature']);
  assert.deepEqual(names(verifyAttestation(att, { ...h, requestSha256: flip(h.requestSha256) })), ['text_binds_hashes']);
  assert.deepEqual(names(verifyAttestation(att, { ...h, responseSha256: flip(h.responseSha256) })), ['text_binds_hashes']);
  // One changed byte in the request or the response changes its hash.
  const request = bytes('tool.request.json');
  request[20] ^= 1;
  assert.deepEqual(names(verifyAttestation(att, { ...h, requestSha256: sha256Hex(request) })), ['text_binds_hashes']);
  const response = Buffer.concat([bytes('tool.response.json'), Buffer.from('\n')]);
  assert.deepEqual(names(verifyAttestation(att, { ...h, responseSha256: sha256Hex(response) })), ['text_binds_hashes']);
  // The hashes recorded with the attestation are not trusted over the signed text either.
  assert.deepEqual(names(verifyAttestation({ ...att, request_sha256: flip(h.requestSha256) })), ['text_binds_hashes']);
  assert.equal(verifyAttestation({ ...att, model: 'z-ai/glm-5.3-flash' }, h).ok, false);
  const why = verifyAttestation({ ...att, signature: flip(att.signature) }, h).why;
  assert.match(why, /^signature: /);
});

test('a signature by any other key, or a report for another key, fails', async () => {
  const att = await recorded('tool');
  const h = hashes('tool');
  const gateway = json('stream.sig.ed25519.json');
  // A validly signed text from the gateway key does not pass under the model's address.
  assert.deepEqual(names(verifyAttestation({ ...att, signature: gateway.signature }, h)), ['signature']);
  // Claiming the gateway's address: the signature fails and the model report no longer names the signer.
  assert.deepEqual(names(verifyAttestation({ ...att, signing_address: gateway.signing_address }, h)), ['signature', 'report_names_signer']);
  // Swapping in the gateway's report under a model-TEE claim.
  const raw = json('report.ed25519.json');
  const swapped = { ...att, report: trimReport(raw.gateway_attestation, SOURCE.report.fetched_at) };
  assert.deepEqual(names(verifyAttestation(swapped, h)), ['report_names_signer']);
  // Renaming the signer inside the report: the hardware quote does not carry that address.
  const renamed = { ...att, signing_address: gateway.signing_address, report: { ...att.report, signing_address: gateway.signing_address } };
  assert.deepEqual(names(verifyAttestation(renamed, h)), ['signature', 'quote_binds_signer']);
  assert.deepEqual(names(verifyAttestation({ ...att, report: null }, h)),
    ['report_names_signer', 'quote_parses', 'quote_binds_signer', 'quote_signature_chain', 'config_measured', 'event_log_replays']);
  assert.deepEqual(verifyAttestation(null), { ok: false, checks: [], why: 'no attestation' });
});

test('a tampered hardware quote, nonce, configuration or event log fails', async () => {
  const att = await recorded('tool');
  const h = hashes('tool');
  const withReport = (patch) => verifyAttestation({ ...att, report: { ...att.report, ...patch } }, h);
  const quote = att.report.intel_quote;
  // Byte 568 of the quote is the first byte of the report data (the signing key).
  assert.deepEqual(names(withReport({ intel_quote: flip(quote, 568 * 2) })), ['quote_binds_signer', 'quote_signature_chain']);
  // A measurement byte: only Intel's signature notices.
  assert.deepEqual(names(withReport({ intel_quote: flip(quote, 200 * 2) })), ['quote_signature_chain']);
  // The quote's own signature.
  assert.deepEqual(names(withReport({ intel_quote: flip(quote, 640 * 2) })), ['quote_signature_chain']);
  assert.deepEqual(names(withReport({ request_nonce: flip(att.report.request_nonce) })), ['quote_binds_signer']);
  assert.deepEqual(names(withReport({ app_compose: `${att.report.app_compose} ` })), ['config_measured']);
  const log = att.report.event_log.filter((e) => e.imr === 3);
  assert.ok(log.length > 0);
  assert.deepEqual(names(withReport({ event_log: att.report.event_log.filter((e) => e !== log[0]) })), ['event_log_replays']);
  assert.deepEqual(names(withReport({ intel_quote: 'zz' })),
    ['quote_parses', 'quote_binds_signer', 'quote_signature_chain', 'config_measured', 'event_log_replays']);
  // The chain is checked at the time the report was fetched: long after expiry it fails.
  assert.deepEqual(names(withReport({ fetched_at: '2099-01-01T00:00:00Z' })), ['quote_signature_chain']);
  // The parsed quote really carries the signing key followed by the nonce.
  const parsed = parseTdxQuote(quote);
  assert.equal(parsed.reportData.toString('hex'), att.signing_address + SOURCE.report.nonce);
  assert.equal(parsed.certificates.length, 3);
});

test('verifyTextSignature refuses unknown algorithms and malformed input', () => {
  const sig = json('tool.sig.ed25519.json');
  const good = { text: sig.text, signature: sig.signature, signingAddress: sig.signing_address, algo: 'ed25519' };
  assert.equal(verifyTextSignature(good), true);
  assert.equal(verifyTextSignature({ ...good, algo: 'rsa' }), false);
  assert.equal(verifyTextSignature({ ...good, algo: 'ecdsa' }), false);
  assert.equal(verifyTextSignature({ ...good, signature: 'not hex' }), false);
  assert.equal(verifyTextSignature({ ...good, signingAddress: '00' }), false);
  assert.equal(verifyTextSignature({ ...good, text: undefined }), false);
});

test('fetchAttestation: retries a late signature, returns null when there is none, never sends the key for a report', async () => {
  const late = await standIn({ notFoundFirst: 2 });
  try {
    const att = await fetchAttestation({
      chatId: SOURCE.chats.tool.chat_id, model: MODEL, ...hashes('tool'), keyFile, base: late.base, retryMs: 1,
    });
    assert.equal(verifyAttestation(att, hashes('tool')).ok, true);
    assert.equal(att.report.preflight, false); // no report was passed in: it was fetched after the completion
    assert.equal(late.seen.filter((r) => r.path.startsWith('/v1/signature/')).length, 3);
    const reportCall = late.seen.find((r) => r.path === '/v1/attestation/report');
    assert.equal(reportCall.authorization, undefined);
    assert.equal(reportCall.query.model, MODEL);
    assert.match(reportCall.query.nonce, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(att).includes(TEST_KEY));
    // More misses than retries: no attestation.
    const never = await standIn({ notFoundFirst: 9 });
    try {
      const id = SOURCE.chats.tool.chat_id;
      const none = await fetchAttestation({ chatId: id, model: MODEL, keyFile, base: never.base, retries: 1, retryMs: 1 });
      assert.equal(none, null);
    } finally { await never.close(); }
    const base = late.base;
    assert.equal(await fetchAttestation({ chatId: 'no-such-chat', model: MODEL, keyFile, base, retries: 0 }), null);
    assert.equal(await fetchAttestation({ chatId: 'unavailable', model: MODEL, keyFile, base, retries: 0 }), null);
    assert.equal(await fetchAttestation({ chatId: '../models', model: MODEL, keyFile, base, retries: 0 }), null);
    assert.equal(await fetchAttestation({ chatId: null, model: MODEL, keyFile, base }), null);
    // A proxied model has no model report.
    assert.equal(await fetchReport({ model: 'anthropic/claude-haiku-5-5', base }), null);
    await assert.rejects(fetchAttestation({ chatId: 'x', model: MODEL, keyFile, base, signingAlgo: 'rsa' }), /unsupported/);
  } finally { await late.close(); }
});

test('a detached report verifies only when the same report is handed back', async () => {
  const full = await recorded('tool');
  const { att, report } = detachReport(full);
  assert.deepEqual(Object.keys(att.report), ['detached', 'sha256']);
  assert.ok(JSON.stringify(att).length < 1200);
  assert.equal(verifyAttestation(att, { ...hashes('tool'), report: JSON.parse(JSON.stringify(report)) }).ok, true);
  assert.equal(verifyAttestation(att, hashes('tool')).ok, false);
  const other = { ...report, request_nonce: flip(report.request_nonce) };
  assert.equal(verifyAttestation(att, { ...hashes('tool'), report: other }).ok, false);
});
