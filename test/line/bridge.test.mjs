// The bridge, against a loopback stand-in for NEAR AI: the key swap, the budgets, the price, the trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIT, scratch } from './helpers.mjs';

const KEY = 'test-key-never-real-0123456789'; // made up here; the stand-in checks it arrives, the tests check it goes nowhere else
const SECRET = 'run-secret-for-the-agent-side';
const MODEL = 'test-org/test-model';
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const listen = (server) => new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
const freePort = async () => {
  const s = createServer();
  const p = await listen(s);
  await new Promise((r) => s.close(r));
  return p;
};

/** A stand-in for NEAR AI Cloud: records what reached it, answers a non-streamed completion with a tool call. */
async function upstream(
  { model = MODEL, usage = { prompt_tokens: 1000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 400 } } } = {},
) {
  const seen = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const reply = Buffer.from(JSON.stringify({
        id: `chatcmpl-test-${seen.length + 1}`,
        object: 'chat.completion',
        created: 1700000000,
        model,
        choices: [{
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'I will write the file.',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'write', arguments: '{"filePath":"index.html","content":"<p>hi</p>"}' },
            }],
          },
        }],
        ...(usage ? { usage } : {}),
      }));
      seen.push({ url: req.url, headers: req.headers, body, reply });
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream-secret-header': 'do-not-pass-on' }).end(reply);
    });
  });
  return { port: await listen(server), seen, close: () => new Promise((r) => server.close(r)) };
}

async function startBridge(
  dir,
  up,
  {
    maxCalls = 10,
    maxUsd = 1,
    pricing = { [MODEL]: { prompt: 1e-6, completion: 2e-6, input_cache_read: 1e-7 } },
    keyMode = 0o600,
    model = MODEL,
  } = {},
) {
  const key = join(dir, 'nearai.key'), secret = join(dir, 'secret'), price = join(dir, 'pricing.json'), trace = join(dir, 'trace.jsonl');
  writeFileSync(key, KEY + '\n', { mode: 0o600 });
  chmodSync(key, keyMode);
  writeFileSync(secret, SECRET, { mode: 0o600 });
  writeFileSync(price, JSON.stringify(pricing));
  const port = await freePort(), proxyPort = await freePort();
  const child = spawn(process.execPath, [
    join(KIT, 'bridge.mjs'),
    '--base',
    `http://127.0.0.1:${up.port}/v1`,
    '--key-file',
    key,
    '--pricing',
    price,
    '--secret-file',
    secret,
    '--trace',
    trace,
    '--port',
    String(port),
    '--proxy-port',
    String(proxyPort),
    '--model',
    model,
    '--max-calls',
    String(maxCalls),
    '--max-usd',
    String(maxUsd),
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d;
  });
  child.stderr.on('data', (d) => {
    output += d;
  });
  await new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('exit', () => reject(new Error(`bridge exited: ${output}`)));
  });
  const stop = () =>
    new Promise((r) => {
      child.once('exit', r);
      child.kill('SIGTERM');
    });
  const lines = () => readFileSync(trace, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const call = (body, { auth = `Bearer ${SECRET}`, headers = {} } = {}) =>
    fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { port, proxyPort, stop, lines, call, traceText: () => readFileSync(trace, 'utf8'), output: () => output };
}
const ask = (extra = {}) => ({ model: MODEL, messages: [{ role: 'user', content: 'a private prompt nobody should log' }], ...extra });

