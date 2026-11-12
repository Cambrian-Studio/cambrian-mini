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
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sendJson } from './http.mjs';
import { council, listTickets, readTicketEntry, writeTicketEntry, writeJson, listRuns, readRun, attestationSummary } from './store.mjs';
import { enrol, findInvite } from '../approvals/council.mjs';
import { approvalChallenge, ideaChallenge, ideaHash, lessonChallenge, verifyMemberSignature, verifyRelease, ticketHash }
  from '../approvals/release.mjs';
import { hashOf } from '../receipts/canonical.mjs';
import { draftBrief, BRIEF_MODEL, MAX_IDEA } from '../tickets/brief.mjs';
import { parseLessons, lessonsBlock, lintBrief } from '../lessons/lessons.mjs';
import { acceptLesson, recordFired } from '../lessons/store.mjs';
import { draftLesson } from '../lessons/draft.mjs';
import * as nearai from '../near/nearai.mjs';

const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const utcDay = () => new Date().toISOString().slice(0, 10);
const MAX_BODY = 64 * 1024;
const usdCap = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
/** The most ONE build may cost: $2, or CAMBRIAN_BUILD_CAP_USD. A ticket that asks for more is never released. */
export const buildCapUsd = (env = process.env) => usdCap(env.CAMBRIAN_BUILD_CAP_USD, 2);
/** The most this app may cause in model spend in total, builds and drafts, over all days: $15, or CAMBRIAN_TOTAL_CAP_USD. */
export const totalCapUsd = (env = process.env) => usdCap(env.CAMBRIAN_TOTAL_CAP_USD, 15);

