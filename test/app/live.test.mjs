// LIVE handlers with a test council and the line offline: a ticket is released at exactly 2 valid passkey
// signatures, never before; forged input is refused; when the app is exposed only a council member's passkey
// opens a brief. The model client is a stand-in: no call leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../../app/config.mjs';
import { makeLive, buildCapUsd, totalCapUsd } from '../../app/live.mjs';
import { snapshot } from '../../app/store.mjs';
import { ideaChallenge, ideaHash, ticketHash, verifyMemberSignature, verifyRelease } from '../../approvals/release.mjs';
import { detachReport, verifyAttestation, fetchReport, fetchAttestation } from '../../near/nearai.mjs';
import { checkDrafted } from '../../tickets/provenance.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { parseTicket } from '../../tickets/ticket.mjs';
import { draftBrief } from '../../tickets/brief.mjs';
import { parseLessons, lintBrief, lessonsBlock } from '../../lessons/lessons.mjs';
import { sandboxAvailable } from '../../line/kit/sandbox.mjs';

const root = appConfig().root;
const ticket = () => parseTicket(readFileSync(join(root, 'test/line/fixtures/tickets/facts-page-1.json')));
const sha = (x) => createHash('sha256').update(x).digest('hex');
const BRIEF_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
// A stand-in for near/nearai.mjs: one fixed completion with an id, the exact bodies and their hashes; a report; a signature.
function stubNear({ answer, attestation = 'ok' } = {}) {
  const seen = { chat: 0, order: [], last: null };
  return { seen, detachReport,
    fetchPricing: async () => ({ models: {} }),
    fetchReport: async ({ model, signingAlgo, nonce }) => { seen.order.push('report'); seen.report = { model, signingAlgo, nonce };
      return { stub: 'report', nonce }; },
    chat: async ({ model, messages, max_tokens }) => {
      seen.chat++; seen.order.push('chat'); seen.last = { model, max_tokens };
      const content = answer ?? JSON.stringify(good);
      const request_body = JSON.stringify({ model, messages, max_tokens });
      const response_body = `{"id":"chatcmpl-test-${seen.chat}",  "choices":[{"message":{"content":${JSON.stringify(content)}}}]}`;
      return { ok: true, status: 200, id: `chatcmpl-test-${seen.chat}`, model, content, usd: 0.01,
        request_sha256: sha(request_body), response_sha256: sha(response_body), request_body, response_body };
    },
    fetchAttestation: async (a) => {
      seen.order.push('attestation'); seen.attestation = a;
      if (attestation === 'throws') throw new Error('signature fetch failed: socket closed');
      if (attestation === 'none') return null;
      return { kind: 'provider_tee', model: a.model, chat_id: a.chatId, signing_algo: a.signingAlgo,
        signing_address: `0x${'ab'.repeat(20)}`,
        text: `${a.model}:${a.requestSha256}:${a.responseSha256}`, signature: 'stub', request_sha256: a.requestSha256,
          response_sha256: a.responseSha256,
        report: { model_name: a.model, stub: true, preflight: Boolean(a.report) } };
    },
    verifyAttestation: (att, h) => {
      const ok = att.text === `${att.model}:${h.requestSha256}:${h.responseSha256}`;
      return { ok, checks: [{ name: 'text_binds_hashes', ok, detail: ok ? 'ok' : 'no' }], ...(ok ? {} : { why: 'text_binds_hashes: no' }) };
    } };
}
const IDEA = 'a page that lists three facts about tide pools';
async function setup({ exposed = false, near = stubNear(), over = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'baby-cambrian-live-test-'));
  const data = join(dir, 'data'), state = join(dir, 'state'); mkdirSync(join(data, 'tickets'), { recursive: true }); mkdirSync(state, { recursive: true });
  const tc = makeTestCouncil();
  writeFileSync(join(data, 'council.json'), JSON.stringify(tc.council));
  writeFileSync(join(data, 'products.json'), JSON.stringify({ v: 1, products: [] }));
  cpSync(join(root, 'lessons/lessons.json'), join(dir, 'lessons.json'));
  const base = appConfig();
  const cfg = { ...base, ...over, mode: 'live', data, state, exposed, rp: { id: null, origin: null }, lineOverrides: { offline: true },
    nearai: { ...base.nearai, briefModel: null },
    files: { council: join(data, 'council.json'), stake: join(data, 'stake.json'), products: join(data, 'products.json'), lessons: join(dir, 'lessons.json'),
      talk: join(data, 'talk.json'), tickets: join(data, 'tickets'), runs: join(data, 'runs'), invites: join(state, 'invites.json') } };
  const t = ticket();
  writeFileSync(join(data, 'tickets', `${t.id}.json`), JSON.stringify({ ticket: t, created: '2026-11-12T00:00:00.000Z', approvals: [], run_started: null }));
  const live = await makeLive(cfg, { near });
  const post = (path, body) => live._test.handlers[path](body, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  const entry = (id) => JSON.parse(readFileSync(join(data, 'tickets', `${id}.json`), 'utf8'));
  return { dir, cfg, tc, t, live, post, near, entry, data, state };
}
const body = (t, a) => ({ ticket_id: t.id, member: a.member, credential_id: a.credential_id, authenticator_data: a.authenticator_data, client_data_json: a.client_data_json, signature: a.signature });