test("the agent's secret is swapped for the real key; the key never reaches the agent side or any log", async () => {
  const s = scratch('bridge-key');
  const up = await upstream();
  try {
    const b = await startBridge(s.dir, up);
    const wrong = await b.call(ask(), { auth: `Bearer ${KEY}` });
    assert.equal(wrong.status, 401, 'even the real key is not accepted on the agent side — only the per-run secret');
    assert.equal(up.seen.length, 0, 'an unauthorized call is not forwarded');
    const r = await b.call(ask(), { headers: { 'x-agent-header': 'not-forwarded', cookie: 'a=b' } });
    assert.equal(r.status, 200);
    const text = await r.text();
    // upstream saw the real key, the no-aliasing header, and none of the agent's headers or its secret
    const got = up.seen[0];
    assert.equal(got.url, '/v1/chat/completions');
    assert.equal(got.headers.authorization, `Bearer ${KEY}`);
    assert.equal(got.headers['x-no-aliasing'], 'true');
    assert.equal(got.headers['x-agent-header'], undefined);
    assert.equal(got.headers.cookie, undefined);
    assert.ok(!JSON.stringify(got.headers).includes(SECRET) && !got.body.toString().includes(SECRET));
    // the agent side got the body and a content type — no upstream header, no key
    assert.equal(r.headers.get('x-upstream-secret-header'), null);
    assert.ok(![...r.headers].flat().join(' ').includes(KEY) && !text.includes(KEY));
    await b.stop();
    assert.ok(!b.traceText().includes(KEY), 'the key is not in the trace');
    assert.ok(!b.output().includes(KEY), 'nor in what the bridge prints');
    assert.ok(!b.traceText().includes('a private prompt'), 'no message text in the trace');
    assert.ok(!b.traceText().includes(SECRET));
    // the trace binds the call: chat id, and the hashes of the exact bytes sent and received
    const line = b.lines().find((l) => l.kind === 'model' && l.status === 200);
    assert.equal(line.chat_id, 'chatcmpl-test-1');
    assert.equal(line.request_sha256, sha256(got.body));
    assert.equal(line.response_sha256, sha256(got.reply));
    assert.deepEqual(line.tool_calls, [{ name: 'write', arg_bytes: 47, hint: 'filePath=index.html' }]);
    // dollars: (1000-400) × 1e-6 + 400 × 1e-7 + 500 × 2e-6
    assert.ok(Math.abs(line.usd - 0.00164) < 1e-12, `usd ${line.usd}`);
    const down = b.lines().at(-1);
    assert.deepEqual([down.event, down.forwarded, down.refused, down.unpriced_calls], ['down', 1, 1, 0]);
    assert.equal(down.computed_usd, 0.00164);
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('a streamed request goes upstream NON-streamed, and the agent still receives a well-formed event stream', async () => {
  const s = scratch('bridge-stream');
  const up = await upstream();
  try {
    const b = await startBridge(s.dir, up);
    const r = await b.call(ask({ stream: true, stream_options: { include_usage: true } }));
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/event-stream/);
    const sent = JSON.parse(up.seen[0].body.toString());
    assert.equal(sent.stream, undefined, 'upstream was not asked to stream');
    assert.equal(sent.stream_options, undefined);
    assert.equal(up.seen[0].headers['x-no-aliasing'], 'true');
    const frames = (await r.text()).split('\n\n').filter(Boolean);
    assert.ok(frames.every((f) => f.startsWith('data: ')), 'every frame is a data line');
    assert.equal(frames.at(-1), 'data: [DONE]');
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f.slice(6)));
    assert.ok(chunks.every((c) => c.object === 'chat.completion.chunk' && c.id === 'chatcmpl-test-1' && c.model === MODEL));
    const deltas = chunks.flatMap((c) => c.choices.map((x) => x.delta));
    assert.equal(deltas[0].role, 'assistant');
    assert.equal(deltas.map((d) => d.content ?? '').join(''), 'I will write the file.', 'the same content');
    const calls = deltas.flatMap((d) => d.tool_calls ?? []);
    assert.deepEqual([calls[0].index, calls[0].id, calls[0].function.name], [0, 'call_1', 'write']);
    assert.equal(
      calls.map((c) => c.function.arguments ?? '').join(''),
      '{"filePath":"index.html","content":"<p>hi</p>"}',
      'the same tool call arguments',
    );
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(last.usage, JSON.parse(up.seen[0].reply.toString()).usage, 'the same usage');
    // a non-streamed request gets the upstream bytes exactly
    const plain = await b.call(ask());
    assert.equal(sha256(Buffer.from(await plain.arrayBuffer())), sha256(up.seen[1].reply));
    await b.stop();
    assert.equal(b.lines().filter((l) => l.kind === 'model')[0].stream_asked, true);
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('the call budget: the call past --max-calls is refused and never reaches NEAR AI', async () => {
  const s = scratch('bridge-calls');
  const up = await upstream();
  try {
    const b = await startBridge(s.dir, up, { maxCalls: 2 });
    assert.equal((await b.call(ask())).status, 200);
    assert.equal((await b.call(ask())).status, 200);
    const third = await b.call(ask());
    assert.equal(third.status, 429);
    assert.match((await third.json()).error.message, /bridge budget: 2 calls reached/);
    assert.equal(up.seen.length, 2);
    await b.stop();
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('the dollar budget: once the computed spend reaches --max-usd the next call is refused', async () => {
  const s = scratch('bridge-usd');
  const up = await upstream();
  try {
    const b = await startBridge(s.dir, up, { maxUsd: 0.003 }); // each call costs $0.00164
    assert.equal((await b.call(ask())).status, 200, 'under the budget');
    assert.equal((await b.call(ask())).status, 200, 'still under: $0.00164 spent');
    const third = await b.call(ask());
    assert.equal(third.status, 429);
    assert.match((await third.json()).error.message, /bridge budget: \$0\.003 reached \(computed \$0\.0033\)/);
    assert.equal(up.seen.length, 2);
    await b.stop();
    assert.equal(b.lines().at(-1).computed_usd, 0.00328);
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('a model with no price fails closed: the call is counted unpriced and every later call is refused', async () => {
  const s = scratch('bridge-unpriced');
  const up = await upstream({ model: 'someone/unlisted-model' }); // NEAR AI serves a model the table does not price
  try {
    const b = await startBridge(s.dir, up);
    assert.equal((await b.call(ask())).status, 200, 'the first call was already made when its price turned out to be missing');
    const next = await b.call(ask());
    assert.equal(next.status, 429);
    assert.match((await next.json()).error.message, /bridge closed: call 1 could not be priced \(model someone\/unlisted-model\)/);
    assert.equal(up.seen.length, 1);
    await b.stop();
    const down = b.lines().at(-1);
    assert.equal(down.unpriced_calls, 1);
    assert.equal(down.computed_usd, 0);
    assert.equal(b.lines().find((l) => l.kind === 'model').unpriced, true);
  } finally {
    await up.close();
    s.cleanup();
  }
  // the other direction: the same served id priced under its provider prefix alone is priced
  const s2 = scratch('bridge-priced');
  const up2 = await upstream({ model: 'test-model' });
  try {
    const b = await startBridge(s2.dir, up2);
    assert.equal((await b.call(ask())).status, 200);
    assert.equal((await b.call(ask())).status, 200, 'priced: the bridge stays open');
    await b.stop();
    assert.equal(b.lines().at(-1).unpriced_calls, 0);
  } finally {
    await up2.close();
    s2.cleanup();
  }
});

test('a response with no usage cannot be priced either: closed', async () => {
  const s = scratch('bridge-nousage');
  const up = await upstream({ usage: null });
  try {
    const b = await startBridge(s.dir, up);
    assert.equal((await b.call(ask())).status, 200);
    assert.equal((await b.call(ask())).status, 429);
    await b.stop();
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('another model, a readable key file, another path: all refused before NEAR AI is called', async () => {
  const s = scratch('bridge-refusals');
  const up = await upstream();
  try {
    const b = await startBridge(s.dir, up, { keyMode: 0o644 });
    const other = await b.call(ask({ model: 'expensive/other-model' }));
    assert.equal(other.status, 403);
    assert.match((await other.json()).error.message, /metered for the model test-org\/test-model only/);
    const loose = await b.call(ask());
    assert.equal(loose.status, 503, 'a key file that is not mode 600 is not used');
    const path = await fetch(`http://127.0.0.1:${b.port}/v1/models`, { headers: { authorization: `Bearer ${SECRET}` } });
    assert.equal(path.status, 404);
    assert.equal(up.seen.length, 0);
    await b.stop();
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('the tunnel: only registry.npmjs.org:443 is allowed; other hosts and plain HTTP are refused', async () => {
  const s = scratch('bridge-tunnel');
  const up = await upstream();
  const connectVia = (port, target) =>
    new Promise((resolve) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`));
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        if (buf.includes('\r\n')) {
          sock.destroy();
          resolve(buf.split('\r\n')[0]);
        }
      });
      sock.on('error', () => resolve('error'));
      sock.setTimeout(8000, () => {
        sock.destroy();
        resolve('timeout');
      });
    });
  try {
    const b = await startBridge(s.dir, up);
    for (const target of ['example.com:443', 'github.com:443', 'registry.npmjs.org:80', `127.0.0.1:${up.port}`, 'cloud-api.near.ai:443']) {
      assert.match(await connectVia(b.proxyPort, target), /^HTTP\/1\.1 403/, target);
    }
    const plain = await fetch(`http://127.0.0.1:${b.proxyPort}/anything`);
    assert.equal(plain.status, 403);
    await b.stop();
    const egress = b.lines().filter((l) => l.kind === 'egress');
    assert.equal(egress.length, 6);
    assert.ok(egress.every((l) => l.allowed === false));
    assert.deepEqual(b.lines()[0].allow, ['registry.npmjs.org:443'], 'the allow-list is exactly the registry');
  } finally {
    await up.close();
    s.cleanup();
  }
});

test('a client that resets its connection on a refused tunnel does not stop the bridge', async () => {
  const { connect } = await import('node:net');
  const s = scratch('bridge-reset');
  const up = await upstream();
  let b = null;
  try {
    b = await startBridge(s.dir, up);
    for (let i = 0; i < 5; i++) {
      await new Promise((res) => {
        const c = connect(b.proxyPort, '127.0.0.1', () => {
          c.write('CONNECT github.com:443 HTTP/1.1\r\nHost: github.com:443\r\n\r\n');
          c.resetAndDestroy();
          res();
        });
        c.on('error', res);
      });
    }
    await new Promise((r) => setTimeout(r, 300));
    const after = await b.call(ask());
    assert.equal(after.status, 200, 'the model door still answers after the resets');
    assert.ok(b.lines().some((l) => l.kind === 'egress' && l.allowed === false), 'the refusals are on the trace');
  } finally {
    if (b) await b.stop();
    await up.close();
    s.cleanup();
  }
});
