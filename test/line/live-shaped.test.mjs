// The LIVE path with every outside party replaced by a stand-in on this machine: NEAR AI is a loopback server,
// Vercel is a stub fetch, the agent runtime is a small script that makes two model calls through the bridge and
// then writes the solution. No real key, no real call, no spend — but the real bridge, wall, metering and record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../line/config.mjs';
import { startRun } from '../../line/dispatch.mjs';
import { readSpentToday } from '../../line/budget.mjs';
import { buildReceipt, receiptHash } from '../../receipts/receipt.mjs';
import { sha256Hex } from '../../receipts/canonical.mjs';
import * as nearai from '../../near/nearai.mjs';
import { FIXTURES, fixtureTicket, needsWall, refOf, release, scratch } from './helpers.mjs';

const KEY = 'test-key-never-real-abcdefghij', TOKEN = 'stub-vercel-token-not-real', MODEL = 'test-org/test-model';

const FAKE_AGENT = `#!/usr/bin/env node
// A stand-in for the agent runtime: reads the provider config it was handed, makes two model calls through
// the bridge (one streamed, one not), notes what it could see of its environment, and writes the solution.
const fs = require('node:fs'), path = require('node:path');
(async () => {
  const cfg = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT); const p = cfg.provider.line; const model = Object.keys(p.models)[0];
  const call = async (stream) => {
    const headers = { authorization: 'Bearer ' + p.options.apiKey, 'content-type': 'application/json' };
    const r = await fetch(p.options.baseURL + '/chat/completions', { method: 'POST', headers,
      body: JSON.stringify({ model, stream, messages: [{ role: 'user', content: 'build the page' }] }) });
    return { status: r.status, type: r.headers.get('content-type'), bytes: (await r.text()).length };
  };
  const calls = [await call(true), await call(false)];
  fs.mkdirSync('.oc', { recursive: true });
  fs.writeFileSync('.oc/agent-saw.json', JSON.stringify({ env: process.env, argv: process.argv.slice(2, 4), calls }));
  fs.cpSync(path.join(__dirname, '..', '..', 'reference'), '.', { recursive: true }); fs.renameSync('page-test.fixture', 'page.test.mjs');
  console.log(JSON.stringify({ type: 'text', timestamp: Date.now(), part: { text: 'built' } }));
})().catch((e) => { console.error(e); process.exit(1); });
`;

const everyFile = (dir, out = []) => {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    const st = lstatSync(p);
    if (st.isDirectory()) everyFile(p, out);
    else if (st.isFile()) out.push(p);
  }
  return out;
};

