// The receipt and its hash: stable, order-independent, and it changes when any recorded fact changes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sha256Hex, sha256HexAsync, hashOf } from '../../receipts/canonical.mjs';
import { buildReceipt, receiptHash, verifyReceipt } from '../../receipts/receipt.mjs';

const run = () => ({ v: 1, origin: 'baby', mode: 'offline', ticket: { id: 'facts-page-1', title: 'A facts page', product: 'facts', branch: 'build/facts-page-1', budget: { usd: 1, calls: 20, minutes: 10 }, checks: ['page'] },
  ticket_sha256: 'a'.repeat(64), approvals: [{ member: 'jj', credential_id: 'c1', ticket_sha256: 'a'.repeat(64), authenticator_data: 'x', client_data_json: 'y', signature: 'z', at: 't' }],
  release: { ok: true, valid: ['clemens', 'jj'], threshold: 2 }, state: 'green-preview', started: '2026-11-12T10:00:00.000Z', finished: '2026-11-12T10:05:00.000Z',
  attempts: [{ n: 1, walls: 'sandbox probe: 20 passed, 0 failed', sandbox: { kind: 'sandbox-exec' }, commit: 'c'.repeat(40),
    calls: [{ seq: 1, at: 't1', model: 'm', prompt_tokens: 1000, cached_tokens: 100, completion_tokens: 50, usd: 0.0012345678, ms: 900, status: 200, chat_id: 'chat-1', attestation: null },
      { seq: 2, at: 't2', model: 'm', prompt_tokens: 2000, cached_tokens: 0, completion_tokens: 70, usd: 0.002, ms: 800, status: 200, chat_id: 'chat-2', attestation: null }],
    checks: [{ id: 'page', name: 'page', kind: 'file', pass: true, detail: 'index.html meets every condition' }] }],
  main: { before: 'm'.repeat(40), after: 'm'.repeat(40), untouched: true }, push: { pushed: true, ref: 'refs/heads/build/facts-page-1' },
  preview: { state: 'success', url: 'https://example.vercel.app', public: true }, cost: { usd: 0.003235, calls: 2, priced_from: 'NEAR AI /v1/models pricing × usage' }, lessons: { fired: [], drafted: null } });

test('canonical JSON: sorted keys, no whitespace, key order does not matter', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x'], c: { z: 1.5, y: 'é"' } }), '{"a":[true,null,"x"],"b":1,"c":{"y":"é\\"","z":1.5}}');
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }));
  assert.equal(canonical({ a: undefined, b: 1 }), '{"b":1}');
  assert.throws(() => canonical({ a: NaN }), /finite/); assert.throws(() => canonical({ a: 1n }), /bigint/);
});
test('sha256: the known vector, and the sync and async digests agree', async () => {
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(await sha256HexAsync('abc'), sha256Hex('abc'));
  assert.equal(hashOf({ b: 2, a: 1 }), sha256Hex('{"a":1,"b":2}'));
});
test('a receipt is a pure function of the run record', () => {
  const a = buildReceipt(run()), b = buildReceipt(JSON.parse(JSON.stringify(run())));
  assert.equal(receiptHash(a), receiptHash(b)); assert.match(receiptHash(a), /^[0-9a-f]{64}$/);
  assert.equal(a.totals.calls, 2); assert.equal(a.totals.prompt_tokens, 3000); assert.equal(a.totals.usd, 0.003235); assert.equal(a.calls[0].usd, 0.001235);
  assert.equal(a.result.green, true); assert.equal(a.build.main_untouched, true); assert.equal(a.approvals.signatures.length, 1);
});
test('changing any recorded fact changes the hash', () => {
  const base = receiptHash(buildReceipt(run()));
  for (const mutate of [(r) => { r.attempts[0].calls[1].usd = 0.0021; }, (r) => { r.attempts[0].checks[0].pass = false; }, (r) => { r.attempts[0].commit = 'd'.repeat(40); },
    (r) => { r.approvals[0].signature = 'zz'; }, (r) => { r.ticket_sha256 = 'b'.repeat(64); }, (r) => { r.state = 'red'; }]) {
    const r = run(); mutate(r); assert.notEqual(receiptHash(buildReceipt(r)), base);
  }
});
test('what the receipt carries, and what it leaves out', () => {
  const base = receiptHash(buildReceipt(run()));
  // carried: each of these recorded facts moves the hash
  const carried = [(r) => { r.main.before = 'n'.repeat(40); }, (r) => { r.main.after = 'n'.repeat(40); }, (r) => { r.push.remote_sha = 'e'.repeat(40); },
    (r) => { r.attempts[0].failing = ['page']; }, (r) => { r.attempts[0].green = true; }, (r) => { r.attempts[0].agent = { kind: 'OpenCode', exit: 1, seconds: 9, model: 'm' }; },
    (r) => { r.attempts[0].calls[0].request_sha256 = 'f'.repeat(64); }, (r) => { r.attempts[0].calls[0].response_sha256 = 'f'.repeat(64); },
    (r) => { r.attempts[0].calls[0].attestation = { kind: 'provider_tee' }; }, (r) => { r.mode = 'live'; }, (r) => { r.preview.url = 'https://other.vercel.app'; },
    (r) => { r.preview.deployment_id = 'dpl_2'; }, (r) => { r.lessons.fired = [{ lesson: 'x', what: 'y' }]; }, (r) => { r.main.untouched = false; },
    (r) => { r.release.valid = ['jj']; }, (r) => { r.ticket.budget.usd = 2; }, (r) => { r.finished = '2026-11-12T10:06:00.000Z'; }];
  for (const [i, mutate] of carried.entries()) { const r = run(); mutate(r); assert.notEqual(receiptHash(buildReceipt(r)), base, `carried fact ${i}`); }
  // left out on purpose (working state, not part of what was built or paid): these do not move it
  const leftOut = [(r) => { r.notifications = [{ ts: 't', kind: 'GREEN', text: 'x' }]; }, (r) => { r.stations = { brief: { at: 't' } }; }, (r) => { r.waiting_on = 'x'; },
    (r) => { r.budget = { day: '2026-11-12', ceiling_usd: 5 }; }];
  for (const [i, mutate] of leftOut.entries()) { const r = run(); mutate(r); assert.equal(receiptHash(buildReceipt(r)), base, `left-out field ${i}`); }
});
test('verifyReceipt: accepts the true receipt, refuses a changed receipt and a changed record', () => {
  const r = run(); const receipt = buildReceipt(r); const sha = receiptHash(receipt);
  assert.equal(verifyReceipt({ receipt, run: r, expectedSha256: sha }).ok, true);
  const cheaper = { ...receipt, totals: { ...receipt.totals, usd: 0.0001 } };
  assert.equal(verifyReceipt({ receipt: cheaper, run: r, expectedSha256: sha }).ok, false);
  const r2 = run(); r2.attempts[0].calls.pop();
  assert.equal(verifyReceipt({ receipt, run: r2 }).ok, false);
});
test('an unfinished run has no receipt', () => { const r = run(); r.finished = null; assert.throws(() => buildReceipt(r), /not finished/); });
