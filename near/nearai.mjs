// NEAR AI Cloud client: pricing, non-streaming chat, and response attestation.
//
// Guarantees:
// - Zero dependencies. Every network call goes through an injectable `fetchImpl`.
// - The API key is read from a mode-600 file at the moment of use. It is never logged,
//   never returned, and is scrubbed from any error message.
// - `chat` hashes the exact request bytes it sends and the exact response bytes it receives.
// - `verifyAttestation` is pure and offline. It really performs every check that needs no
//   network, and lists the checks that need an online verifier as skipped, with the reason.
//
// What NEAR AI Cloud signs (see near/ATTESTATION.md for the evidence):
//   signature_kind "provider_tee": text = "<model>:<sha256 request>:<sha256 response>", signed
//     by a key that lives in the model's TEE (non-streaming calls to models NEAR AI hosts).
//   signature_kind "gateway":      text = "<sha256 request>:<sha256 response>", signed by the
//     gateway's TEE key (streamed calls, and models proxied to outside providers).
// The signing key is bound to hardware by an Intel TDX quote whose report data carries the
// signing identity and the nonce the report was requested with.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_BASE = 'https://cloud-api.near.ai/v1';

// SHA-256 of the DER public key of "Intel SGX Root CA", the root of every TDX quote's
// certificate chain. Source: certificates.trustedservices.intel.com (root valid until 2049).
export const INTEL_SGX_ROOT_SPKI_SHA256 = 'a0af031289f5d5d4132f9186068a7fc13628633ba235777472e29b6b6c67a49e';

const sha256 = (...parts) => {
  const h = crypto.createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};
export const sha256Hex = (bytes) => sha256(bytes).toString('hex');
const unhex = (s) => Buffer.from(String(s).replace(/^0x/i, ''), 'hex');
const isHex = (s, bytes) => typeof s === 'string' && new RegExp(`^(0x)?[0-9a-fA-F]{${bytes * 2}}$`).test(s);
const trimBase = (base) => String(base || DEFAULT_BASE).replace(/\/+$/, '');

// ---------------------------------------------------------------------------------------
// Key handling
// ---------------------------------------------------------------------------------------

export function defaultKeyFile() {
  return process.env.NEARAI_KEY_FILE || path.join(os.homedir(), '.cambrian-secrets', 'baby-nearai.key');
}

// True when a key file exists: the app runs LIVE. No key file: REPLAY, nothing spends.
export function hasKey(file = defaultKeyFile()) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

// Reads the key. Refuses a file that group or others can read. Errors name the file, never its content.
export function readKey(file = defaultKeyFile()) {
  let st;
  try { st = fs.statSync(file); } catch { throw new Error(`NEAR AI key file not found: ${file}`); }
  if (!st.isFile()) throw new Error(`NEAR AI key file is not a regular file: ${file}`);
  if (st.mode & 0o077) {
    throw new Error(`NEAR AI key file must be mode 600 (found ${(st.mode & 0o777).toString(8)}): ${file}`);
  }
  const key = fs.readFileSync(file, 'utf8').trim();
  if (!key) throw new Error(`NEAR AI key file is empty: ${file}`);
  if (/\s/.test(key)) throw new Error(`NEAR AI key file must hold exactly one token: ${file}`);
  return key;
}

const scrub = (text, key) => (key ? String(text).split(key).join('[key]') : String(text));

// ---------------------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------------------

const price = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};

// GET <base>/models -> prices in USD per token, exactly as NEAR AI publishes them.
export async function fetchPricing({ keyFile, base, fetchImpl = fetch } = {}) {
  const key = readKey(keyFile);
  const url = `${trimBase(base)}/models`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
  } catch (e) {
    throw new Error(`pricing fetch failed: ${scrub(e && e.message, key)}`);
  }
  if (!res.ok) throw new Error(`pricing fetch failed: HTTP ${res.status}`);
  const body = await res.json();
  if (!body || !Array.isArray(body.data)) throw new Error('pricing fetch failed: response has no data[]');
  const models = {};
  for (const m of body.data) {
    if (!m || typeof m.id !== 'string' || !m.pricing) continue;
    const prompt = price(m.pricing.prompt);
    const completion = price(m.pricing.completion);
    if (prompt === null || completion === null) continue;
    models[m.id] = { prompt, completion, input_cache_read: price(m.pricing.input_cache_read) };
  }
  return { fetched_at: new Date().toISOString(), source: url, models };
}

