#!/usr/bin/env node
// bridge.mjs — the only two doors a sandboxed coding agent has, both on loopback:
//
//   1. 127.0.0.1:<port>   POST /v1/chat/completions → NEAR AI Cloud over HTTPS. The agent presents a per-run
//      secret; the bridge swaps it for the real key (read from its file at use time, never logged, never sent
//      back) and forwards the body and nothing the agent sent as a header. Upstream calls are always
//      non-streaming with `x-no-aliasing: true` (the kind NEAR AI signs inside the model's TEE); an agent
//      that asked for a stream gets one replayed from the complete response. It stops forwarding at a call
//      budget or a dollar budget, and for good after a call it could not price (fail closed).
//   2. 127.0.0.1:<proxy>  an HTTP CONNECT proxy that tunnels to the allow-listed hosts only (registry.npmjs.org:443).
//
// Dollars are computed per call from the response's `usage` and a pricing table file handed to the bridge:
//   { "<model id>": { "prompt": <usd per token>, "completion": <usd per token>, "input_cache_read": <usd per token>|null } }
// Every model call and every tunnel attempt is one line in the trace (JSONL): sizes, names, usage, dollars, the
// response's chat id, and the sha256 of the exact request bytes forwarded and of the full response bytes — so an
// attestation fetched later can be bound to this call. No message text is written.
//
// With --unix-dir <dir> both doors also listen on <dir>/bridge.sock and <dir>/proxy.sock, for a sandbox that has
// its own empty network namespace (see kit/sandbox.mjs). With --base none there is no model behind the bridge.
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect } from 'node:net';
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? process.argv[i + 1] : d;
};
const BASE = arg('base', 'none'), KEY_FILE = arg('key-file'), PRICING_FILE = arg('pricing');
const SECRET_FILE = arg('secret-file'), TRACE = arg('trace'), UNIX_DIR = arg('unix-dir');
const PORT = Number(arg('port')), PROXY_PORT = Number(arg('proxy-port'));
const MODEL = arg('model'), SESSION = arg('session', 'run');
const MAX_CALLS = Number(arg('max-calls', '60')), MAX_USD = Number(arg('max-usd', '2.5'));
const ALLOW = new Set(arg('allow', 'registry.npmjs.org:443').split(','));
for (const [k, v] of Object.entries({ 'secret-file': SECRET_FILE, trace: TRACE, port: PORT, 'proxy-port': PROXY_PORT })) {
  if (!v) {
    console.error(`bridge: --${k} is required`);
    process.exit(2);
  }
}
const LIVE = BASE !== 'none';
let upstream = null;
if (LIVE) {
  upstream = new URL(BASE.replace(/\/+$/, '') + '/chat/completions');
  const loopback = ['127.0.0.1', 'localhost'].includes(upstream.hostname);
  if (upstream.protocol !== 'https:' && !(upstream.protocol === 'http:' && loopback)) {
    console.error('bridge: --base must be https (plain http only on loopback)');
    process.exit(2);
  }
  if (!KEY_FILE || !PRICING_FILE) {
    console.error('bridge: --key-file and --pricing are required with --base');
    process.exit(2);
  }
}

const mode600 = (p) => {
  const st = statSync(p);
  if ((st.mode & 0o777) !== 0o600) throw new Error(`${p} must be mode 600`);
  return readFileSync(p, 'utf8').trim();
};
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const secret = mode600(SECRET_FILE);
const pricingRead = LIVE ? JSON.parse(readFileSync(PRICING_FILE, 'utf8')) : {};
const pricing = pricingRead.models ?? pricingRead; // the bare table, or NEAR AI's {models: {...}} wrapper around it
const trace = (o) => appendFileSync(TRACE, JSON.stringify({ t: new Date().toISOString(), ...o }) + '\n');