test('a live-shaped run: metered per call, attested per call, deployed, and no key anywhere but its own file', needsWall, async () => {
  const s = scratch('live-shaped');
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const reply = Buffer.from(
        JSON.stringify({
          id: `chatcmpl-live-${seen.length + 1}`,
          object: 'chat.completion',
          model: MODEL,
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } },
        }),
      );
      seen.push({ auth: req.headers.authorization, noAlias: req.headers['x-no-aliasing'], body: Buffer.concat(chunks), reply });
      res.writeHead(200, { 'content-type': 'application/json' }).end(reply);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const home = join(s.dir, 'home'), secrets = join(s.dir, 'secrets'), tools = join(home, 'tools');
    mkdirSync(join(tools, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(secrets, { mode: 0o700 });
    writeFileSync(join(tools, 'node_modules', '.bin', 'opencode'), FAKE_AGENT);
    chmodSync(join(tools, 'node_modules', '.bin', 'opencode'), 0o755);
    cpSync(join(FIXTURES, 'stand-in', 'reference'), join(tools, 'reference'), { recursive: true });
    const keyFile = join(secrets, 'nearai.key'), tokenFile = join(secrets, 'vercel.token');
    writeFileSync(keyFile, KEY + '\n', { mode: 0o600 });
    writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
    // exactly the keys the app passes, plus the stand-in addresses
    const cfg = loadConfig({
      home,
      records: join(s.dir, 'records'),
      model: MODEL,
      nearai_key_file: keyFile,
      nearai_base: `http://127.0.0.1:${server.address().port}/v1`,
      vercel_token_file: tokenFile,
      vercel_team: 'example-team',
      daily_ceiling_usd: 5,
      vercel_api: 'https://api.vercel.test',
      preview_poll_seconds: 0,
    });
    assert.equal(cfg.offline, false);

    const asked = { pricing: 0, report: [], attestation: [] };
    const report = {
      nonce: null,
      signing_algo: 'ed25519',
      fetched_at: '2026-11-12T00:00:00.000Z',
      raw: { gateway_attestation: {}, model_attestations: [] },
    };
    const near = {
      ...nearai,
      fetchPricing: async ({ keyFile: k }) => {
        asked.pricing++;
        assert.equal(k, keyFile);
        return { fetched_at: 'now', source: 'stand-in', models: { [MODEL]: { prompt: 1e-6, completion: 2e-6, input_cache_read: 1e-7 } } };
      },
      fetchReport: async (q) => {
        asked.report.push(q);
        return { ...report, nonce: q.nonce };
      },
      fetchAttestation: async (q) => {
        asked.attestation.push(q);
        if (q.chatId === 'chatcmpl-live-2') throw new Error('signature service unavailable');
        return {
          kind: 'provider_tee',
          model: q.model,
          chat_id: q.chatId,
          signing_algo: 'ed25519',
          signing_address: '00'.repeat(32),
          text: `${q.model}:${q.requestSha256}:${q.responseSha256}`,
          signature: '00'.repeat(64),
          request_sha256: q.requestSha256,
          response_sha256: q.responseSha256,
          report: { model_name: q.model, signing_address: '00'.repeat(32), signing_algo: 'ed25519', preflight: true },
          fetched_at: 'now',
        };
      },
    };
    const vercel = [];
    const fetchImpl = async (url, init = {}) => {
      const u = new URL(url);
      vercel.push(`${init.method ?? 'GET'} ${u.host}${u.pathname}`);
      const j = (body, status = 200) => ({ status, ok: true, json: async () => body });
      if (u.host === 'facts-live.vercel.app') return j({});
      if (u.pathname === '/v11/projects') return j({ name: 'cambrian-facts-page' });
      if (u.pathname.startsWith('/v9/projects/')) return j({ ssoProtection: null, passwordProtection: null });
      if (u.pathname === '/v13/deployments') return j({ id: 'dpl_live', url: 'facts-live.vercel.app', readyState: 'READY' });
      return j({}, 404);
    };

    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket);
    const rec = await startRun(cfg, { ticket, approvals, council, lessonsFired: [] }, { fetchImpl, near });

    assert.equal(rec.state, 'green-preview', rec.waiting_on ?? '');
    assert.equal(rec.mode, 'live');
    assert.deepEqual(rec.preview, { state: 'success', url: 'https://facts-live.vercel.app', deployment_id: 'dpl_live', public: true });
    assert.equal(rec.stations.preview.url, 'https://facts-live.vercel.app');
    assert.deepEqual(vercel, [
      'POST api.vercel.test/v11/projects',
      'PATCH api.vercel.test/v9/projects/cambrian-facts-page',
      'POST api.vercel.test/v13/deployments',
      'GET facts-live.vercel.app/',
    ]);
    assert.match(
      rec.notifications.at(-1).html,
      /<a href="https:\/\/facts-live\.vercel\.app">Open the preview<\/a> \(public, no sign-in needed\)/,
    );

    // NEAR AI saw the real key, non-streamed requests, the no-aliasing header — twice
    assert.equal(seen.length, 2);
    for (const q of seen) {
      assert.equal(q.auth, `Bearer ${KEY}`);
      assert.equal(q.noAlias, 'true');
      assert.equal(JSON.parse(q.body).stream, undefined);
    }

    // one row per call, priced from usage × the price list; the totals are the sum of the rows
    const a = rec.attempts[0];
    assert.deepEqual([a.agent.kind, a.agent.exit, a.agent.model], ['OpenCode', 0, MODEL]);
    assert.equal(a.bridge.forwarded, 2);
    assert.equal(a.bridge.unpriced_calls, 0);
    assert.equal(a.calls.length, 2);
    a.calls.forEach((c, i) => {
      assert.deepEqual([c.model, c.prompt_tokens, c.cached_tokens, c.completion_tokens, c.status, c.chat_id], [
        MODEL,
        1000,
        400,
        500,
        200,
        `chatcmpl-live-${i + 1}`,
      ]);
      assert.ok(Math.abs(c.usd - 0.00164) < 1e-12);
      assert.ok(c.ms >= 0 && c.at);
      assert.equal(c.request_sha256, sha256Hex(seen[i].body), 'the hash of the exact bytes NEAR AI received');
      assert.equal(c.response_sha256, sha256Hex(seen[i].reply));
    });
    assert.deepEqual(rec.cost, { usd: 0.00328, calls: 2, priced_from: 'NEAR AI /v1/models pricing × usage' });
    assert.equal(readSpentToday(cfg), 0.00328, 'the daily meter reads the same dollars back from the record');

    // attestation: one report before the first call; per call a lookup bound to that call's hashes
    assert.equal(asked.pricing, 1);
    assert.equal(asked.report.length, 1);
    assert.equal(asked.report[0].model, MODEL);
    assert.match(asked.report[0].nonce, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      asked.attestation.map((q) => [q.chatId, q.model, q.requestSha256, q.responseSha256, q.report.nonce]).sort(),
      a.calls.map((c) => [c.chat_id, MODEL, c.request_sha256, c.response_sha256, asked.report[0].nonce]).sort(),
    );
    const [first, second] = a.calls;
    assert.equal(first.attestation.report.detached, true, 'the report is stored once, not in every row');
    const stored = JSON.parse(readFileSync(join(cfg.records, ticket.id, 'attestation-report.json'), 'utf8'));
    assert.equal(sha256Hex(JSON.stringify(stored)), first.attestation.report.sha256);
    assert.equal(typeof first.attestation_check.ok, 'boolean');
    assert.ok(first.attestation_check.checks.length > 0);
    assert.equal(first.attestation_check.ok, false, "the real verifier is not fooled by the stand-in's made-up signature");
    assert.equal(second.attestation, null);
    assert.match(second.attestation_note, /signature service unavailable/);
    assert.equal(receiptHash(buildReceipt(JSON.parse(readFileSync(join(cfg.records, ticket.id, 'run.json'), 'utf8')))), rec.receipt_sha256);

    // the push happened, main did not move
    assert.equal(refOf(join(cfg.products_dir, 'facts-page.git'), 'refs/heads/build/facts-page-1'), a.commit);
    assert.equal(rec.main.untouched, true);

    // what the agent could see: a per-run secret, the bridge on loopback — and not the key, in its config, environment or arguments
    const sawFile = join(cfg.scratch, ticket.id, 'wt', '.oc', 'agent-saw.json');
    const saw = JSON.parse(readFileSync(sawFile, 'utf8'));
    assert.ok(!readFileSync(sawFile, 'utf8').includes(KEY) && !readFileSync(sawFile, 'utf8').includes(TOKEN));
    const provider = JSON.parse(saw.env.OPENCODE_CONFIG_CONTENT).provider.line;
    assert.match(provider.options.apiKey, /^run-[0-9a-f]{32}$/);
    assert.match(provider.options.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.ok(!Object.keys(saw.env).some((k) => /NEARAI|VERCEL|TELEGRAM|LINE_WALL/.test(k)), Object.keys(saw.env).join(' '));
    assert.deepEqual(saw.calls.map((c) => [c.status, c.type.split(';')[0]]), [[200, 'text/event-stream'], [200, 'application/json']]);

    // and nowhere on disk except the two secret files themselves: not the record, not a trace, not a log
    const leaks = everyFile(s.dir).filter((p) => p !== keyFile && p !== tokenFile).filter((p) => {
      const t = readFileSync(p, 'latin1');
      return t.includes(KEY) || t.includes(TOKEN);
    });
    assert.deepEqual(leaks, []);
    assert.ok(existsSync(join(home, 'runs-work', ticket.id, 'a1', 'bridge-trace.jsonl')));
  } finally {
    await new Promise((r) => server.close(r));
    s.cleanup();
  }
});