// The pricing id for a model id. Exact match first. Otherwise the id is accepted only when
// it differs from exactly ONE priced id by the provider prefix alone (the part up to the
// first "/"): the API serves "claude-haiku-5-5" for "anthropic/claude-haiku-5-5". Matching
// is case-sensitive. Two candidates, or none, resolve to null: an ambiguous call is unpriced.
export function resolvePricedModel(pricing, model) {
  const models = (pricing && pricing.models) || {};
  if (typeof model !== 'string' || !model) return null;
  if (Object.hasOwn(models, model)) return model;
  const bare = (id) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
  const hits = Object.keys(models).filter((id) => bare(id) === bare(model));
  return hits.length === 1 ? hits[0] : null;
}

// USD for one call, or null when the model has no price or the usage is unusable.
// Cached prompt tokens are billed at input_cache_read when NEAR AI publishes one.
export function priceCall(pricing, model, usage) {
  const id = resolvePricedModel(pricing, model);
  if (!id || !usage) return null;
  const p = pricing.models[id];
  const prompt = Number(usage.prompt_tokens);
  const completion = Number(usage.completion_tokens ?? 0);
  if (!Number.isFinite(prompt) || !Number.isFinite(completion) || prompt < 0 || completion < 0) return null;
  const details = usage.prompt_tokens_details || {};
  const cached = Math.min(prompt, Math.max(0, Number(details.cached_tokens) || 0));
  const cachedRate = p.input_cache_read === null ? p.prompt : p.input_cache_read;
  const usd = (prompt - cached) * p.prompt + cached * cachedRate + completion * p.completion;
  return Number(usd.toFixed(12));
}

// ---------------------------------------------------------------------------------------
// Chat (non-streaming)
// ---------------------------------------------------------------------------------------