/** The price row for a model id: an exact match, else the ONE priced id that differs by its provider prefix alone. */
function priceRow(model) {
  if (typeof model !== 'string' || !model) return null;
  if (Object.hasOwn(pricing, model)) return pricing[model];
  const bare = (id) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
  const hits = Object.keys(pricing).filter((id) => bare(id) === bare(model));
  return hits.length === 1 ? pricing[hits[0]] : null;
}
/** Dollars for one call, or null when it cannot be priced (no usage, or no price for the model that served it). */
function usdOf(model, usage) {
  const p = priceRow(model);
  if (!usage || !p || !Number.isFinite(p.prompt) || !Number.isFinite(p.completion)) return null;
  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cachedRate = Number.isFinite(p.input_cache_read) ? p.input_cache_read : p.prompt;
  return ((usage.prompt_tokens ?? 0) - cached) * p.prompt + cached * cachedRate + (usage.completion_tokens ?? 0) * p.completion;
}

let seq = 0, forwarded = 0, spent = 0, unpriced = 0, closed = null;
const HINT_KEYS = ['command', 'filePath', 'file_path', 'path', 'pattern', 'url', 'description'];
const hint = (args) => {
  try {
    const j = JSON.parse(args);
    for (const k of HINT_KEYS) if (typeof j[k] === 'string') return `${k}=${j[k].slice(0, 100)}`;
  } catch { /* partial */ }
  return null;
};

function refuse(res, status, message, extra = {}) {
  trace({ kind: 'model', seq: ++seq, refused: message, status, ...extra });
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message, type: 'bridge_refusal' } }));
}

/** What one (non-streamed) response says, read without keeping any message text. */
function readResponse(text) {
  const out = { json: null, usage: null, finish: null, model: null, chat_id: null, chars: 0, err: null, calls: [] };
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    out.err = text.slice(0, 200);
    return out;
  }
  out.json = o;
  out.model = o.model ?? null;
  out.chat_id = typeof o.id === 'string' ? o.id : null;
  out.usage = o.usage ?? null;
  if (o.error) out.err = String(o.error.message ?? o.error).slice(0, 200);
  for (const c of o.choices ?? []) {
    if (c.finish_reason) out.finish = c.finish_reason;
    const m = c.message ?? {};
    if (typeof m.content === 'string') out.chars += m.content.length;
    for (const tc of m.tool_calls ?? []) out.calls.push({ name: tc.function?.name ?? null, args: String(tc.function?.arguments ?? '') });
  }
  return out;
}

/**
 * A complete chat completion, replayed as the event stream a streaming client expects: a role chunk, the
 * content, each tool call (its id and name, then its arguments), a last chunk with the finish reason and the
 * usage, then [DONE]. Same content, same tool calls, same usage — only the framing differs.
 */
function asEventStream(o) {
  const head = { id: o.id, object: 'chat.completion.chunk', created: o.created ?? Math.floor(Date.now() / 1000), model: o.model };
  const frames = [];
  const push = (choices, extra = {}) => frames.push(`data: ${JSON.stringify({ ...head, choices, ...extra })}\n\n`);
  const choices = Array.isArray(o.choices) && o.choices.length ? o.choices : [{ index: 0, message: {}, finish_reason: 'stop' }];
  for (const c of choices) {
    const index = c.index ?? 0;
    const m = c.message ?? {};
    const delta = (d) => push([{ index, delta: d, finish_reason: null }]);
    delta({ role: m.role ?? 'assistant', content: '' });
    for (const k of ['reasoning_content', 'reasoning']) if (typeof m[k] === 'string' && m[k]) delta({ [k]: m[k] });
    if (typeof m.content === 'string' && m.content) delta({ content: m.content });
    (m.tool_calls ?? []).forEach((tc, i) => {
      delta({ tool_calls: [{ index: i, id: tc.id, type: tc.type ?? 'function', function: { name: tc.function?.name, arguments: '' } }] });
      delta({ tool_calls: [{ index: i, function: { arguments: String(tc.function?.arguments ?? '') } }] });
    });
  }
  push(
    choices.map((c) => ({ index: c.index ?? 0, delta: {}, finish_reason: c.finish_reason ?? 'stop' })),
    o.usage ? { usage: o.usage } : {},
  );
  frames.push('data: [DONE]\n\n');
  return frames.join('');
}

