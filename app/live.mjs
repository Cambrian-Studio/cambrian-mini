// live.mjs — what only LIVE mode can do: spend (NEAR AI calls) and sign (council passkeys).
//   POST api/ideas                  an idea → a brief (one or two model calls), rate-limited, inside the caps.
//                                   When the app is exposed, only a council member may propose, by passkey.
//   POST api/ideas/options          the challenge a member's passkey signs to propose an idea
//   POST api/approve/options|approve    a council member signs the ticket hash; at 2 of 3 the ticket goes to the line
//   POST api/enrol/options|enrol        a one-time invite enrols one passkey
//   POST api/lessons/options|accept     a council member accepts a drafted lesson
//   GET  api/events                 server-sent events: runs, tickets, notifications
// A guest can read everything and propose; nothing is built without the council's signatures, and the line
// checks those signatures again itself (line/run.mjs) — this file is the door, not the lock.
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from './http.mjs';
import { council, listTickets, readTicketEntry, writeTicketEntry, writeJson, listRuns, readRun, attestationSummary } from './store.mjs';
import { enrol, findInvite } from '../approvals/council.mjs';
import { approvalChallenge, approvalSubject, ideaChallenge, ideaHash, lessonChallenge, talkChallenge, tasteNote, verifyMemberSignature, verifyRelease,
  ticketHash }
  from '../approvals/release.mjs';
import { hashOf } from '../receipts/canonical.mjs';
import { draftBrief, BRIEF_FALLBACKS, BRIEF_MODEL, MAX_IDEA } from '../tickets/brief.mjs';
import { parseTicket } from '../tickets/ticket.mjs';
import { classifyIntent, recordContext, replyLine } from '../tickets/intent.mjs';
import { briefChanges, conversationHash, isReady, sentenceGate, thinkMessages, transcript, MAX_MEMBER_TURNS, MAX_TURN, THINK_MAX_TOKENS,
  TRANSCRIPT_MAX } from '../tickets/think.mjs';
import { readAttachments, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from '../tickets/attachments.mjs';
import { parseLessons, lessonsBlock, lintBrief } from '../lessons/lessons.mjs';
import { acceptLesson, recordFired } from '../lessons/store.mjs';
import { draftLesson } from '../lessons/draft.mjs';
import * as nearai from '../near/nearai.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const utcDay = () => new Date().toISOString().slice(0, 10);
const MAX_BODY = 64 * 1024;
// a message may carry up to three images as base64, so that one path reads a larger body
const MAX_IDEA_BODY = Math.ceil(MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES * 4 / 3) + MAX_BODY;
const HOUSE_LINE = 'The house kit applies to every build: the collective\'s own design tokens and rules are in the workspace. '
  + 'Do not restate them in the task and do not add a check that contradicts them.';
const usdCap = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** The most ONE build may cost: $2, or CAMBRIAN_BUILD_CAP_USD. A ticket that asks for more is never released. */
export const buildCapUsd = (env = process.env) => usdCap(env.CAMBRIAN_BUILD_CAP_USD, 2);
/** The most this app may cause in model spend in total, builds and drafts, over all days: $15, or CAMBRIAN_TOTAL_CAP_USD. */
export const totalCapUsd = (env = process.env) => usdCap(env.CAMBRIAN_TOTAL_CAP_USD, 15);

async function readBody(req, max = MAX_BODY) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > max) throw new Error('request body too large'); chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new Error('request body must be JSON'); }
}

/** A small sliding-window limiter: at most `max` hits per `windowMs` for one key. */
export function makeLimiter({ max, windowMs, now = () => Date.now() }) {
  const hits = new Map();
  return (key) => {
    const t = now(); const list = (hits.get(key) ?? []).filter((x) => t - x < windowMs);
    if (list.length >= max) { hits.set(key, list); return { ok: false, retry_s: Math.ceil((windowMs - (t - list[0])) / 1000) }; }
    list.push(t); hits.set(key, list); return { ok: true };
  };
}