// One chat completion. Never throws for an HTTP or network failure: returns ok:false with
// the status (0 = no response). `usd` is priced from `pricing` (see fetchPricing) and is
// null when no pricing was passed or the model is unpriced.
// `x-no-aliasing: true` makes the API refuse a model alias instead of rewriting it, which
// is what lets a model TEE sign "<model>:<request hash>:<response hash>" for these bytes.
// `signal` (an AbortSignal) lets a caller give up on a call that does not answer; it is not part of the request.
export async function chat({ model, messages, max_tokens, keyFile, base, fetchImpl = fetch, pricing, signal, ...rest } = {}) {
  if (typeof model !== 'string' || !model) throw new Error('chat: model is required');
  if (!Array.isArray(messages) || !messages.length) throw new Error('chat: messages are required');
  if (rest.stream) throw new Error('chat: non-streaming only');
  const key = readKey(keyFile);
  const payload = { model, messages, ...rest };
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  const requestBytes = Buffer.from(JSON.stringify(payload), 'utf8');
  // The exact bytes as text, so a caller can keep them: null when they hold the key, or are not
  // utf8 that reads back to the same bytes (then the text would not hash to the recorded sha256).
  const exact = (bytes) => {
    const text = bytes.toString('utf8');
    return text.includes(key) || !Buffer.from(text, 'utf8').equals(bytes) ? null : text;
  };
  const out = {
    ok: false, status: 0, id: null, model, content: null, usage: null, usd: null,
    request_sha256: sha256Hex(requestBytes), response_sha256: null, raw: null,
    request_body: exact(requestBytes), response_body: null,
  };
  let res;
  let responseBytes;
  try {
    res = await fetchImpl(`${trimBase(base)}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'x-no-aliasing': 'true',
      },
      body: requestBytes,
      ...(signal ? { signal } : {}),
    });
    // fetch hands back the decompressed body: the bytes the signature covers.
    responseBytes = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return { ...out, status: res ? res.status : 0, error: scrub(e && e.message, key) };
  }
  out.status = res.status;
  out.response_sha256 = sha256Hex(responseBytes);
  out.response_body = exact(responseBytes);
  // A server that echoes the key back does not get it into the result: raw is parsed from scrubbed text.
  try { out.raw = JSON.parse(scrub(responseBytes.toString('utf8'), key)); } catch { out.raw = null; }
  const raw = out.raw;
  if (!res.ok || !raw || typeof raw !== 'object') {
    const msg = raw && raw.error && (raw.error.message || raw.error);
    return { ...out, error: scrub(msg ? String(msg) : `HTTP ${res.status}`, key) };
  }
  const message = raw.choices && raw.choices[0] && raw.choices[0].message;
  out.id = typeof raw.id === 'string' ? raw.id : null;
  out.model = typeof raw.model === 'string' ? raw.model : model;
  out.content = message && typeof message.content === 'string' ? message.content : null;
  out.usage = raw.usage || null;
  out.usd = pricing ? priceCall(pricing, out.model, out.usage) ?? priceCall(pricing, model, out.usage) : null;
  out.ok = Boolean(message);
  return out;
}

// One streamed chat completion: `onText(delta)` is called as the text arrives. Used for conversation, where
// nothing is signed or kept by hash. Never throws for an HTTP or network failure. `usd` is priced from the
// usage the API reports in its last chunk; null when it reports none or the model has no price.
export async function chatStream({ model, messages, max_tokens, keyFile, base, fetchImpl = fetch, pricing, signal, onText = () => {} } = {}) {
  if (typeof model !== 'string' || !model) throw new Error('chatStream: model is required');
  if (!Array.isArray(messages) || !messages.length) throw new Error('chatStream: messages are required');
  const key = readKey(keyFile);
  const payload = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (max_tokens !== undefined) payload.max_tokens = max_tokens;
  const out = { ok: false, status: 0, model, content: '', usage: null, usd: null };
  try {
    const res = await fetchImpl(`${trimBase(base)}/chat/completions`, { method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(payload),
      ...(signal ? { signal } : {}) });
    out.status = res.status;
    if (!res.ok || !res.body) return { ...out, error: scrub(`HTTP ${res.status}`, key) };
    const decoder = new TextDecoder(); let buf = '';
    const take = (line) => {
      if (!line.startsWith('data:')) return;
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') return;
      let j; try { j = JSON.parse(data); } catch { return; }
      if (j.usage) out.usage = j.usage;
      if (typeof j.model === 'string') out.model = j.model;
      const delta = j.choices?.[0]?.delta?.content;
      if (typeof delta === 'string' && delta) { out.content += delta; onText(delta); }
    };
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let i; while ((i = buf.indexOf('\n')) >= 0) { take(buf.slice(0, i).trimEnd()); buf = buf.slice(i + 1); }
    }
    take(buf.trim());
  } catch (e) { return { ...out, error: scrub(e && e.message, key) }; }
  out.usd = pricing ? priceCall(pricing, out.model, out.usage) ?? priceCall(pricing, model, out.usage) : null;
  out.ok = out.content.length > 0;
  return out.ok ? out : { ...out, error: 'the model sent no text' };
}

// ---------------------------------------------------------------------------------------
// Attestation: fetch
// ---------------------------------------------------------------------------------------

const ALGOS = new Set(['ed25519', 'ecdsa']);

// GET <base>/attestation/report: the gateway's TDX report and, for a model NEAR AI hosts in
// a TEE, that model's report(s). Public endpoint: the key is not sent. `nonce` is 32 random
// bytes chosen here; the quote must carry it. A proxied model (anthropic/*, openai/*, ...)
// has no report: the API answers 503 and this returns null.
export async function fetchReport({ model, signingAlgo = 'ed25519', nonce, base, fetchImpl = fetch } = {}) {
  if (!ALGOS.has(signingAlgo)) throw new Error(`unsupported signing algorithm: ${signingAlgo}`);
  const n = nonce || crypto.randomBytes(32).toString('hex');
  if (!isHex(n, 32)) throw new Error('nonce must be 32 bytes of hex');
  const q = new URLSearchParams({ signing_algo: signingAlgo, nonce: n });
  if (model) { q.set('model', model); q.set('provider', 'near'); }
  const res = await fetchImpl(`${trimBase(base)}/attestation/report?${q}`, {
    headers: { accept: 'application/json', 'x-no-aliasing': 'true' },
  });
  if (!res.ok) return null;
  const raw = await res.json();
  if (!raw || !raw.gateway_attestation) return null;
  return { nonce: n, signing_algo: signingAlgo, fetched_at: new Date().toISOString(), raw };
}

// The part of one report that the offline checks need. The GPU evidence (about 100 kB) is
// replaced by its hash: it is only useful to NVIDIA's online verifier, at fetch time.
export function trimReport(candidate, fetchedAt = null) {
  if (!candidate || typeof candidate !== 'object') return null;
  const tcb = (candidate.info && candidate.info.tcb_info) || {};
  const tcbInfo = typeof tcb === 'string' ? JSON.parse(tcb) : tcb;
  const log = candidate.event_log;
  const out = {
    model_name: candidate.model_name || null,
    signing_address: candidate.signing_address,
    signing_algo: candidate.signing_algo,
    request_nonce: candidate.request_nonce,
    intel_quote: candidate.intel_quote,
    event_log: typeof log === 'string' ? JSON.parse(log) : log || [],
    app_compose: tcbInfo.app_compose ?? null,
    fetched_at: fetchedAt,
  };
  if (candidate.tls_cert_fingerprint) out.tls_cert_fingerprint = candidate.tls_cert_fingerprint;
  if (candidate.nvidia_payload) out.nvidia_payload_sha256 = sha256Hex(Buffer.from(candidate.nvidia_payload, 'utf8'));
  return out;
}

const sameSigner = (a, b) => Boolean(a && b) && a.signing_algo === b.signing_algo
  && typeof a.signing_address === 'string' && typeof b.signing_address === 'string'
  && a.signing_address.toLowerCase() === b.signing_address.toLowerCase();

// The reports the signature could match: the gateway's for kind "gateway", and for "provider_tee" every model
// report that names the same signer. NEAR AI can run one model in more than one TEE with the same signing key, so
// there may be several; each is a report for this signer.
function reportCandidates(reportResponse, sig) {
  const raw = reportResponse && reportResponse.raw;
  if (!raw) return [];
  const at = reportResponse.fetched_at || null;
  if (sig.signature_kind === 'gateway') {
    return sameSigner(raw.gateway_attestation, sig) ? [trimReport(raw.gateway_attestation, at)] : [];
  }
  return (raw.model_attestations || []).filter((c) => sameSigner(c, sig)).map((c) => trimReport(c, at));
}

// The signature NEAR AI Cloud recorded for one completion, with the TEE report of its
// signer. Returns null when there is none (the API answers 404, or 2xx with an error body).
//
// `report` is a result of fetchReport taken BEFORE the completion with the same algorithm;
// pass it so one report serves a whole run. Without it a report is fetched now.
// A 404 is retried a few times: the signature can lag the completion by a moment.
export async function fetchAttestation({
  chatId, model, requestSha256, responseSha256, keyFile, base, fetchImpl = fetch,
  signingAlgo = 'ed25519', report, retries = 3, retryMs = 700,
} = {}) {
  if (typeof chatId !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(chatId)) return null;
  if (!ALGOS.has(signingAlgo)) throw new Error(`unsupported signing algorithm: ${signingAlgo}`);
  const key = readKey(keyFile);
  const url = `${trimBase(base)}/signature/${encodeURIComponent(chatId)}?signing_algo=${signingAlgo}`;
  let sig = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { authorization: `Bearer ${key}`, accept: 'application/json' } });
    } catch (e) {
      throw new Error(`signature fetch failed: ${scrub(e && e.message, key)}`);
    }
    if (res.status === 404 && attempt < retries) {
      await new Promise((r) => setTimeout(r, retryMs));
      continue;
    }
    if (!res.ok) return null;
    sig = await res.json();
    break;
  }
  if (!sig || sig.error_code || typeof sig.text !== 'string' || typeof sig.signature !== 'string') return null;
  if (!ALGOS.has(sig.signing_algo) || typeof sig.signing_address !== 'string') return null;
  const preflight = Boolean(report);
  const reportResponse = report || await fetchReport({
    model: sig.signature_kind === 'provider_tee' ? model : undefined, signingAlgo: sig.signing_algo, base, fetchImpl,
  });
  const att = {
    kind: sig.signature_kind || null,
    model: model || null,
    chat_id: chatId,
    signing_algo: sig.signing_algo,
    signing_address: sig.signing_address,
    text: sig.text,
    signature: sig.signature,
    request_sha256: requestSha256 || null,
    response_sha256: responseSha256 || null,
    report: null,
    fetched_at: new Date().toISOString(),
  };
  // Of the reports that name this signer, the first for which every offline check holds is kept; if none holds, the
  // first is kept so that the failing check is the one reported.
  const candidates = reportCandidates(reportResponse, sig).map((c) => ({ ...c, preflight }));
  const hashes = { requestSha256, responseSha256 };
  att.report = candidates.find((c) => verifyAttestation({ ...att, report: c }, hashes).ok) ?? candidates[0] ?? null;
  return att;
}

// A run makes many calls against one report. detachReport returns the attestation with the
// report replaced by its hash, and the report itself, so a record can store the report once.
// verifyAttestation(att, { report }) re-attaches it and refuses a report with another hash.
export function detachReport(att) {
  if (!att || !att.report || att.report.detached) return { att, report: null };
  const report = att.report;
  return { att: { ...att, report: { detached: true, sha256: sha256Hex(JSON.stringify(report)) } }, report };
}

// ---------------------------------------------------------------------------------------
// Attestation: offline verification
// ---------------------------------------------------------------------------------------

// --- Keccak-256 (Ethereum's hash; not the same as SHA3-256, which node:crypto offers) ---
const M64 = (1n << 64n) - 1n;
const rotl = (x, n) => (n === 0n ? x : ((x << n) | (x >> (64n - n))) & M64);
const ROUND_CONSTANTS = (() => {
  const out = [];
  let r = 1;
  for (let round = 0; round < 24; round += 1) {
    let rc = 0n;
    for (let j = 0; j < 7; j += 1) {
      r = ((r << 1) ^ ((r >> 7) * 0x71)) & 0xff;
      if (r & 2) rc ^= 1n << ((1n << BigInt(j)) - 1n);
    }
    out.push(rc);
  }
  return out;
})();

function keccakF(s) {
  for (let round = 0; round < 24; round += 1) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x += 1) {
      const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1n);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    let [x, y] = [1, 0];
    let cur = s[1];
    for (let t = 0; t < 24; t += 1) {
      [x, y] = [y, (2 * x + 3 * y) % 5];
      const i = x + 5 * y;
      const next = s[i];
      s[i] = rotl(cur, BigInt((((t + 1) * (t + 2)) / 2) % 64));
      cur = next;
    }
    for (let row = 0; row < 25; row += 5) {
      const r = s.slice(row, row + 5);
      for (let i = 0; i < 5; i += 1) s[row + i] = r[i] ^ (~r[(i + 1) % 5] & M64 & r[(i + 2) % 5]);
    }
    s[0] ^= ROUND_CONSTANTS[round];
  }
}

export function keccak256(bytes) {
  const input = Buffer.from(bytes);
  const rate = 136;
  const padded = Buffer.alloc((Math.floor(input.length / rate) + 1) * rate);
  input.copy(padded);
  padded[input.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i += 1) s[i] ^= padded.readBigUInt64LE(off + 8 * i);
    keccakF(s);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i += 1) out.writeBigUInt64LE(s[i], 8 * i);
  return out;
}

// --- secp256k1 public-key recovery (Ethereum "personal_sign", EIP-191) ---
const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const G = [
  0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n,
  0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n,
];
const mod = (a, m) => ((a % m) + m) % m;
function powMod(base, exp, m) {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}
const inv = (a, m) => powMod(a, m - 2n, m);
function addPoints(a, b) {
  if (!a) return b;
  if (!b) return a;
  const [x1, y1] = a;
  const [x2, y2] = b;
  if (x1 === x2 && mod(y1 + y2, P) === 0n) return null;
  const slope = x1 === x2 ? mod(3n * x1 * x1 * inv(2n * y1, P), P) : mod((y2 - y1) * inv(x2 - x1, P), P);
  const x3 = mod(slope * slope - x1 - x2, P);
  return [x3, mod(slope * (x1 - x3) - y1, P)];
}
function mulPoint(k, point) {
  let result = null;
  let addend = point;
  for (let e = mod(k, N); e > 0n; e >>= 1n) {
    if (e & 1n) result = addPoints(result, addend);
    addend = addPoints(addend, addend);
  }
  return result;
}
const big = (buf) => BigInt(`0x${buf.toString('hex') || '0'}`);

// The Ethereum address ("0x" + 40 hex) that signed `text`, or null for a malformed signature.
export function recoverEthAddress(text, signatureHex) {
  if (!isHex(signatureHex, 65)) return null;
  const sig = unhex(signatureHex);
  const r = big(sig.subarray(0, 32));
  const s = big(sig.subarray(32, 64));
  const recId = sig[64] >= 27 ? sig[64] - 27 : sig[64];
  if (r <= 0n || r >= N || s <= 0n || s >= N || (recId !== 0 && recId !== 1)) return null;
  const body = Buffer.from(text, 'utf8');
  const z = big(keccak256(Buffer.concat([Buffer.from(`\x19Ethereum Signed Message:\n${body.length}`), body])));
  const ySquared = mod(r * r * r + 7n, P);
  let y = powMod(ySquared, (P + 1n) / 4n, P);
  if ((y * y) % P !== ySquared) return null;
  if (Number(y & 1n) !== recId) y = P - y;
  const rInv = inv(r, N);
  const q = addPoints(mulPoint(mod(-z * rInv, N), G), mulPoint(mod(s * rInv, N), [r, y]));
  if (!q) return null;
  const pub = Buffer.from(q[0].toString(16).padStart(64, '0') + q[1].toString(16).padStart(64, '0'), 'hex');
  return `0x${keccak256(pub).subarray(12).toString('hex')}`;
}

// --- Ed25519: the signing address IS the 32-byte public key ---
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
function verifyEd25519(text, signatureHex, publicKeyHex) {
  if (!isHex(signatureHex, 64) || !isHex(publicKeyHex, 32)) return false;
  const key = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, unhex(publicKeyHex)]), format: 'der', type: 'spki',
  });
  return crypto.verify(null, Buffer.from(text, 'utf8'), key, unhex(signatureHex));
}

// True when `signature` over `text` was made by `signingAddress` under `algo`.
export function verifyTextSignature({ text, signature, signingAddress, algo }) {
  try {
    if (typeof text !== 'string' || typeof signingAddress !== 'string') return false;
    if (algo === 'ed25519') return verifyEd25519(text, signature, signingAddress);
    if (algo === 'ecdsa') {
      const signer = recoverEthAddress(text, signature);
      return isHex(signingAddress, 20) && signer !== null && signer === `0x${unhex(signingAddress).toString('hex')}`;
    }
    return false;
  } catch {
    return false;
  }
}

// --- Intel TDX quote (version 4): layout, and the signature chain up to Intel's root ---
const QUOTE_BODY_END = 632; // 48-byte header + 584-byte TD report
export function parseTdxQuote(hex) {
  const q = unhex(hex);
  if (q.length < QUOTE_BODY_END + 4 + 128 + 6 || q.readUInt16LE(0) !== 4 || q.readUInt32LE(4) !== 0x81) {
    throw new Error('not a version 4 Intel TDX quote');
  }
  const body = q.subarray(48, QUOTE_BODY_END);
  let o = QUOTE_BODY_END + 4;
  const signature = q.subarray(o, o + 64);
  const attestationKey = q.subarray(o + 64, o + 128);
  o += 128;
  if (q.readUInt16LE(o) !== 6) throw new Error('quote carries no QE report certification data');
  o += 6;
  const qeReport = q.subarray(o, o + 384);
  const qeSignature = q.subarray(o + 384, o + 448);
  const authLen = q.readUInt16LE(o + 448);
  const qeAuthData = q.subarray(o + 450, o + 450 + authLen);
  o += 450 + authLen;
  if (q.readUInt16LE(o) !== 5) throw new Error('quote carries no PCK certificate chain');
  const chainLen = q.readUInt32LE(o + 2);
  const pem = q.subarray(o + 6, o + 6 + chainLen).toString('latin1');
  return {
    signed: q.subarray(0, QUOTE_BODY_END),
    tdAttributes: body.subarray(120, 128),
    mrConfigId: body.subarray(184, 232),
    rtmr3: body.subarray(472, 520),
    reportData: body.subarray(520, 584),
    signature, attestationKey, qeReport, qeSignature, qeAuthData,
    certificates: pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) || [],
  };
}

const p256Key = (xy) => crypto.createPublicKey({
  format: 'jwk',
  key: { kty: 'EC', crv: 'P-256', x: xy.subarray(0, 32).toString('base64url'), y: xy.subarray(32).toString('base64url') },
});
const p256Verify = (data, key, sig) => crypto.verify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig);

// Checks the quote's own signature chain with node:crypto alone:
// Intel root (pinned) -> platform CA -> PCK certificate -> quoting enclave report -> attestation key -> TD report.
// It does NOT decide whether the platform's firmware is current or revoked: that needs Intel's online collateral.
export function verifyQuoteChain(quote, at = new Date()) {
  const certs = quote.certificates.map((pem) => new crypto.X509Certificate(pem));
  if (certs.length < 3) return 'certificate chain is incomplete';
  const [leaf, intermediate, root] = certs;
  const rootSpki = root.publicKey.export({ type: 'spki', format: 'der' });
  if (sha256Hex(rootSpki) !== INTEL_SGX_ROOT_SPKI_SHA256) return 'chain does not end at the Intel SGX Root CA';
  if (!root.verify(root.publicKey) || !intermediate.verify(root.publicKey) || !leaf.verify(intermediate.publicKey)) {
    return 'a certificate in the chain is not signed by its issuer';
  }
  for (const c of certs) {
    if (at < new Date(c.validFrom) || at > new Date(c.validTo)) return 'a certificate was not valid when the report was fetched';
  }
  if (!p256Verify(quote.qeReport, leaf.publicKey, quote.qeSignature)) return 'quoting enclave report is not signed by the PCK certificate';
  const bound = sha256(quote.attestationKey, quote.qeAuthData);
  if (!quote.qeReport.subarray(320, 352).equals(bound)) return 'quoting enclave report does not name the attestation key';
  if (!p256Verify(quote.signed, p256Key(quote.attestationKey), quote.signature)) return 'TD report is not signed by the attestation key';
  return null;
}

// RTMR3 as the event log implies it: SHA-384 extension over the events of register 3.
export function replayRtmr3(eventLog) {
  let rtmr3 = Buffer.alloc(48);
  for (const event of eventLog || []) {
    if (event.imr !== 3) continue;
    const type = Buffer.alloc(4);
    type.writeUInt32LE(event.event_type);
    const digest = crypto.createHash('sha384').update(type).update(':').update(Buffer.from(event.event || '', 'utf8'))
      .update(':').update(unhex(event.event_payload || '')).digest();
    if (event.digest && !unhex(event.digest).equals(digest)) throw new Error(`event digest mismatch: ${event.event}`);
    rtmr3 = crypto.createHash('sha384').update(rtmr3).update(digest).digest();
  }
  return rtmr3;
}

const SKIPPED = [
  ['tcb_status', 'needs Intel\'s online collateral (TCB level, quoting-enclave identity, revocation lists)'],
  ['gpu_evidence', 'needs NVIDIA\'s online verifier (NRAS); only a hash of the GPU evidence is kept in the record'],
  ['image_provenance', 'needs an online lookup: is the measured configuration a build NEAR AI published'],
  ['report_freshness', 'the nonce was chosen by whoever fetched the report; a record cannot prove when that was'],
];

// Verifies one attestation offline. `ok` is true only when every check that ran passed.
// Each check is { name, ok, detail } or { name, skipped: true, detail }.
// The hashes default to the ones recorded with the attestation; a verifier that holds the
// request and response bytes passes its own.
export function verifyAttestation(att, { requestSha256, responseSha256, report } = {}) {
  if (!att || typeof att !== 'object') return { ok: false, checks: [], why: 'no attestation' };
  const checks = [];
  const add = (name, fn) => {
    let detail;
    try { detail = fn(); } catch (e) { detail = e && e.message ? e.message : 'check failed'; }
    checks.push({ name, ok: detail === null, detail: detail === null ? 'ok' : detail });
  };
  const req = requestSha256 || att.request_sha256;
  const res = responseSha256 || att.response_sha256;
  let rep = att.report;
  if (rep && rep.detached) {
    rep = report && sha256Hex(JSON.stringify(report)) === rep.sha256 ? report : null;
  }

  add('signature', () => (verifyTextSignature({
    text: att.text, signature: att.signature, signingAddress: att.signing_address, algo: att.signing_algo,
  }) ? null : `the ${att.signing_algo} signature over the text is not by ${att.signing_address}`));

  add('text_binds_hashes', () => {
    if (!isHex(req, 32) || !isHex(res, 32) || /^0x/i.test(req) || /^0x/i.test(res)) return 'request and response sha256 are required';
    const tail = `${req.toLowerCase()}:${res.toLowerCase()}`;
    if (att.kind === 'provider_tee') {
      return att.model && att.text === `${att.model}:${tail}` ? null : 'signed text is not "<model>:<request sha256>:<response sha256>"';
    }
    if (att.kind === 'gateway') return att.text === tail ? null : 'signed text is not "<request sha256>:<response sha256>"';
    return `unknown signature kind: ${att.kind}`;
  });

  add('report_names_signer', () => {
    if (!rep) return 'no TEE report for this signer';
    if (!sameSigner(rep, att)) return 'the TEE report names a different signing address or algorithm';
    if (att.kind === 'provider_tee' && rep.model_name !== att.model) return 'the TEE report is for a different model';
    return null;
  });

  let quote = null;
  add('quote_parses', () => {
    if (!rep) return 'no TEE report';
    quote = parseTdxQuote(rep.intel_quote);
    return quote.tdAttributes[0] & 1 ? 'the TEE runs in debug mode' : null;
  });
  add('quote_binds_signer', () => {
    if (!quote) return 'no quote';
    const identity = unhex(rep.signing_address);
    if (identity.length !== { ecdsa: 20, ed25519: 32 }[rep.signing_algo]) return 'unsupported signing identity';
    if (!isHex(rep.request_nonce, 32)) return 'report has no nonce';
    const bound = rep.tls_cert_fingerprint
      ? sha256(identity, unhex(rep.tls_cert_fingerprint))
      : Buffer.concat([identity, Buffer.alloc(32 - identity.length)]);
    return quote.reportData.equals(Buffer.concat([bound, unhex(rep.request_nonce)]))
      ? null : 'the quote\'s report data does not carry this signing address and nonce';
  });
  add('quote_signature_chain', () => (quote
    ? verifyQuoteChain(quote, rep.fetched_at ? new Date(rep.fetched_at) : new Date(att.fetched_at || Date.now()))
    : 'no quote'));
  add('config_measured', () => {
    if (!quote) return 'no quote';
    if (typeof rep.app_compose !== 'string') return 'report has no measured configuration';
    const expected = Buffer.concat([Buffer.from([1]), sha256(Buffer.from(rep.app_compose, 'utf8')), Buffer.alloc(15)]);
    return quote.mrConfigId.equals(expected) ? null : 'the quote does not measure the reported configuration';
  });
  add('event_log_replays', () => {
    if (!quote) return 'no quote';
    return replayRtmr3(rep.event_log).equals(quote.rtmr3) ? null : 'the event log does not replay to the quote\'s RTMR3';
  });

  for (const [name, detail] of SKIPPED) checks.push({ name, skipped: true, detail });
  const failed = checks.filter((c) => !c.skipped && !c.ok);
  const result = { ok: failed.length === 0, checks };
  if (failed.length) result.why = `${failed[0].name}: ${failed[0].detail}`;
  return result;
}