async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) throw new Error('request body too large'); chunks.push(c); }
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
  const totalSpent = () => Number((sideTotal().usd + listRuns(cfg).filter((r) => (r.origin ?? 'baby') === 'baby')
    .reduce((s, r) => s + (r.attempts ?? []).reduce((x, a) => x + attemptUsd(a), 0), 0)).toFixed(6));
  const totalWhy = (extra = '') => `The total cap of $${TOTAL_CAP_USD} for this app would be passed: $${totalSpent()} is spent${extra}. `
    + 'Nothing more is sent to a model until the operator raises it.';
  const runSpendToday = () => listRuns(cfg).filter((r) => (r.origin ?? 'baby') === 'baby' && String(r.started).slice(0, 10) === utcDay())
    .reduce((s, r) => s + (r.attempts ?? []).reduce((x, a) => x + (a.bridge?.computed_usd ?? 0), 0), 0);
  const spentToday = () => Number((sideSpend().usd + runSpendToday()).toFixed(6));
  const chat = async ({ messages, max_tokens }) => {
    // briefs and lesson drafts are paid from the same day's cap as builds: once it is spent, no model call
    if (spentToday() >= cfg.dailyCapUsd) return { ok: false, usd: 0, why: 'the daily cap is spent' };
    if (totalSpent() >= TOTAL_CAP_USD) return { ok: false, usd: 0, why: 'the total cap is spent' };
    const asked = model();
    const r = await near.chat({ model: asked, messages, max_tokens, keyFile: cfg.nearai.keyFile, base: cfg.nearai.base,
      pricing: await getPricing() });
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
  function proposerOf(body) {
    if (typeof body.idea !== 'string' || !body.idea.trim()) return { ok: false, why: 'no idea was sent' };
    if (body.idea.length > MAX_IDEA) return { ok: false, why: `keep the idea under ${MAX_IDEA} characters` };
    const sha = ideaHash(body.idea);
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
      daily_ceiling_usd: Math.max(0.01, Number((cfg.dailyCapUsd - sideSpend().usd).toFixed(6))),
      ...(cfg.lineOverrides ?? {}),   // tests only: run the line offline
      ...(cfg.publish.remote ? { publish_remote: cfg.publish.remote, publish_token_file: cfg.publish.tokenFile } : {}) });
    const hooks = {
      onUpdate: (rec) => broadcast({ type: 'run', run: rec }),
      onRed: async (rec, failureLog) => {
        const draft = await draftLesson({ run: rec, failureLog, chat, model: model() });
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
          if (!doc.products.some((p) => p.id === entry.ticket.product)) {
            doc.products.push({ id: entry.ticket.product, name: entry.ticket.product, tagline: entry.ticket.goal ?? entry.ticket.title, status: 'preview',
              live_url: null, built_on: 'this line', first_run: entry.ticket.id });
            writeJson(cfg.files.products, doc);
          }
        } for (const n of rec?.notifications ?? []) broadcast({ type: 'notification', notification: { ...n, run: entry.ticket.id } }); })
      .catch((e) => broadcast({ type: 'error', why: `the run for ${entry.ticket.id} did not start: ${String(e.message).slice(0, 200)}` }));
  }
  const draftBody = (d) => ({ id: d.id, rule: d.rule, failure: d.failure ?? '', applies_to: d.applies_to, check: d.check ?? null, fix: d.fix ?? null, from_run: d.from_run ?? null });

  // ---- handlers -------------------------------------------------------------------------------------------
  const handlers = {
    '/api/ideas': async (body, req) => {
      let proposer = null;
      if (cfg.exposed) {
        const p = proposerOf(body);
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
      const lessons = lessonsNow(); const tickets = listTickets(cfg);
      const products = readJson(cfg.files.products, { products: [] }).products ?? [];
      // ONE report of the brief model's TEE, taken before the call, so the signature fetched after it is checked against it
      let report = null;
      try {
        report = await near.fetchReport({ model: model(), signingAlgo: 'ecdsa', nonce: randomBytes(32).toString('hex'),
          base: cfg.nearai.base });
      } catch { report = null; }
      const r = await draftBrief(body.idea, { chat, lessons, lintBrief, lessonsBlock, products,
        existing: tickets.map((t) => ({ id: t.ticket.id, title: t.ticket.title, task: t.ticket.task })),
        idSuffix: randomBytes(3).toString('hex'), capUsd: Math.min(cfg.dailyCapUsd, BUILD_CAP_USD) });
      const at = new Date().toISOString();
      const sig = r.ok ? await attest(r.call, report) : null;
      const meta = sig ? { attestation: sig.attestation, attestation_check: sig.check,
        ...(sig.note ? { attestation_note: sig.note } : {}) } : {};
      const talk = readJson(cfg.files.talk, { v: 1, conversations: [] });
      const convo = { id: `talk-${at.replace(/[^0-9]/g, '').slice(0, 14)}`, at, usd: Number((r.usd ?? 0).toFixed(6)),
        model: r.model ?? model(), proposed_by: proposer?.member ?? null, ...(sig ? { attestation: attestationSummary(meta) } : {}),
        messages: [{ role: 'member', text: String(body.idea).slice(0, MAX_IDEA) },
          r.ok ? { role: 'cambrian', brief: r.brief, lint: r.lint } : { role: 'cambrian', text: r.why, lint: r.lint ?? null }] };
      talk.conversations = [convo, ...talk.conversations].slice(0, 50); writeJson(cfg.files.talk, talk);
      if (!r.ok) return [422, { error: 'no brief', why: r.why, lint: r.lint ?? null, usd: r.usd ?? 0 }];
      // proposed_by keeps the verified passkey assertion over the idea, so it can be checked again; null for a local guest.
      // It is NOT an approval: it signs another challenge and is never counted toward the 2 of 3.
      const entry = { ticket: r.brief, created: at, idea: convo.messages[0].text, lint: r.lint,
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
      return [200, { brief: r.brief, ticket_sha256: ticketHash(r.brief), lint: r.lint, usd: convo.usd, model: convo.model,
        drafted: r.brief.drafted ?? null, attestation: attestationSummary(meta), proposed_by: proposer?.member ?? null }];
    },
    '/api/ideas/options': async (body) => {
      if (typeof body.idea !== 'string' || !body.idea.trim()) return [400, { error: 'no idea', why: 'Write the idea first.' }];
      if (body.idea.length > MAX_IDEA) return [400, { error: 'too long', why: `Keep the idea under ${MAX_IDEA} characters.` }];
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m?.credentials.length) {
        return [403, { error: 'not an enrolled council member', why: 'Only a council member with an enrolled passkey can propose here.' }];
      }
      const sha = ideaHash(body.idea);
      return [200, { idea_sha256: sha, challenge: ideaChallenge(sha), rpId: c.rp.id,
        allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
    },

    '/api/approve/options': async (body) => {
      const entry = readTicketEntry(cfg, body.ticket_id); if (!entry) return [404, { error: 'no such ticket' }];
      const c = council(cfg); const m = c.members.find((x) => x.id === body.member);
      if (!m) return [403, { error: 'not a council member' }];
      if (!m.credentials.length) return [409, { error: 'not enrolled', why: `${m.name} has not enrolled a passkey yet (one-time invite link).` }];
      const sha = ticketHash(entry.ticket);
      return [200, { ticket_sha256: sha, challenge: approvalChallenge(sha), rpId: c.rp.id, allowCredentials: m.credentials.map((k) => ({ type: 'public-key', id: k.id })), userVerification: 'preferred', timeout: 120000 }];
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
        client_data_json: body.client_data_json, signature: body.signature, at: new Date().toISOString() };
      const v = verifyMemberSignature({ purpose: 'approval', subjectHash: sha, approval, council: c });
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
      member_proposals: true }),   // this server takes a council member's passkey-signed idea when it is exposed
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
      if (path !== '/api/ideas' || cfg.exposed) {
        const lim = signing(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? 'unknown');
        if (!lim.ok) return sendJson(res, 429, { error: 'slow down', why: `Too many attempts. Try again in ${lim.retry_s} s.` });
      }
      let body; try { body = await readBody(req); } catch (e) { return sendJson(res, 400, { error: String(e.message) }); }
      try { const [status, out] = await h(body, req); return sendJson(res, status, out); } catch (e) { return sendJson(res, 500, { error: 'failed', why: String(e.message).slice(0, 200) }); }
    },
    _test: { handlers, spentToday, totalSpent, readRun: (id) => readRun(cfg, id), draftsFile },
  };
}