test('approve: one signature does not release; a forged one is refused; the second valid one releases and the line runs', async () => {
  const s = await setup();
  try {
    const opt = await s.post('/api/approve/options', { ticket_id: s.t.id, member: 'jj' });
    assert.equal(opt[0], 200); assert.equal(opt[1].allowCredentials.length, 1);
    const one = await s.post('/api/approve', body(s.t, s.tc.sign('jj', s.t)));
    assert.equal(one[0], 200); assert.equal(one[1].released, false); assert.deepEqual(one[1].valid, ['jj']);
    const again = await s.post('/api/approve', body(s.t, s.tc.sign('jj', s.t)));
    assert.equal(again[1].released, false, 'the same member twice is still one');
    const other = makeTestCouncil();
    const forged = await s.post('/api/approve', { ...body(s.t, other.sign('clemens', s.t)), credential_id: s.tc.council.members[0].credentials[0].id });
    assert.equal(forged[0], 403);
    assert.equal(existsSync(join(s.cfg.files.runs, s.t.id)), false, 'nothing has started');
    if (!sandboxAvailable().ok) return;   // without a sandbox the line refuses to run; the release rule above is still proven
    const two = await s.post('/api/approve', body(s.t, s.tc.sign('clemens', s.t)));
    assert.equal(two[1].released, true);
    const late = await s.post('/api/approve', body(s.t, s.tc.sign('michael', s.t)));
    assert.equal(late[0], 409, 'a released ticket takes no more approvals');
    let rec = null;
    for (let i = 0; i < 600 && !(rec = s.live._test.readRun(s.t.id))?.finished; i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(rec?.state ?? 'not finished', /^green/); assert.deepEqual(rec.release.valid, ['clemens', 'jj']);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('exposed: a guest cannot propose an idea; nothing is sent to a model', async () => {
  const s = await setup({ exposed: true });
  try {
    const other = makeTestCouncil(); const cred = s.tc.council.members.find((m) => m.id === 'jj').credentials[0].id;
    const refused = {
      'no assertion': { idea: IDEA },
      'a member named, nothing signed': { idea: IDEA, member: 'jj' },
      'forged: another key under the member\'s credential id': { idea: IDEA, ...other.signIdea('jj', IDEA), credential_id: cred },
      'wrong purpose: an approval signature': { idea: IDEA, ...s.tc.sign('jj', s.t) },
      'wrong purpose: a lesson signature over the idea hash': { idea: IDEA, ...s.tc.signLesson('jj', ideaHash(IDEA)) },
      'signed, but for another idea': { idea: IDEA, ...s.tc.signIdea('jj', `${IDEA}!`) },
      'signed on another site': { idea: IDEA, ...s.tc.signIdea('jj', IDEA, { origin: 'https://elsewhere.example' }) },
      'someone outside the council': { idea: IDEA, ...s.tc.signIdea('jj', IDEA), member: 'nobody' },
    };
    for (const [what, body] of Object.entries(refused)) {
      const r = await s.post('/api/ideas', body); assert.equal(r[0], 403, what); assert.match(r[1].why, /passkey/, what);
    }
    assert.equal((await s.post('/api/ideas/options', { idea: IDEA, member: 'nobody' }))[0], 403);
    assert.equal(s.near.seen.chat, 0, 'the model was never called');
    assert.deepEqual(s.near.seen.order, [], 'nor was anything else fetched');
    assert.deepEqual(snapshot(s.cfg)['api/tickets.json'].tickets.map((x) => x.ticket.id), [s.t.id], 'no ticket was written');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('exposed: a council member\'s passkey over the idea opens a brief; the proposer is recorded and is not an approval', async () => {
  const s = await setup({ exposed: true });
  try {
    const opt = await s.post('/api/ideas/options', { idea: IDEA, member: 'jj' });
    assert.equal(opt[0], 200); assert.equal(opt[1].idea_sha256, ideaHash(IDEA));
    assert.equal(opt[1].challenge, ideaChallenge(ideaHash(IDEA)));
    assert.equal(opt[1].allowCredentials.length, 1); assert.equal(opt[1].rpId, 'localhost');
    const signedIdea = s.tc.signIdea('jj', IDEA);
    const r = await s.post('/api/ideas', { idea: IDEA, ...signedIdea });
    assert.equal(r[0], 200, JSON.stringify(r[1])); assert.equal(r[1].proposed_by, 'jj'); assert.equal(s.near.seen.chat, 1);
    const e = s.entry(r[1].brief.id);
    assert.equal(e.proposed_by.member, 'jj'); assert.deepEqual(e.approvals, []);
    // the kept assertion can be checked again, as an idea signature and as nothing else
    const c = s.tc.council;
    assert.equal(verifyMemberSignature({ purpose: 'idea', subjectHash: ideaHash(IDEA), approval: e.proposed_by.approval, council: c }).ok,
      true);
    assert.equal(verifyMemberSignature({ purpose: 'approval', subjectHash: ticketHash(e.ticket), approval: e.proposed_by.approval,
      council: c }).ok, false);
    assert.deepEqual(verifyRelease(e.ticket, [{ ...e.proposed_by.approval, ticket_sha256: ticketHash(e.ticket) }], c).valid, []);
    const replayed = await s.post('/api/approve', { ticket_id: e.ticket.id, ...e.proposed_by.approval });
    assert.equal(replayed[0], 403, 'the proposer\'s signature is refused as an approval');
    const listed = snapshot(s.cfg)['api/tickets.json'].tickets.find((x) => x.ticket.id === e.ticket.id);
    assert.deepEqual(listed.release.valid, [], 'proposing does not count toward the 2 of 3');
    assert.equal(listed.status, 'awaiting-approval');
    assert.equal(JSON.parse(readFileSync(s.cfg.files.talk, 'utf8')).conversations[0].proposed_by, 'jj');
    // the same signature does not open a second brief
    const again = await s.post('/api/ideas', { idea: IDEA, ...signedIdea });
    assert.equal(again[0], 403); assert.match(again[1].why, /already used/); assert.equal(s.near.seen.chat, 1);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('not exposed: a local guest still proposes without a passkey, and the ticket says nobody signed the idea', async () => {
  const s = await setup();
  try {
    const r = await s.post('/api/ideas', { idea: IDEA });
    assert.equal(r[0], 200); assert.equal(r[1].proposed_by, null); assert.equal(s.entry(r[1].brief.id).proposed_by, null);
    assert.equal(JSON.parse(readFileSync(s.cfg.files.talk, 'utf8')).conversations[0].proposed_by, null);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the brief is drafted by the TEE-hosted model; its exact bytes, report and signature are kept beside the ticket', async () => {
  const s = await setup();
  try {
    const r = await s.post('/api/ideas', { idea: IDEA });
    assert.equal(r[0], 200, JSON.stringify(r[1]));
    assert.deepEqual(s.near.seen.order, ['report', 'chat', 'attestation'], 'one report BEFORE the call, the signature after it');
    assert.deepEqual(s.near.seen.last, { model: BRIEF_MODEL, max_tokens: 4000 });
    assert.equal(s.near.seen.report.model, BRIEF_MODEL); assert.equal(s.near.seen.report.signingAlgo, 'ecdsa');
    assert.match(s.near.seen.report.nonce, /^[0-9a-f]{64}$/);
    const id = r[1].brief.id; const e = s.entry(id); const d = e.ticket.drafted;
    const f = (n) => join(s.data, 'tickets', `${id}.${n}.json`);
    assert.deepEqual(Object.keys(d).sort(), ['completion_id', 'model', 'request_sha256', 'response_sha256']);
    assert.equal(d.model, BRIEF_MODEL); assert.equal(d.completion_id, 'chatcmpl-test-1');
    assert.equal(sha(readFileSync(f('brief-response'))), d.response_sha256, 'the kept response is the bytes the ticket names');
    assert.equal(sha(readFileSync(f('brief-request'))), d.request_sha256);
    assert.match(readFileSync(f('brief-response'), 'utf8'), /^\{"id":"chatcmpl-test-1",  "choices"/, 'written as it came, not reformatted');
    assert.notEqual(sha(readFileSync(f('brief-response'))), sha(`${readFileSync(f('brief-response'), 'utf8')}\n`));
    assert.deepEqual(s.near.seen.attestation, { chatId: 'chatcmpl-test-1', model: BRIEF_MODEL, requestSha256: d.request_sha256,
      responseSha256: d.response_sha256,
      report: { stub: 'report', nonce: s.near.seen.report.nonce }, signingAlgo: 'ecdsa', keyFile: s.cfg.nearai.keyFile,
        base: s.cfg.nearai.base });
    assert.equal(e.brief.attestation.report.detached, true); assert.equal(e.brief.attestation_check.ok, true);
    assert.equal(sha(JSON.stringify(JSON.parse(readFileSync(f('brief-report'), 'utf8')))), e.brief.attestation.report.sha256,
      'the kept report is the detached one');
    assert.equal(e.brief.attestation.text, `${BRIEF_MODEL}:${d.request_sha256}:${d.response_sha256}`);
    // the listing: the extra files are not tickets; each ticket carries the short form of the signature and `drafted`
    const snap = snapshot(s.cfg, s.live.modeExtra()); const tickets = snap['api/tickets.json'].tickets;
    assert.deepEqual(tickets.map((x) => x.ticket.id).sort(), [s.t.id, id].sort());
    const listed = tickets.find((x) => x.ticket.id === id);
    assert.deepEqual(listed.brief.attestation, { kind: 'provider_tee', signing_algo: 'ecdsa', signing_address: `0x${'ab'.repeat(20)}`,
      ok: true });
    assert.deepEqual(listed.drafted, d); assert.equal(listed.ticket_sha256, ticketHash(e.ticket));
    assert.equal(tickets.find((x) => x.ticket.id === s.t.id).drafted, null);
    assert.deepEqual(r[1].attestation, listed.brief.attestation); assert.deepEqual(r[1].drafted, d);
    assert.equal(snap['api/mode.json'].brief_model, BRIEF_MODEL);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('a signature that cannot be fetched never blocks the brief: attestation null, with a note', async () => {
  for (const [mode, note] of [['throws', /could not be fetched \(signature fetch failed: socket closed\)/], ['none',
    /returned no signature/]]) {
    const s = await setup({ near: stubNear({ attestation: mode }) });
    try {
      const r = await s.post('/api/ideas', { idea: IDEA }); assert.equal(r[0], 200, mode);
      const e = s.entry(r[1].brief.id);
      assert.equal(e.brief.attestation, null); assert.equal(e.brief.attestation_check, null); assert.match(e.brief.attestation_note, note);
      assert.equal(r[1].attestation, null);
      assert.match(e.ticket.drafted.response_sha256, /^[0-9a-f]{64}$/, 'the ticket still names its response');
      assert.equal(existsSync(join(s.data, 'tickets', `${e.ticket.id}.brief-response.json`)), true);
      assert.equal(existsSync(join(s.data, 'tickets', `${e.ticket.id}.brief-report.json`)), false);
      assert.equal(snapshot(s.cfg)['api/tickets.json'].tickets.find((x) => x.ticket.id === e.ticket.id).brief.attestation, null);
    } finally { rmSync(s.dir, { recursive: true, force: true }); }
  }
});
test('approve: an approval made before the drafted response hash was altered is refused; over the unaltered ticket it is taken',
  async () => {
  const s = await setup();
  try {
    const r = await s.post('/api/ideas', { idea: IDEA }); const id = r[1].brief.id; const before = s.entry(id);
    const early = s.tc.sign('jj', before.ticket);
    const altered = structuredClone(before); altered.ticket.drafted.response_sha256 = 'f'.repeat(64);
    assert.notEqual(ticketHash(altered.ticket), ticketHash(before.ticket));
    writeFileSync(join(s.data, 'tickets', `${id}.json`), JSON.stringify(altered));
    const refused = await s.post('/api/approve', body(altered.ticket, early));
    assert.equal(refused[0], 403); assert.match(refused[1].why, /different challenge/); assert.deepEqual(s.entry(id).approvals, []);
    writeFileSync(join(s.data, 'tickets', `${id}.json`), JSON.stringify(before));
    const taken = await s.post('/api/approve', body(before.ticket, early));
    assert.equal(taken[0], 200); assert.deepEqual(taken[1].valid, ['jj']);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the build cap: a ticket that asks for more than $2 is refused at approval and never released', async () => {
  assert.equal(buildCapUsd({}), 2); assert.equal(buildCapUsd({ CAMBRIAN_BUILD_CAP_USD: '1.5' }), 1.5);
  assert.equal(buildCapUsd({ CAMBRIAN_BUILD_CAP_USD: 'x' }), 2);
  assert.equal(totalCapUsd({}), 15); assert.equal(totalCapUsd({ CAMBRIAN_TOTAL_CAP_USD: '40' }), 40);
  const rich = (s) => { const t = parseTicket({ ...s.t, budget: { ...s.t.budget, usd: 3 } });
    writeFileSync(join(s.data, 'tickets', `${t.id}.json`), JSON.stringify({ ticket: t, created: '2026-11-12T00:00:00.000Z', approvals: [],
      run_started: null })); return t; };
  const s = await setup();
  try {
    const t = rich(s);
    for (const m of ['jj', 'clemens', 'michael']) {
      const r = await s.post('/api/approve', body(t, s.tc.sign(m, t))); assert.equal(r[0], 422, m); assert.match(r[1].why, /at most \$2/);
    }
    assert.deepEqual(s.entry(t.id).approvals, []); assert.equal(s.entry(t.id).run_started, null);
    assert.equal(existsSync(join(s.cfg.files.runs, t.id)), false, 'nothing was released');
    assert.equal(snapshot(s.cfg, s.live.modeExtra())['api/mode.json'].build_cap_usd, 2);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
  const raised = await setup({ over: { buildCapUsd: 3 } });   // the other direction: under the cap the same approval is taken
  try { const t = rich(raised); assert.equal((await raised.post('/api/approve', body(t, raised.tc.sign('jj', t))))[0], 200); }
  finally { rmSync(raised.dir, { recursive: true, force: true }); }
});
test('the total cap: every dollar ever spent counts; at the cap an idea is refused, and a release that would pass it is refused',
  async () => {
  const s = await setup({ over: { totalCapUsd: 1 } });
  try {
    // what counts: runs of this line (not imported ones), plus every brief and lesson draft ever
    for (const [id, origin, usd] of [['mine-one', 'baby', 0.25], ['theirs-one', 'private-line', 9]]) {
      mkdirSync(join(s.cfg.files.runs, id), { recursive: true });
      writeFileSync(join(s.cfg.files.runs, id, 'run.json'), JSON.stringify({ ticket: { id }, origin, started: '2026-11-01T00:00:00.000Z',
        attempts: [{ bridge: { computed_usd: usd } }] }));
    }
    assert.equal(s.live._test.totalSpent(), 0.25);
    const r = await s.post('/api/ideas', { idea: IDEA }); assert.equal(r[0], 200);
    assert.equal(JSON.parse(readFileSync(join(s.state, 'brief-spend-total.json'), 'utf8')).usd, 0.01,
      'the running total is kept beside the per-day file');
    assert.equal(JSON.parse(readFileSync(join(s.state, 'brief-spend.json'), 'utf8')).usd, 0.01);
    const mode = snapshot(s.cfg, s.live.modeExtra())['api/mode.json'];
    assert.equal(mode.total_spent_usd, 0.26); assert.equal(mode.total_cap_usd, 1);
    // a release: $0.26 spent + the ticket's $1.50 would pass $1 — the releasing signature is refused and not recorded
    assert.equal((await s.post('/api/approve', body(s.t, s.tc.sign('jj', s.t))))[0], 200, 'one signature releases nothing, so it is taken');
    const two = await s.post('/api/approve', body(s.t, s.tc.sign('clemens', s.t)));
    assert.equal(two[0], 402); assert.match(two[1].why, /total cap of \$1/);
    assert.equal(s.entry(s.t.id).approvals.length, 1); assert.equal(s.entry(s.t.id).run_started, null);
    assert.equal(existsSync(join(s.cfg.files.runs, s.t.id)), false, 'nothing was released');
    // an idea: with the total spent, nothing is sent to a model
    writeFileSync(join(s.state, 'brief-spend-total.json'), JSON.stringify({ usd: 0.75, calls: 9 }));
    const calls = s.near.seen.chat; const idea = await s.post('/api/ideas', { idea: IDEA });
    assert.equal(idea[0], 402); assert.match(idea[1].why, /total cap/); assert.equal(s.near.seen.chat, calls, 'no model call');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('the judge\'s check of a drafted ticket: a real recorded model signature holds; a changed response, hash or approval does not',
  async () => {
  // real bytes recorded from NEAR AI Cloud (test/near/fixtures): the request, the response, the model TEE's report and signature
  const FIX = join(root, 'test/near/fixtures'); const source = JSON.parse(readFileSync(join(FIX, 'source.json'), 'utf8'));
  const dir = mkdtempSync(join(tmpdir(), 'baby-cambrian-provenance-test-'));
  try {
    const keyFile = join(dir, 'not-a-key'); writeFileSync(keyFile, 'offline-replay-no-key', { mode: 0o600 });
    const serve = async (url) => { const u = new URL(url);
      const file = u.pathname.endsWith('/attestation/report') ? 'report.ecdsa.json' : 'tool.sig.ecdsa.json';
      return new Response(readFileSync(join(FIX, file)), { status: 200, headers: { 'content-type': 'application/json' } }); };
    const request = readFileSync(join(FIX, 'tool.request.json')), response = readFileSync(join(FIX, 'tool.response.json'));
    const hashes = { requestSha256: sha(request), responseSha256: sha(response) }; const base = 'http://replay.invalid/v1';
    const report = await fetchReport({ model: BRIEF_MODEL, signingAlgo: 'ecdsa', nonce: source.report.nonce, base, fetchImpl: serve });
    report.fetched_at = source.report.fetched_at;
    const att = await fetchAttestation({ chatId: source.chats.tool.chat_id, model: BRIEF_MODEL, ...hashes, keyFile, base,
      signingAlgo: 'ecdsa', report, fetchImpl: serve, retryMs: 1 });
    assert.equal(verifyAttestation(att, hashes).ok, true, verifyAttestation(att, hashes).why);
    const kept = detachReport(att); const tc = makeTestCouncil();
    const t = parseTicket({ ...ticket(), drafted: { model: BRIEF_MODEL, completion_id: source.chats.tool.chat_id,
      request_sha256: hashes.requestSha256, response_sha256: hashes.responseSha256 } });
    const entry = { ticket: t, idea: IDEA, approvals: [tc.sign('jj', t), tc.sign('clemens', t)], proposed_by: { member: 'michael',
      approval: tc.signIdea('michael', IDEA) },
      brief: { attestation: kept.att, attestation_check: { ok: true, checks: [] } } };
    const f = (n) => join(dir, `${t.id}.${n}.json`);
    writeFileSync(f('brief-response'), response); writeFileSync(f('brief-request'), request);
    writeFileSync(f('brief-report'), JSON.stringify(kept.report, null, 2));
    const run = (e = entry) => checkDrafted({ dir, entry: e, council: tc.council });
    assert.deepEqual(run(), { faults: [], signed: true, approvals: 2 });
    // one drafted hash changed after signing: the kept response, the model's signature and both approvals all stop agreeing
    const moved = structuredClone(entry);
    moved.ticket.drafted.response_sha256 = hashes.responseSha256.replace(/^./, (c) => (c === '0' ? '1' : '0'));
    const m = run(moved); assert.equal(m.signed, false); assert.equal(m.approvals, 0);
    assert.equal(m.faults.length, 4, m.faults.join(' | '));
    const otherModel = structuredClone(entry); otherModel.ticket.drafted.model = 'another/model'; otherModel.approvals = [];
    assert.match(run(otherModel).faults.join(' | '), /does not bind the model another\/model/);
    assert.match(run({ ...entry, proposed_by: { member: 'michael', approval: tc.signIdea('michael', 'another idea') } }).faults.join(' | '),
      /proposer/);
    assert.deepEqual(run({ ...entry, brief: { attestation: null } }), { faults: [], signed: false, approvals: 2 },
      'no signature recorded: not signed, and not called signed');
    writeFileSync(f('brief-response'), Buffer.concat([response, Buffer.from(' ')]));
    assert.match(run().faults.join(' | '), /kept response is not the one the ticket names/);
    writeFileSync(f('brief-response'), response);
    writeFileSync(f('brief-report'), JSON.stringify({ ...kept.report, signing_address: '0x00' }));
    assert.match(run().faults.join(' | '), /model's signature/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('enrol: an unknown invite is refused', async () => {
  const s = await setup();
  try { assert.equal((await s.post('/api/enrol/options', { token: 'nope' }))[0], 403); } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

const lessons = parseLessons(readFileSync(join(root, 'lessons/lessons.json'), 'utf8')).lessons;
const good = { product: 'tides', title: 'Tide pool facts page', goal: 'A page with three tide pool facts.',
  task: 'Write index.html with a heading and exactly three facts about tide pools in a list. No scripts, no external files. Out of scope: styling beyond a readable default.',
  out_of_scope: ['styling'], green: [{ id: 'page', kind: 'file', path: 'index.html', contains: ['tide'], name: 'the page exists' }], budget: { usd: 1, calls: 20, minutes: 10 } };
const deps = (answers, extra = () => ({})) => { let i = 0; const seen = []; return { seen, lessons, lintBrief, lessonsBlock, products: [],
  existing: [], idSuffix: 'abc123', capUsd: 5,
  chat: async (m) => { seen.push(m); return { ok: true, content: answers[Math.min(i++, answers.length - 1)], usd: 0.001, model: 'm',
    ...extra(i) }; } }; };

test('brief: a model draft becomes a valid ticket, linted by the lessons; the builder line is appended by a lesson', async () => {
  const d = deps(['```json\n' + JSON.stringify(good) + '\n```']);
  const r = await draftBrief('a page that lists three facts about tide pools', d);
  assert.equal(r.ok, true); assert.equal(r.brief.id, 'tides-abc123'); assert.equal(r.brief.branch, 'build/tides-abc123');
  assert.ok(r.lint.applied.some((x) => x.lesson === 'write-files-early')); assert.match(r.brief.task, /Write files early/);
  assert.match(d.seen[0].messages[0].content, /LESSONS FROM EARLIER RUNS/);
});
test('brief: the budget is clamped whatever the model asks for; garbage is redrafted once, then refused', async () => {
  const greedy = await draftBrief('a page that lists three facts about tide pools', deps([JSON.stringify({ ...good, budget: { usd: 500, calls: 9999, minutes: 600 } })]));
  assert.deepEqual(greedy.brief.budget, { usd: 2, calls: 40, minutes: 15 });
  const d = deps(['I would love to help!']); const bad = await draftBrief('a page that lists three facts about tide pools', d);
  assert.equal(bad.ok, false); assert.equal(d.seen.length, 2); assert.equal(bad.usd, 0.002);
  assert.equal((await draftBrief('hi', deps([]))).ok, false);
});
test('brief: a draft with money in its title is refused by a lesson and redrafted', async () => {
  const d = deps([JSON.stringify({ ...good, title: 'Tide facts for $5' }), JSON.stringify(good)]);
  const r = await draftBrief('a page that lists three facts about tide pools', d);
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.match(d.seen[1].messages.at(-1).content, /rules learned from earlier runs/);
});

test('brief: the ticket names the call whose answer became it (the accepted draft), and its hash covers that response hash', async () => {
  const call = (n) => ({ id: `chatcmpl-${n}`, requested_model: 'asked/model', request_sha256: sha(`req${n}`),
    response_sha256: sha(`res${n}`),
    request_body: `req${n}`, response_body: `res${n}` });
  const d = deps([JSON.stringify({ ...good, title: 'Tide facts for $5' }), JSON.stringify(good)], call);
  const r = await draftBrief(IDEA, d);
  assert.equal(r.ok, true); assert.equal(r.attempts, 2); assert.equal(d.seen[0].max_tokens, 4000);
  const drafted = { model: 'asked/model', completion_id: 'chatcmpl-2', request_sha256: sha('req2'), response_sha256: sha('res2') };
  assert.deepEqual(r.brief.drafted, drafted, 'the second call was accepted; the refused first one is not named');
  assert.deepEqual(r.call, { ...drafted, request_body: 'req2', response_body: 'res2' });
  assert.deepEqual(parseTicket(r.brief), r.brief, 'still a valid ticket');
  assert.notEqual(ticketHash(r.brief), ticketHash({ ...r.brief, drafted: { ...drafted, response_sha256: sha('res1') } }));
  // derived, not identical: the kept response is the model's words; the ticket has our id and a lesson's line
  assert.equal(r.brief.id, 'tides-abc123'); assert.match(r.brief.task, /Write files early/);
  assert.doesNotMatch(JSON.stringify(good), /Write files early/);
  // a chat that reports no completion id or hashes: no provenance is invented
  const bare = await draftBrief(IDEA, deps([JSON.stringify(good)]));
  assert.equal(bare.ok, true); assert.equal(bare.brief.drafted, undefined); assert.equal(bare.call, null);
});