test('live preflight refuses before any call: no key file, a loose key file, a model with no price', needsWall, async () => {
  const s = scratch('live-preflight');
  try {
    const home = join(s.dir, 'home');
    mkdirSync(join(home, 'tools', 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(home, 'tools', 'node_modules', '.bin', 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const keyFile = join(s.dir, 'nearai.key');
    const base = { home, model: MODEL, nearai_key_file: keyFile, nearai_base: 'http://127.0.0.1:9/v1', vercel_token_file: null };
    const near = {
      fetchPricing: async () => ({ models: { 'another/model': { prompt: 1e-6, completion: 1e-6, input_cache_read: null } } }),
    };
    const go = async (n) => {
      const ticket = fixtureTicket('facts-page-1', (t) => {
        t.id = `preflight-${n}`;
      });
      const { council, approvals } = release(ticket);
      return startRun(loadConfig({ ...base, records: join(s.dir, 'records') }), { ticket, approvals, council }, { near });
    };
    const none = await go(1);
    assert.equal(none.state, 'blocked');
    assert.match(none.waiting_on, /NEAR AI key is not usable \(no token at/);
    writeFileSync(keyFile, KEY + '\n', { mode: 0o644 });
    const loose = await go(2);
    assert.match(loose.waiting_on, /is mode 644, must be 600/);
    chmodSync(keyFile, 0o600);
    const unpriced = await go(3);
    assert.equal(unpriced.state, 'blocked');
    assert.match(unpriced.waiting_on, /lists no price for the model test-org\/test-model; an unpriced model is never called/);
    for (const r of [none, loose, unpriced]) {
      assert.equal(r.attempts.length, 0);
      assert.equal(r.push.pushed, false);
    }
  } finally {
    s.cleanup();
  }
});