// Every upstream call is NON-streaming and carries `x-no-aliasing: true`: that is the kind of call NEAR AI
// signs inside the model's own TEE, over exactly these request bytes and exactly the response bytes received.
// An agent that asked for a stream still gets one — replayed here from the complete response.
function forward(req, res, chunks) {
  let j;
  try {
    j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return refuse(res, 400, 'request body must be JSON');
  }
  if (MODEL && j.model !== MODEL) {
    return refuse(res, 403, `bridge: this run is metered for the model ${MODEL} only`, { model_asked: String(j.model ?? '').slice(0, 80) });
  }
  let key;
  try {
    key = mode600(KEY_FILE);
  } catch {
    return refuse(res, 503, 'bridge: the key file is unreadable or not mode 600');
  }
  const stream = j.stream === true;
  delete j.stream;
  delete j.stream_options;
  const body = Buffer.from(JSON.stringify(j), 'utf8');
  const n = ++seq;
  forwarded++;
  const t0 = Date.now();
  const line = {
    kind: 'model',
    seq: n,
    stream_asked: stream,
    model_asked: j.model ?? null,
    messages: Array.isArray(j.messages) ? j.messages.length : null,
    last_role: j.messages?.at?.(-1)?.role ?? null,
    tools_offered: Array.isArray(j.tools) ? j.tools.length : 0,
    max_tokens: j.max_tokens ?? j.max_completion_tokens ?? null,
    req_bytes: body.length,
    request_sha256: sha256(body),
  };
  const scrub = (s) => (s == null ? s : String(s).split(key).join('[key]'));
  // Only these headers go up: the agent's own headers are dropped, and its per-run secret never leaves this machine.
  const headers = {
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    'content-length': body.length,
    'x-no-aliasing': 'true',
  };
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;
  const up = send(upstream, { method: 'POST', headers }, (ur) => {
    const bufs = [];
    ur.on('data', (c) => bufs.push(c));
    ur.on('end', () => {
      const raw = Buffer.concat(bufs);
      const ok = ur.statusCode === 200;
      const r = readResponse(raw.toString('utf8'));
      if (stream && ok && r.json) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(asEventStream(r.json));
      } else res.writeHead(ur.statusCode, { 'content-type': ur.headers['content-type'] ?? 'application/json' }).end(raw);
      const usd = usdOf(r.model ?? j.model, r.usage);
      if (ok && usd === null) {
        unpriced++;
        closed = `call ${n} could not be priced (model ${r.model ?? j.model ?? '?'}${r.usage ? '' : ', no usage'})`;
      }
      spent += usd ?? 0;
      trace({
        ...line,
        status: ur.statusCode,
        ms: Date.now() - t0,
        model_served: r.model,
        chat_id: r.chat_id,
        finish: r.finish,
        text_chars: r.chars,
        tool_calls: r.calls.map((c) => ({ name: c.name, arg_bytes: c.args.length, hint: hint(c.args) })),
        usage: r.usage,
        usd,
        unpriced: ok && usd === null,
        spent_usd: Number(spent.toFixed(6)),
        resp_bytes: raw.length,
        response_sha256: sha256(raw),
        error: scrub(r.err),
      });
    });
  });
  up.on('error', (e) => {
    trace({ ...line, status: 502, ms: Date.now() - t0, error: `upstream: ${e.code ?? scrub(e.message)}` });
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'bridge: the model provider did not answer', type: 'bridge_upstream' } }));
  });
  res.on('close', () => {
    if (!res.writableFinished) up.destroy();
  });
  up.end(body);
}