/** `near` is the model client (near/nearai.mjs); a test passes a stand-in so no call leaves the machine. */
export async function makeLive(cfg, { near = nearai } = {}) {
  const BUILD_CAP_USD = usdCap(cfg.buildCapUsd, buildCapUsd());
  const TOTAL_CAP_USD = usdCap(cfg.totalCapUsd, totalCapUsd());
  const clients = new Set();
  const broadcast = (event) => { const line = `data: ${JSON.stringify(event)}\n\n`; for (const res of clients) res.write(line); };
  const perGuest = makeLimiter({ max: 3, windowMs: 10 * 60 * 1000 });      // one visitor: 3 ideas per 10 minutes
  const everyone = makeLimiter({ max: 30, windowMs: 24 * 3600 * 1000 });   // all visitors: 30 ideas a day
  const signing = makeLimiter({ max: 20, windowMs: 10 * 60 * 1000 });        // enrol/approve/accept attempts, per visitor
  const spendFile = join(cfg.state, 'brief-spend.json');                   // what briefs and lesson drafts cost today
  const totalFile = join(cfg.state, 'brief-spend-total.json');             // what they have cost in all, over every day
  const usedIdeaSignatures = new Set();                                    // a proposer's signature opens one brief, once
  const draftsFile = join(cfg.data, 'lesson-drafts.json');
  const lessonsNow = () => parseLessons(readFileSync(cfg.files.lessons, 'utf8')).lessons;
  let pricing = null;
  const getPricing = async () => (pricing ??= await near.fetchPricing({ keyFile: cfg.nearai.keyFile, base: cfg.nearai.base }));
  // briefs and lesson drafts are written by the TEE-hosted open model, whatever model builds
  const model = () => cfg.nearai.briefModel ?? BRIEF_MODEL;

  // ---- money: briefs + runs today against the daily cap -------------------------------------------------
  const sideSpend = () => { const s = readJson(spendFile, {}); return s.day === utcDay() ? s : { day: utcDay(), usd: 0, calls: 0 }; };
  // the running total starts from whatever the per-day file holds the first time it is needed
  const sideTotal = () => {
    const t = readJson(totalFile, null); if (t && Number.isFinite(t.usd)) return t;
    const d = readJson(spendFile, {}); return { usd: Number(d.usd) || 0, calls: Number(d.calls) || 0, since: d.day ?? utcDay() };
  };
  const addSideSpend = (usd) => {
    const t = sideTotal(); const s = sideSpend(); const add = usd ?? 0;
    s.usd = Number((s.usd + add).toFixed(6)); s.calls += 1; writeJson(spendFile, s);
    writeJson(totalFile, { ...t, usd: Number((t.usd + add).toFixed(6)), calls: t.calls + 1 });
  };
  const attemptUsd = (a) => (a.calls?.length ? a.calls.reduce((x, c) => x + (c.usd ?? 0), 0) : (a.bridge?.computed_usd ?? 0));
  // every model dollar this app has caused: all runs of this line, plus every brief and lesson draft ever
  const totalSpent = () => Number((sideTotal().usd + listRuns(cfg).filter((r) => (r.origin ?? 'mini') === 'mini')
    .reduce((s, r) => s + (r.attempts ?? []).reduce((x, a) => x + attemptUsd(a), 0), 0)).toFixed(6));
  const totalWhy = (extra = '') => `The total cap of $${TOTAL_CAP_USD} for this app would be passed: $${totalSpent()} is spent${extra}. `
    + 'Nothing more is sent to a model until the operator raises it.';
  const runSpendToday = () => listRuns(cfg).filter((r) => (r.origin ?? 'mini') === 'mini' && String(r.started).slice(0, 10) === utcDay())
    .reduce((s, r) => s + (r.attempts ?? []).reduce((x, a) => x + (a.bridge?.computed_usd ?? 0), 0), 0);
  const spentToday = () => Number((sideSpend().usd + runSpendToday()).toFixed(6));
  // NEAR AI answers 429 or 503 when a model is overloaded. The same model is asked once more after a pause, then each fallback
  // in turn. Whichever model answered is the one recorded: a brief never names a model that did not write it.
  // A model that does not answer within the time limit is given up on (the request is aborted) and treated the same way.
  // A model that just failed this way is skipped for five minutes, so a conversation does not wait on it at every turn.
  // 429 and every 5xx count: tonight the same hosted model answered 429, then hung, then 502.
  const overloaded = (r) => r?.status === 429 || (r?.status >= 500 && r?.status <= 599) || r?.timed_out === true;
  const pause = () => new Promise((done) => setTimeout(done, cfg.retryMs ?? 1500));
  const MODEL_WAIT_MS = cfg.modelWaitMs ?? 60000; const sick = new Map();
  const timed = async (call, m) => {
    const ctl = new AbortController(); let timer;
    const late = new Promise((done) => { timer = setTimeout(() => { ctl.abort(); done({ ok: false, status: 0, usd: null, timed_out: true,
      error: `no answer in ${Math.round(MODEL_WAIT_MS / 1000)} s` }); }, MODEL_WAIT_MS); });
    try { return await Promise.race([call(m, ctl.signal), late]); } finally { clearTimeout(timer); }
  };
  const overModels = async (call) => {
    const all = [model(), ...(cfg.nearai.briefFallbacks ?? BRIEF_FALLBACKS)];
    const well = all.filter((m) => !(sick.get(m) > Date.now()));
    const order = well.length ? well : all;
    let r = null; let asked = null;
    for (const [i, m] of order.entries()) {
      asked = m; r = await timed(call, m);
      // a plain "overloaded" answer gets one more try on the same model after a pause; a model that hung does not
      if (overloaded(r) && !r.timed_out) { await pause(); r = await timed(call, m); }
      if (!overloaded(r)) break;
      sick.set(m, Date.now() + 5 * 60 * 1000);
      if (i < order.length - 1) await pause();
    }
    return { r, asked };
  };
  const chat = async ({ messages, max_tokens }) => {
    // briefs and lesson drafts are paid from the same day's cap as builds: once it is spent, no model call
    if (spentToday() >= cfg.dailyCapUsd) return { ok: false, usd: 0, why: 'the daily cap is spent' };
    if (totalSpent() >= TOTAL_CAP_USD) return { ok: false, usd: 0, why: 'the total cap is spent' };
    const pricing = await getPricing();
    const { r, asked } = await overModels((asked, signal) => near.chat({ model: asked, messages, max_tokens, keyFile: cfg.nearai.keyFile,
      base: cfg.nearai.base, pricing, signal }));
    addSideSpend(r.usd); return { ...r, requested_model: asked, why: r.error };
  };

  // ---- the brief's signature: made inside the model's TEE over the exact request and response bytes ---------
  /** → { attestation (report detached), check: {ok, checks} | null, report, note? }. Never throws: a brief is not held up by it. */
  async function attest(call, report) {
    const none = (note) => ({ attestation: null, check: null, report: null, note });
    if (!call) return none('the model call reported no completion id, so there is no signature to fetch');
    const hashes = { requestSha256: call.request_sha256, responseSha256: call.response_sha256 };
    let att = null;
    try {
      att = await near.fetchAttestation({ chatId: call.completion_id, model: call.model, ...hashes, report: report ?? undefined,
        signingAlgo: 'ecdsa', keyFile: cfg.nearai.keyFile, base: cfg.nearai.base });
    } catch (e) { return none(`the signature could not be fetched (${String(e?.message ?? e).slice(0, 160)})`); }
    if (!att) return none('NEAR AI returned no signature for this call');
    const v = near.verifyAttestation(att, hashes); const d = near.detachReport(att);
    return { attestation: d.att, check: { ok: v.ok === true, checks: v.checks ?? [] }, report: d.report,
      note: v.ok ? null : `not verified: ${v.why}` };
  }

  // ---- who proposes, when the app is reachable from outside: a council member, by passkey over the idea ------
  function proposerOf(body, files = []) {
    if (typeof body.idea !== 'string' || !body.idea.trim()) return { ok: false, why: 'no idea was sent' };
    if (body.idea.length > MAX_IDEA) return { ok: false, why: `keep the idea under ${MAX_IDEA} characters` };
    const sha = ideaHash(body.idea, files.map((f) => f.sha256));
    const approval = { member: String(body.member ?? ''), credential_id: body.credential_id, idea_sha256: sha,
      authenticator_data: body.authenticator_data, client_data_json: body.client_data_json, signature: body.signature,
      at: new Date().toISOString() };
    const v = verifyMemberSignature({ purpose: 'idea', subjectHash: sha, approval, council: council(cfg) });
    if (!v.ok) return { ok: false, why: v.why };
    if (usedIdeaSignatures.has(approval.signature)) return { ok: false, why: 'this signature was already used; sign the idea again' };
    usedIdeaSignatures.add(approval.signature);
    return { ok: true, proposer: { member: approval.member, approval } };
  }

  // ---- the line -------------------------------------------------------------------------------------------
  async function release(entry) {
    const { startRun } = await import('../line/dispatch.mjs');
    const { loadConfig } = await import('../line/config.mjs');
    const lineCfg = loadConfig({ home: cfg.state, records: cfg.files.runs, model: cfg.nearai.model ?? undefined,
      nearai_key_file: cfg.nearai.keyFile, nearai_base: cfg.nearai.base, vercel_token_file: cfg.vercel.tokenFile, vercel_team: cfg.vercel.team,
      // the line's ceiling is what briefs and lesson drafts have left of the day's cap
      daily_cap_usd: cfg.dailyCapUsd,
      daily_ceiling_usd: Math.max(0.01, Number((cfg.dailyCapUsd - sideSpend().usd).toFixed(6))),
      ...(cfg.lineOverrides ?? {}),   // tests only: run the line offline
      ...(cfg.publish.remote ? { publish_remote: cfg.publish.remote, publish_token_file: cfg.publish.tokenFile } : {}) });
    const hooks = {
      onUpdate: (rec) => broadcast({ type: 'run', run: rec }),
      onRed: async (rec, failureLog) => {
        const asked = [entry.ticket.goal, entry.ticket.task].filter(Boolean).join(' ');
        const draft = await draftLesson({ run: { ...rec, asked }, failureLog, chat, model: model() });
        if (!draft) return null;
        const doc = readJson(draftsFile, { v: 1, drafts: [] });
        doc.drafts = [...doc.drafts.filter((d) => d.id !== draft.id), { ...draft, sha256: hashOf(draftBody(draft)) }];
        writeJson(draftsFile, doc); broadcast({ type: 'lesson-draft', draft }); return draft;
      },
    };
    startRun(lineCfg, { ticket: entry.ticket, approvals: entry.approvals, council: council(cfg), lessonsFired: entry.lint?.applied ?? [], hooks })
      .then((rec) => { broadcast({ type: 'run', run: rec });
        // a product begins with its first GREEN build: record it so the Products screen can show it
        if (/^green/.test(String(rec?.state))) {
          const doc = readJson(cfg.files.products, { v: 1, products: [] });
          const known = doc.products.find((p) => p.id === entry.ticket.product);
          // a product that was on record before it was built gets its first build written on it
          if (known && !known.first_run && !(known.runs ?? []).length) { known.first_run = entry.ticket.id; known.status = 'built here'; writeJson(cfg.files.products, doc); }
          if (!known) {
            doc.products.push({ id: entry.ticket.product, name: entry.ticket.product, tagline: entry.ticket.goal ?? entry.ticket.title, status: 'preview',
              live_url: null, built_on: 'this line', first_run: entry.ticket.id });
            writeJson(cfg.files.products, doc);
          }
        } for (const n of rec?.notifications ?? []) broadcast({ type: 'notification', notification: { ...n, run: entry.ticket.id } }); })
      .catch((e) => broadcast({ type: 'error', why: `the run for ${entry.ticket.id} did not start: ${String(e.message).slice(0, 200)}` }));
  }
  const draftBody = (d) => ({ id: d.id, rule: d.rule, failure: d.failure ?? '', applies_to: d.applies_to, check: d.check ?? null, fix: d.fix ?? null, from_run: d.from_run ?? null });


  // ---- Talk as a conversation: who is speaking, and the conversation kept in this machine's private state until it is sent --
  const sessions = new Map();      // session token → { member, at }: opened once with a passkey, good for two hours
  const pendingOpen = new Map();   // member → the hash their passkey is about to sign
  const SESSION_MS = 2 * 3600 * 1000;
  const talkDir = join(cfg.state, 'talk');
  const CONV_ID = /^talk-[0-9]{14}-[0-9a-f]{6}$/;
  const loadConv = (id) => (CONV_ID.test(String(id ?? '')) ? readJson(join(talkDir, id + '.json'), null) : null);
  const saveConv = (c) => writeJson(join(talkDir, c.id + '.json'), c);
  const talkTurns = makeLimiter({ max: 40, windowMs: 10 * 60 * 1000 });   // one member: 40 messages per 10 minutes
  const cleanText = (v) => String(v ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  const REFUSED_SPEAKER = [403, { error: 'passkey required', why: 'Only an enrolled council member can talk to Cambrian here. Open the conversation with your passkey.' }];
  /** Who is speaking: the member of a live session; on a machine that is not reachable from outside, a local guest. */
  function speaker(body) {
    const s = sessions.get(String(body.session ?? ''));
    if (s && Date.now() - s.at < SESSION_MS) return { ok: true, member: s.member };
    return cfg.exposed ? { ok: false } : { ok: true, member: null };
  }
  function convFor(body, member) {
    if (body.conversation_id) {
      const c = loadConv(body.conversation_id);
      if (!c) return { why: 'no such conversation' };
      if (c.member !== member) return { why: 'this conversation belongs to another member' };
      if (c.sent) return { why: 'this conversation already went to the council; start a new one' };
      return { c };
    }
    const at = new Date().toISOString();
    return { c: { id: 'talk-' + at.replace(/[^0-9]/g, '').slice(0, 14) + '-' + randomBytes(3).toString('hex'), member, started: at, messages: [], drafts: [],
      attachments: [], usd: 0 } };
  }
  const capsWhy = () => (spentToday() >= cfg.dailyCapUsd
    ? [402, { error: 'daily cap', why: 'Today\'s cap of $' + cfg.dailyCapUsd + ' is spent. Nothing more is sent to a model today.' }]
    : (totalSpent() >= TOTAL_CAP_USD ? [402, { error: 'total cap', why: totalWhy() }] : null));
  const recordNow = () => ({ products: readJson(cfg.files.products, { products: [] }).products ?? [],
    runs: listRuns(cfg).map((x) => ({ id: x.ticket?.id, title: x.ticket?.title, product: x.ticket?.product, state: x.state, started: x.started,
      finished: x.finished, ticket: x.ticket })) });
  /** One thinking turn on the brief model (the cheap one), streamed when the client can stream; paid from the same caps as everything else. */
  const think = async ({ messages, onText }) => {
    if (spentToday() >= cfg.dailyCapUsd) return { ok: false, usd: 0, why: 'the daily cap is spent' };
    if (totalSpent() >= TOTAL_CAP_USD) return { ok: false, usd: 0, why: 'the total cap is spent' };
    const pricing = await getPricing();
    const { r } = await overModels(async (asked, signal) => {
      const args = { model: asked, messages, max_tokens: THINK_MAX_TOKENS, keyFile: cfg.nearai.keyFile, base: cfg.nearai.base, pricing, signal };
      if (typeof near.chatStream === 'function') return near.chatStream({ ...args, onText });
      const one = await near.chat(args); if (one.ok && one.content) onText(one.content); return one;
    });
    addSideSpend(r.usd); return { ...r, why: r.error };
  };

  // ---- handlers -------------------------------------------------------------------------------------------
  const handlers = {
    // ---- Talk is a conversation first: think, then draft from it, then send that exact ticket to the council ----------
    '/api/talk/open/options': async (body) => {
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m?.credentials.length) return [403, { error: 'not an enrolled council member', why: 'Only a council member with an enrolled passkey can talk to Cambrian here.' }];
      const sha = hashOf({ talk: m.id, nonce: randomBytes(16).toString('hex') }); pendingOpen.set(m.id, sha);
      return [200, { talk_sha256: sha, challenge: talkChallenge(sha), rpId: c.rp.id,
        allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
    },
    '/api/talk/open': async (body) => {
      const member = String(body.member ?? ''); const sha = pendingOpen.get(member);
      if (!sha) return [403, { error: 'signature refused', why: 'Ask for a new challenge first.' }];
      const approval = { member, credential_id: body.credential_id, authenticator_data: body.authenticator_data,
        client_data_json: body.client_data_json, signature: body.signature };
      const v = verifyMemberSignature({ purpose: 'talk', subjectHash: sha, approval, council: council(cfg) });
      if (!v.ok) return [403, { error: 'signature refused', why: v.why }];
      pendingOpen.delete(member);
      const session = randomBytes(24).toString('base64url'); sessions.set(session, { member, at: Date.now() });
      return [200, { session, member, minutes: SESSION_MS / 60000 }];
    },
    '/api/talk/turn': async (body, req, res) => {
      const who = speaker(body); if (!who.ok) return REFUSED_SPEAKER;
      const text = cleanText(body.text);
      if (text.length < 2) return [400, { error: 'empty', why: 'Write something first.' }];
      if (text.length > MAX_TURN) return [400, { error: 'too long', why: 'Keep one message under ' + MAX_TURN + ' characters.' }];
      const lim = talkTurns(who.member ?? req.socket?.remoteAddress ?? 'guest');
      if (!lim.ok) return [429, { error: 'slow down', why: 'Too many messages. Try again in ' + lim.retry_s + ' s.' }];
      const f = convFor(body, who.member); if (f.why) return [409, { error: 'conversation', why: f.why }];
      const c = f.c;
      if (c.messages.filter((m) => m.role === 'member').length >= MAX_MEMBER_TURNS) {
        return [409, { error: 'conversation', why: 'This conversation is long enough. Draft the brief, or start a new one.' }];
      }
      // "ready", or any instruction once a draft exists, is not a thinking turn: the page asks for a draft with it
      if (c.drafts.length || (isReady(text) && c.messages.length)) return [200, { draft: true, conversation_id: c.id }];
      if (isReady(text)) return [400, { error: 'nothing to draft', why: 'Tell me the idea first.' }];
      const capped = capsWhy(); if (capped) return capped;
      const at = new Date().toISOString();
      c.messages.push({ role: 'member', text, at });
      const ctx = recordNow();
      const messages = thinkMessages(c.messages, { record: recordContext(ctx.products, ctx.runs), lessons: lessonsNow(), house: HOUSE_LINE });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
      const send = (o) => res.write('data: ' + JSON.stringify(o) + '\n\n');
      send({ conversation_id: c.id });
      const gate = sentenceGate();
      const r = await think({ messages, onText: (d) => { const t = gate.push(d); if (t) send({ t }); } });
      const rest = gate.end(); if (rest) send({ t: rest });
      if (!r.ok || !gate.text.trim()) { send({ error: 'Cambrian did not answer (' + String(r.why ?? 'no text').slice(0, 120) + ').' }); res.end(); return undefined; }
      c.messages.push({ role: 'cambrian', text: gate.text.trim(), at: new Date().toISOString() });
      c.usd = Number((c.usd + (r.usd ?? 0)).toFixed(6)); saveConv(c);
      send({ done: true, usd: r.usd ?? 0, total_usd: c.usd, model: r.model ?? model() }); res.end();
      return undefined;
    },
    '/api/talk/draft': async (body, req) => {
      const who = speaker(body); if (!who.ok) return REFUSED_SPEAKER;
      const img = readAttachments(body.attachments);
      if (!img.ok) return [400, { error: 'attachment refused', why: img.why }];
      if (img.files.length && !who.member) return [403, { error: 'members only', why: 'Only an enrolled member can attach images.' }];
      const lim = talkTurns(who.member ?? req.socket?.remoteAddress ?? 'guest');
      if (!lim.ok) return [429, { error: 'slow down', why: 'Too many messages. Try again in ' + lim.retry_s + ' s.' }];
      const f = convFor(body, who.member); if (f.why) return [409, { error: 'conversation', why: f.why }];
      const c = f.c; const at = new Date().toISOString();
      const text = cleanText(body.text);
      if (text.length > MAX_TURN) return [400, { error: 'too long', why: 'Keep one message under ' + MAX_TURN + ' characters.' }];
      if (text) c.messages.push({ role: 'member', text, at });
      const said = c.messages.filter((m) => m.role === 'member' && !isReady(m.text)).map((m) => m.text);
      if (said.join(' ').length < 8) return [400, { error: 'nothing to draft', why: 'Tell me the idea first.' }];
      const capped = capsWhy(); if (capped) return capped;
      if (!model()) return [503, { error: 'no model', why: 'No model is configured for briefs.' }];
      const ctx = recordNow(); const add = (usd) => { c.usd = Number((c.usd + (usd ?? 0)).toFixed(6)); };
      // what the conversation is about: a new product, a revision of one on record (then it starts from that product's last build), or neither
      const intent = await classifyIntent(said.join('\n').slice(-4000), { chat, products: ctx.products, runs: ctx.runs });
      add(intent.usd);
      if (!intent.ok) return [502, { error: 'no answer', why: intent.why }];
      if (intent.intent === 'question' || intent.intent === 'ask') {
        const reply = intent.answer ?? intent.ask;
        c.messages.push({ role: 'cambrian', text: reply, at }); saveConv(c);
        return [200, { conversation_id: c.id, reply, usd: intent.usd }];
      }
      if (intent.intent === 'revision' && !who.member) {
        return [403, { error: 'members only', why: 'Only an enrolled member can revise a product, with a passkey.' }];
      }
      if (img.files.length) {
        mkdirSync(talkDir, { recursive: true });
        c.attachments = img.files.map((x) => { const name = c.id + '.attach-' + x.n + (x.type === 'png' ? '.png' : '.jpg');
          writeFileSync(join(talkDir, name), x.buf, { mode: 0o600 }); return { file: name, type: x.type, bytes: x.bytes, sha256: x.sha256 }; });
      }
      const revision = intent.intent === 'revision' ? { kind: intent.kind, product: intent.product, parent: intent.parent, by: who.member,
        attachments: (c.attachments ?? []).map((x) => ({ type: x.type, bytes: x.bytes, sha256: x.sha256 })) } : null;
      // the conversation as it stands now, by hash: it goes into the ticket, so the council's signatures cover it
      const conversation = { sha256: conversationHash(c.messages), turns: c.messages.length };
      const messagesAt = c.messages.length;
      let report = null;
      try { report = await near.fetchReport({ model: model(), signingAlgo: 'ecdsa', nonce: randomBytes(32).toString('hex'), base: cfg.nearai.base }); } catch { report = null; }
      const tickets = listTickets(cfg);
      const r = await draftBrief(transcript(c.messages), { chat, lessons: lessonsNow(), lintBrief, lessonsBlock, products: ctx.products, revision, house: HOUSE_LINE, forceProduct: intent.intent === 'new' ? intent.product?.id ?? null : null,
        conversation, maxIdea: TRANSCRIPT_MAX + 200, existing: tickets.map((t) => ({ id: t.ticket.id, title: t.ticket.title, task: t.ticket.task })),
        idSuffix: randomBytes(3).toString('hex'), capUsd: Math.min(cfg.dailyCapUsd, BUILD_CAP_USD) });
      add(r.usd);
      if (!r.ok) {
        // a draft the lessons refuse is shown with the rules it broke, and nothing can go to the council until a draft passes
        c.blocked = { why: r.why, lint: r.lint ?? null, at };
        c.messages.push({ role: 'cambrian', text: r.why, at }); saveConv(c);
        return [200, { conversation_id: c.id, blocked: true, why: r.why, lint: r.lint ?? null, usd: (intent.usd ?? 0) + (r.usd ?? 0) }];
      }
      const sig = await attest(r.call, r.call?.model === model() ? report : null);
      const meta = { attestation: sig.attestation, attestation_check: sig.check, ...(sig.note ? { attestation_note: sig.note } : {}) };
      const prev = c.drafts.at(-1) ?? null; const v = c.drafts.length + 1;
      const changes = briefChanges(prev?.brief ?? null, r.brief);
      const reply = v === 1 ? replyLine({ intent: intent.intent, kind: intent.kind, productName: intent.product?.name ?? intent.product?.id, title: r.brief.title })
        : 'Draft ' + v + '. ' + changes.join(' ');
      c.drafts.push({ v, at, brief: r.brief, lint: r.lint, intent: intent.intent, call: r.call, meta, report: sig.report, model: r.model ?? model(),
        attempts: r.attempts, messages_at: messagesAt });
      delete c.blocked;
      c.messages.push({ role: 'cambrian', text: reply, at }); saveConv(c);
      return [200, { conversation_id: c.id, version: v, reply, brief: r.brief, ticket_sha256: ticketHash(r.brief), lint: r.lint, changes,
        usd: (intent.usd ?? 0) + (r.usd ?? 0), total_usd: c.usd, model: r.model ?? model(), attestation: attestationSummary(meta) }];
    },
    '/api/talk/send/options': async (body) => {
      const c = loadConv(body.conversation_id); const d = c?.drafts.at(-1);
      if (!d) return [404, { error: 'no draft', why: 'There is no draft to send.' }];
      const cl = council(cfg); const m = cl.members.find((x) => x.id === body.member);
      if (!m?.credentials.length) return [403, { error: 'not an enrolled council member' }];
      const sha = d.brief.conversation.sha256;
      return [200, { idea_sha256: sha, challenge: ideaChallenge(sha), rpId: cl.rp.id,
        allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
    },
    '/api/talk/send': async (body) => {
      const c = loadConv(body.conversation_id);
      if (!c) return [404, { error: 'no such conversation' }];
      if (c.sent) return [409, { error: 'already sent', why: 'This conversation already went to the council.' }];
      if (c.blocked) return [422, { error: 'blocked', why: 'The last draft broke a rule (' + c.blocked.why + '). Change it before it goes to the council.' }];
      const d = c.drafts.at(-1); if (!d) return [404, { error: 'no draft', why: 'There is no draft to send.' }];
      const sha = d.brief.conversation.sha256; let proposer = null;
      if (cfg.exposed || c.member || body.signature) {
        // the member's passkey signs the hash of the conversation: that signature sends the brief, and it is not an approval
        const approval = { member: String(body.member ?? ''), credential_id: body.credential_id, idea_sha256: sha,
          authenticator_data: body.authenticator_data, client_data_json: body.client_data_json, signature: body.signature, at: new Date().toISOString() };
        if (c.member && approval.member !== c.member) return [403, { error: 'signature refused', why: 'This conversation belongs to another member.' }];
        const v = verifyMemberSignature({ purpose: 'idea', subjectHash: sha, approval, council: council(cfg) });
        if (!v.ok) return [403, { error: 'signature refused', why: v.why }];
        if (usedIdeaSignatures.has(approval.signature)) return [403, { error: 'signature refused', why: 'this signature was already used' }];
        usedIdeaSignatures.add(approval.signature); proposer = { member: approval.member, approval };
      }
      const at = new Date().toISOString();
      // A lesson may have been accepted since this draft was made. The draft is checked again against every lesson there is now:
      // one that refuses it stops it here; one that adds to it changes the brief, and the response says so before anyone signs.
      const now = recordNow().products; const known = now.some((x) => x.id === d.brief.product) ? now : [...now, { id: d.brief.product, name: d.brief.product, proposed: true }];
      const again = lintBrief(d.brief, { lessons: lessonsNow(), products: known,
        existing: listTickets(cfg).map((t) => ({ id: t.ticket.id, title: t.ticket.title, task: t.ticket.task })) });
      if (again.refused.length) {
        const why = again.refused.map((x) => x.why).join(' | ');
        return [422, { error: 'blocked', why: `A lesson accepted since this draft refuses it (${why}). Change the brief, then send it.`, lint: { applied: [], refused: again.refused, notes: [] } }];
      }
      const b = parseTicket(again.brief); const relinted = again.applied;
      const seen = new Set(d.lint.applied.map((x) => x.lesson));
      d.lint = { ...d.lint, applied: [...d.lint.applied, ...relinted.filter((x) => !seen.has(x.lesson))] };
      const shaped = c.messages.slice(0, d.messages_at).map((m) => ({ role: m.role, text: m.text }));
      mkdirSync(cfg.files.tickets, { recursive: true });
      const kept = (b.revision?.attachments?.length ? c.attachments ?? [] : []).map((x, i) => { const name = b.id + '.attach-' + (i + 1) + (x.type === 'png' ? '.png' : '.jpg');
        writeFileSync(join(cfg.files.tickets, name), readFileSync(join(talkDir, x.file)), { mode: 0o600 }); return { ...x, file: name }; });
      const entry = { ticket: b, created: at, idea: String(shaped.find((m) => m.role === 'member')?.text ?? '').slice(0, MAX_IDEA), intent: d.intent,
        conversation: { sha256: sha, turns: shaped.length, messages: shaped, draft: d.v }, lint: d.lint, ...(kept.length ? { attachments: kept } : {}),
        brief: { usd: c.usd, model: d.model, attempts: d.attempts, ...d.meta }, proposed_by: proposer, approvals: [], run_started: null };
      writeTicketEntry(cfg, entry);
      const beside = (name) => join(cfg.files.tickets, b.id + '.' + name + '.json');
      if (typeof d.call?.response_body === 'string') writeFileSync(beside('brief-response'), d.call.response_body);
      if (typeof d.call?.request_body === 'string') writeFileSync(beside('brief-request'), d.call.request_body);
      if (d.report) writeJson(beside('brief-report'), d.report);
      for (const x of d.lint.applied) { try { recordFired(cfg.files.lessons, x.lesson, { brief: b.id, at, what: x.what }); } catch { /* not in the file */ } }
      const talk = readJson(cfg.files.talk, { v: 1, conversations: [] });
      talk.conversations = [{ id: c.id, at, usd: c.usd, model: d.model, proposed_by: proposer?.member ?? null, attestation: attestationSummary(d.meta),
        messages: [...shaped, { role: 'cambrian', text: 'Draft ' + d.v + ', sent to the council.', brief: b, lint: d.lint }] }, ...talk.conversations].slice(0, 50);
      writeJson(cfg.files.talk, talk);
      c.sent = b.id; saveConv(c); broadcast({ type: 'ticket', id: b.id });
      return [200, { ok: true, ticket_id: b.id, ticket_sha256: ticketHash(b), conversation_sha256: sha, proposed_by: proposer?.member ?? null,
        relinted, lint: d.lint }];
    },

    '/api/ideas': async (body, req) => {
      let proposer = null;
      const img = readAttachments(body.attachments);
      if (!img.ok) return [400, { error: 'attachment refused', why: img.why }];
      // a passkey signature is checked whenever one is sent; reachable from outside, it is required
      if (cfg.exposed || body.signature) {
        const p = proposerOf(body, img.files);
        if (!p.ok) {
          return [403, { error: 'passkey required', why: 'While this app is reachable from outside its build machine, only an '
            + `enrolled council member can propose an idea, by signing it with a passkey (${p.why}).` }];
        }
        proposer = p.proposer;
      }
      const who = proposer ? `member:${proposer.member}` : req.socket.remoteAddress ?? 'unknown';
      const a = perGuest(who); if (!a.ok) return [429, { error: 'slow down', why: `Three ideas per ten minutes. Try again in ${a.retry_s} s.` }];
      const b = everyone('all'); if (!b.ok) return [429, { error: 'slow down', why: 'Today\'s idea limit for all visitors is reached.' }];
      if (spentToday() >= cfg.dailyCapUsd) return [402, { error: 'daily cap', why: `Today's cap of $${cfg.dailyCapUsd} is spent. Nothing more is sent to a model today.` }];
      if (totalSpent() >= TOTAL_CAP_USD) return [402, { error: 'total cap', why: totalWhy() }];
      if (!model()) return [503, { error: 'no model', why: 'No model is configured for briefs.' }];
      if (img.files.length && !proposer) return [403, { error: 'members only', why: 'Only an enrolled member can attach images, by signing the message with a passkey.' }];
      const lessons = lessonsNow(); const tickets = listTickets(cfg);
      const products = readJson(cfg.files.products, { products: [] }).products ?? [];
      const at0 = new Date().toISOString();
      const keepTalk = (usd, reply) => {
        const talk = readJson(cfg.files.talk, { v: 1, conversations: [] });
        talk.conversations = [{ id: `talk-${at0.replace(/[^0-9]/g, '').slice(0, 14)}`, at: at0, usd: Number((usd ?? 0).toFixed(6)), model: model(),
          proposed_by: proposer?.member ?? null, messages: [{ role: 'member', text: String(body.idea).slice(0, MAX_IDEA) }, { role: 'cambrian', text: reply }] },
        ...talk.conversations].slice(0, 50); writeJson(cfg.files.talk, talk);
      };
      // ---- what is this message: a new product, a revision of one on record, or a question -----------------------
      const intent = await classifyIntent(body.idea, { chat, products, runs: listRuns(cfg).map((x) => ({ id: x.ticket?.id, title: x.ticket?.title,
        product: x.ticket?.product, state: x.state, started: x.started, finished: x.finished, ticket: x.ticket })) });
      if (!intent.ok) return [502, { error: 'no answer', why: intent.why, usd: intent.usd }];
      if (intent.intent === 'question' || intent.intent === 'ask') {
        const reply = intent.answer ?? intent.ask; keepTalk(intent.usd, reply);
        return [200, { intent: intent.intent, reply, usd: intent.usd, model: intent.model ?? model(), proposed_by: proposer?.member ?? null }];
      }
      if (intent.intent === 'revision' && !proposer) {
        return [403, { error: 'members only', why: 'Only an enrolled member can revise a product, by signing the message with a passkey.', usd: intent.usd }];
      }
      const revision = intent.intent === 'revision' ? { kind: intent.kind, product: intent.product, parent: intent.parent, by: proposer.member,
        attachments: img.files.map((f) => ({ type: f.type, bytes: f.bytes, sha256: f.sha256 })) } : null;
      // ONE report of the brief model's TEE, taken before the call, so the signature fetched after it is checked against it
      let report = null;
      try {
        report = await near.fetchReport({ model: model(), signingAlgo: 'ecdsa', nonce: randomBytes(32).toString('hex'),
          base: cfg.nearai.base });
      } catch { report = null; }
      const r = await draftBrief(body.idea, { chat, lessons, lintBrief, lessonsBlock, products, revision, house: HOUSE_LINE, forceProduct: intent.intent === 'new' ? intent.product?.id ?? null : null,
        existing: tickets.map((t) => ({ id: t.ticket.id, title: t.ticket.title, task: t.ticket.task })),
        idSuffix: randomBytes(3).toString('hex'), capUsd: Math.min(cfg.dailyCapUsd, BUILD_CAP_USD) });
      const at = new Date().toISOString();
      r.usd = (r.usd ?? 0) + (intent.usd ?? 0);   // the intent call and the draft are one message's cost
      const said = r.ok ? replyLine({ intent: intent.intent, kind: intent.kind, productName: intent.product?.name ?? intent.product?.id, title: r.brief.title }) : null;
      const sig = r.ok ? await attest(r.call, r.call?.model === model() ? report : null) : null;
      const meta = sig ? { attestation: sig.attestation, attestation_check: sig.check,
        ...(sig.note ? { attestation_note: sig.note } : {}) } : {};
      const talk = readJson(cfg.files.talk, { v: 1, conversations: [] });
      const convo = { id: `talk-${at.replace(/[^0-9]/g, '').slice(0, 14)}`, at, usd: Number((r.usd ?? 0).toFixed(6)),
        model: r.model ?? model(), proposed_by: proposer?.member ?? null, ...(sig ? { attestation: attestationSummary(meta) } : {}),
        messages: [{ role: 'member', text: String(body.idea).slice(0, MAX_IDEA) },
          r.ok ? { role: 'cambrian', text: said, brief: r.brief, lint: r.lint } : { role: 'cambrian', text: r.why, lint: r.lint ?? null }] };
      talk.conversations = [convo, ...talk.conversations].slice(0, 50); writeJson(cfg.files.talk, talk);
      if (!r.ok) return [422, { error: 'no brief', why: r.why, lint: r.lint ?? null, usd: r.usd ?? 0 }];
      // proposed_by keeps the verified passkey assertion over the idea, so it can be checked again; null for a local guest.
      // It is NOT an approval: it signs another challenge and is never counted toward the 2 of 3.
      // images: beside the ticket, named by position; never sent to a model, never served
      mkdirSync(cfg.files.tickets, { recursive: true });   // the first brief on a new machine: the folder may not exist yet
      const kept = img.files.map((f) => { const name = `${r.brief.id}.attach-${f.n}.${f.type === 'png' ? 'png' : 'jpg'}`;
        writeFileSync(join(cfg.files.tickets, name), f.buf, { mode: 0o600 }); return { file: name, type: f.type, bytes: f.bytes, sha256: f.sha256 }; });
      const entry = { ticket: r.brief, created: at, idea: convo.messages[0].text, lint: r.lint, intent: intent.intent,
        ...(kept.length ? { attachments: kept } : {}),
        brief: { usd: convo.usd, model: convo.model, attempts: r.attempts, ...meta }, proposed_by: proposer, approvals: [],
        run_started: null };
      writeTicketEntry(cfg, entry);
      // beside the ticket: the exact bytes the model's TEE signed (written as they came, never reformatted), and its report
      const beside = (name) => join(cfg.files.tickets, `${r.brief.id}.${name}.json`);
      if (typeof r.call?.response_body === 'string') writeFileSync(beside('brief-response'), r.call.response_body);
      if (typeof r.call?.request_body === 'string') writeFileSync(beside('brief-request'), r.call.request_body);
      if (sig.report) writeJson(beside('brief-report'), sig.report);
      for (const x of r.lint.applied) { try { recordFired(cfg.files.lessons, x.lesson, { brief: r.brief.id, at, what: x.what }); } catch { /* a lesson that is not in the file cannot be marked */ } }
      broadcast({ type: 'ticket', id: r.brief.id });
      return [200, { intent: intent.intent, reply: said, brief: r.brief, ticket_sha256: ticketHash(r.brief), lint: r.lint, usd: convo.usd, model: convo.model,
        drafted: r.brief.drafted ?? null, attestation: attestationSummary(meta), proposed_by: proposer?.member ?? null }];
    },
    '/api/ideas/options': async (body) => {
      if (typeof body.idea !== 'string' || !body.idea.trim()) return [400, { error: 'no idea', why: 'Write the idea first.' }];
      if (body.idea.length > MAX_IDEA) return [400, { error: 'too long', why: `Keep the idea under ${MAX_IDEA} characters.` }];
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m?.credentials.length) {
        return [403, { error: 'not an enrolled council member', why: 'Only a council member with an enrolled passkey can propose here.' }];
      }
      const shas = Array.isArray(body.attachment_sha256) ? body.attachment_sha256 : [];
      if (shas.length > MAX_ATTACHMENTS || shas.some((x) => !/^[0-9a-f]{64}$/.test(String(x)))) return [400, { error: 'attachment refused', why: `At most ${MAX_ATTACHMENTS} images, each named by its sha256.` }];
      const sha = ideaHash(body.idea, shas);
      return [200, { idea_sha256: sha, challenge: ideaChallenge(sha), rpId: c.rp.id,
        allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
    },

    '/api/approve/options': async (body) => {
      const entry = readTicketEntry(cfg, body.ticket_id); if (!entry) return [404, { error: 'no such ticket' }];
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m) return [403, { error: 'not a council member' }];
      if (!m.credentials.length) return [409, { error: 'not enrolled', why: `${m.name} has not enrolled a passkey yet (one-time invite link).` }];
      const sha = ticketHash(entry.ticket); const note = tasteNote(body.taste_note);
      return [200, { ticket_sha256: sha, taste_note: note, challenge: approvalChallenge(approvalSubject(sha, note)), rpId: c.rp.id, allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
    },
    '/api/approve': async (body) => {
      const entry = readTicketEntry(cfg, body.ticket_id); if (!entry) return [404, { error: 'no such ticket' }];
      if (entry.run_started) return [409, { error: 'already released', why: 'This ticket is already on the line.' }];
      // the hard stop on one build's cost: the drafter clamps to it, and a ticket that got past the drafter stops here
      if (!(entry.ticket?.budget?.usd <= BUILD_CAP_USD)) {
        return [422, { error: 'over the build cap', why: `This ticket asks for $${entry.ticket?.budget?.usd}; `
          + `one build may cost at most $${BUILD_CAP_USD}. It cannot be approved or released.` }];
      }
      const c = council(cfg); const sha = ticketHash(entry.ticket);
      const approval = { member: String(body.member), credential_id: body.credential_id, ticket_sha256: sha, authenticator_data: body.authenticator_data,
        client_data_json: body.client_data_json, signature: body.signature, at: new Date().toISOString(),
        ...(tasteNote(body.taste_note) ? { taste_note: tasteNote(body.taste_note) } : {}) };
      const v = verifyMemberSignature({ purpose: 'approval', subjectHash: approvalSubject(sha, approval.taste_note), approval, council: c });
      if (!v.ok) return [403, { error: 'signature refused', why: v.why }];
      const approvals = [...(entry.approvals ?? []).filter((a) => a.member !== approval.member), approval];
      const rel = verifyRelease(entry.ticket, approvals, c);
      // this signature would release the ticket: refuse it, unrecorded, when the build's budget would pass the total cap
      if (rel.ok && Number((totalSpent() + entry.ticket.budget.usd).toFixed(6)) > TOTAL_CAP_USD) {
        return [402, { error: 'total cap', why: totalWhy(` and this build may cost $${entry.ticket.budget.usd}`) }];
      }
      entry.approvals = approvals;
      if (rel.ok) entry.run_started = new Date().toISOString();
      writeTicketEntry(cfg, entry); broadcast({ type: 'ticket', id: entry.ticket.id });
      if (rel.ok) await release(entry);
      return [200, { ok: true, valid: rel.valid, threshold: rel.threshold, released: rel.ok }];
    },

    '/api/enrol/options': async (body) => {
      const inv = findInvite({ invitesFile: cfg.files.invites, token: body.token }); if (!inv.ok) return [403, { error: 'invite refused', why: inv.why }];
      const c = council(cfg); const m = c.members.find((x) => x.id === inv.member);
      return [200, { member: m.id, name: m.name, challenge: inv.challenge, rp: { id: c.rp.id, name: c.rp.name },
        user: { id: Buffer.from(`cambrian-council:${m.id}`).toString('base64url'), name: m.id, displayName: `${m.name} (council)` },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' }, attestation: 'none', timeout: 120000 }];
    },
    '/api/enrol': async (body) => {
      const tmpCouncil = join(cfg.state, 'council.enrol.json');   // enrol() checks against the site this server is on
      writeJson(tmpCouncil, council(cfg));
      const r = enrol({ councilFile: tmpCouncil, invitesFile: cfg.files.invites, token: body.token, registration: body });
      if (!r.ok) return [403, { error: 'enrolment refused', why: r.why }];
      const enrolled = readJson(tmpCouncil, null); const onDisk = readJson(cfg.files.council, null);
      for (const m of onDisk.members) m.credentials = enrolled.members.find((x) => x.id === m.id).credentials;
      writeJson(cfg.files.council, onDisk); broadcast({ type: 'council' });
      return [200, { ok: true, member: r.member }];
    },

    '/api/lessons/options': async (body) => {
      const d = readJson(draftsFile, { drafts: [] }).drafts.find((x) => x.id === body.lesson_id); if (!d) return [404, { error: 'no such draft' }];
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m?.credentials.length) return [403, { error: 'not an enrolled council member' }];
      const sha = hashOf(draftBody(d));
      return [200, { lesson_sha256: sha, challenge: lessonChallenge(sha), rpId: c.rp.id, allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred' }];
    },
    '/api/lessons/accept': async (body) => {
      const doc = readJson(draftsFile, { v: 1, drafts: [] }); const d = doc.drafts.find((x) => x.id === body.lesson_id); if (!d) return [404, { error: 'no such draft' }];
      const sha = hashOf(draftBody(d));
      const approval = { member: String(body.member), credential_id: body.credential_id, lesson_sha256: sha, authenticator_data: body.authenticator_data,
        client_data_json: body.client_data_json, signature: body.signature, at: new Date().toISOString() };
      const v = verifyMemberSignature({ purpose: 'lesson', subjectHash: sha, approval, council: council(cfg) });
      if (!v.ok) return [403, { error: 'signature refused', why: v.why }];
      const lesson = acceptLesson(cfg.files.lessons, d, { member: approval.member, approval, at: approval.at });
      doc.drafts = doc.drafts.filter((x) => x.id !== d.id); writeJson(draftsFile, doc); broadcast({ type: 'lesson', id: lesson.id });
      return [200, { ok: true, lesson }];
    },
  };

  return {
    modeExtra: () => ({ spent_today_usd: spentToday(), model: cfg.nearai.model, brief_model: model(), vercel: !!cfg.vercel.tokenFile,
      build_cap_usd: BUILD_CAP_USD, total_cap_usd: TOTAL_CAP_USD, total_spent_usd: totalSpent(),
      member_proposals: true, talk: true }),   // talk: this server holds a conversation before it drafts   // this server takes a council member's passkey-signed idea when it is exposed
    events(req, res) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write(`data: ${JSON.stringify({ type: 'hello', mode: 'live' })}\n\n`); clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); clients.delete(res); });
    },
    async post(path, req, res) {
      const h = handlers[path]; if (!h) return sendJson(res, 404, { error: 'not found' });
      // a page on another site must not be able to drive these: same-origin JSON only
      const origin = req.headers.origin; const allowed = council(cfg).rp.origins;
      if (origin && !allowed.includes(origin)) return sendJson(res, 403, { error: 'cross-origin request refused' });
      if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return sendJson(res, 415, { error: 'JSON only' });
      // a signing attempt is limited per visitor; a local guest's idea has its own limits in the handler
      const talking = path === '/api/talk/turn' || path === '/api/talk/draft';   // these have their own limit, per member
      if (!talking && (path !== '/api/ideas' || cfg.exposed)) {
        const lim = signing(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
        if (!lim.ok) return sendJson(res, 429, { error: 'slow down', why: `Too many attempts. Try again in ${lim.retry_s} s.` });
      }
      let body; try { body = await readBody(req, path === '/api/ideas' || path === '/api/talk/draft' ? MAX_IDEA_BODY : MAX_BODY); } catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
      // a handler that streams writes its own answer and returns nothing
      try { const answer = await h(body, req, res); if (!answer) return undefined; return sendJson(res, answer[0], answer[1]); } catch (e) {
        if (res.headersSent) { res.end(); return undefined; }   // a stream that failed part way: the page sees it end
        return sendJson(res, 500, { error: 'failed', why: String(e.message).slice(0, 200) });
      }
    },
    _test: { handlers, spentToday, totalSpent, readRun: (id) => readRun(cfg, id), draftsFile },
  };
}