const onModel = (req, res) => {
  if (req.method !== 'POST' || req.url.split('?')[0] !== '/v1/chat/completions') {
    return refuse(res, 404, `not bridged: ${req.method} ${req.url.slice(0, 80)}`);
  }
  if ((req.headers.authorization ?? '') !== `Bearer ${secret}`) return refuse(res, 401, 'unauthorized');
  if (!LIVE) return refuse(res, 503, 'bridge: no model is behind this bridge (offline, or a checks-only bridge)');
  if (closed) return refuse(res, 429, `bridge closed: ${closed}`);
  if (forwarded >= MAX_CALLS) return refuse(res, 429, `bridge budget: ${MAX_CALLS} calls reached`);
  if (spent >= MAX_USD) return refuse(res, 429, `bridge budget: $${MAX_USD} reached (computed $${spent.toFixed(4)})`);
  const chunks = [];
  let size = 0;
  req.on('data', (c) => {
    size += c.length;
    if (size > 16e6) {
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => forward(req, res, chunks));
};

// The allow-list tunnel: CONNECT host:port only, and only for the named hosts.
const onPlain = (req, res) => {
  trace({ kind: 'egress', method: req.method, target: String(req.url).slice(0, 120), allowed: false, why: 'plain HTTP is not tunnelled' });
  res.writeHead(403, { 'content-type': 'text/plain' }).end('bridge: not allowed\n');
};
const onConnect = (req, sock) => {
  const target = String(req.url);
  // A client that hangs up on a refusal resets the socket; without a listener that reset would stop the bridge.
  sock.on('error', () => {});
  if (!ALLOW.has(target)) {
    trace({ kind: 'egress', method: 'CONNECT', target: target.slice(0, 120), allowed: false });
    sock.end('HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n');
    return;
  }
  const [host, port] = target.split(':');
  let up = 0, down = 0;
  const t0 = Date.now();
  const remote = connect(Number(port), host, () => {
    sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    remote.pipe(sock);
    sock.pipe(remote);
  });
  remote.on('data', (c) => {
    down += c.length;
  });
  sock.on('data', (c) => {
    up += c.length;
  });
  let did = false;
  const done = () => {
    if (did) return;
    did = true;
    trace({ kind: 'egress', method: 'CONNECT', target, allowed: true, up, down, ms: Date.now() - t0 });
    remote.destroy();
    sock.destroy();
  };
  remote.on('error', done);
  sock.on('error', done);
  remote.on('close', done);
  sock.on('close', done);
};

const servers = [];
const listen = (handler, where, isProxy) =>
  new Promise((resolve, reject) => {
    const s = createServer(handler);
    if (isProxy) s.on('connect', onConnect);
    s.once('error', reject);
    servers.push(s);
    if (typeof where === 'number') s.listen(where, '127.0.0.1', resolve);
    else s.listen(where, resolve);
  });
const doors = [listen(onModel, PORT, false), listen(onPlain, PROXY_PORT, true)];
if (UNIX_DIR) {
  mkdirSync(UNIX_DIR, { recursive: true, mode: 0o700 });
  for (const f of ['bridge.sock', 'proxy.sock']) rmSync(join(UNIX_DIR, f), { force: true });
  doors.push(listen(onModel, join(UNIX_DIR, 'bridge.sock'), false), listen(onPlain, join(UNIX_DIR, 'proxy.sock'), true));
}
Promise.all(doors).then(() => {
  const to = LIVE ? upstream.origin : 'no model';
  trace({
    kind: 'bridge',
    event: 'up',
    port: PORT,
    proxy_port: PROXY_PORT,
    upstream: to,
    model: MODEL,
    session: SESSION,
    max_calls: MAX_CALLS,
    max_usd: MAX_USD,
    allow: [...ALLOW],
    unix: !!UNIX_DIR,
  });
  console.log(`bridge up 127.0.0.1:${PORT} → ${to}; tunnel 127.0.0.1:${PROXY_PORT} → ${[...ALLOW].join(', ')}`);
}, (e) => {
  console.error(`bridge: could not listen (${e.code ?? e.message})`);
  process.exit(1);
});

const stop = () => {
  trace({
    kind: 'bridge',
    event: 'down',
    forwarded,
    refused: seq - forwarded,
    computed_usd: Number(spent.toFixed(6)),
    unpriced_calls: unpriced,
    closed,
  });
  if (UNIX_DIR) { for (const f of ['bridge.sock', 'proxy.sock']) rmSync(join(UNIX_DIR, f), { force: true }); }
  process.exit(0);
};
// One broken connection must never take the agent's only door away mid-run: note it and keep serving.
process.on('uncaughtException', (e) => {
  try { trace({ kind: 'bridge', event: 'error', error: String(e?.code ?? e?.message ?? e).slice(0, 160) }); } catch { /* the trace is gone too */ }
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
