// Talk to Cambrian is a conversation before it is a brief: thinking turns that are never a brief, a draft made
// from the conversation, a new version for each further instruction, lessons shown inline, and "Send to council"
// putting that exact ticket in Approvals with the conversation's hash under every signature.
// The model client is a stand-in: no call leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../../app/config.mjs';
import { makeLive } from '../../app/live.mjs';
import { snapshot } from '../../app/store.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { ideaChallenge, ticketHash, verifyMemberSignature, verifyRelease } from '../../approvals/release.mjs';
import { INTENT_SYSTEM } from '../../tickets/intent.mjs';
import { BRIEF_MODEL } from '../../tickets/brief.mjs';
import { briefChanges, conversationHash, isReady, sentenceGate, THINK_SYSTEM, MAX_QUESTIONS } from '../../tickets/think.mjs';

const root = appConfig().root;
const sha = (x) => createHash('sha256').update(x).digest('hex');
const base = { product: 'tides', title: 'Tide pool facts page', goal: 'A page with three tide pool facts for a child.',
  task: 'Write index.html with a heading and exactly three facts about tide pools in a list. No scripts, no external files. Out of scope: styling.',
  out_of_scope: ['styling'], budget: { usd: 1, calls: 20, minutes: 10 },
  green: [{ id: 'page', kind: 'file', path: 'index.html', contains: ['tide'], name: 'the page exists' },
    { id: 'login', kind: 'file', path: 'login.html', contains: ['password'], name: 'there is a login page' }] };
const simpler = { ...base, title: 'Tide pool facts, one page', green: [base.green[0]], out_of_scope: ['styling', 'a login'] };
const revised = { ...base, product: 'whatever', title: 'Upread, calmer reading view', goal: 'The reader looks calmer.',
  task: 'Change the reading view of the existing page: larger line height and a narrower column. Keep opening a PDF working. Out of scope: new features.',
  green: [{ id: 'calmer', kind: 'file', path: 'index.html', contains: ['line-height'], name: 'the text has more room between lines' }] };
const THINKS = 'That is two products. Which one matters first? Who reads it, a child or a teacher? And should it work offline? '
  + 'I would cut the quiz and build the three facts!';

function stubNear({ drafts = [base, simpler], stream = true } = {}) {
  const seen = { think: [], intent: 0, draft: [], models: new Set() };
  const near = { seen, detachReport: (a) => ({ att: a, report: null }), fetchPricing: async () => ({ models: {} }), fetchReport: async () => null,
    fetchAttestation: async () => null, verifyAttestation: () => ({ ok: false, why: 'stub' }),
    chat: async ({ model, messages }) => {
      seen.models.add(model);
      if (String(messages[0].content).startsWith(THINK_SYSTEM)) { seen.think.push(messages); return { ok: true, model, usd: 0.001, content: THINKS }; }
      if (String(messages[0].content).startsWith(INTENT_SYSTEM)) {
        seen.intent++;
        return { ok: true, model, usd: 0.002, content: JSON.stringify(/Upread/.test(messages.at(-1).content)
          ? { intent: 'revision', product: 'upread', kind: 'design-pass' } : { intent: 'new' }) };
      }
      seen.draft.push(messages);
      const d = /Upread/.test(messages[1].content) ? revised : drafts[Math.min(seen.draft.length - 1, drafts.length - 1)];
      const content = JSON.stringify(d);
      return { ok: true, model, usd: 0.01, content, id: `c-${seen.draft.length}`, request_sha256: sha('q'), response_sha256: sha(content) };
    } };
  if (stream) {
    near.chatStream = async ({ model, messages, onText }) => {
      seen.models.add(model); seen.think.push(messages); seen.streamed = true;
      for (const piece of THINKS.match(/.{1,17}/g)) onText(piece);   // arrives in pieces that cut across sentences
      return { ok: true, model, usd: 0.001, content: THINKS };
    };
  }
  return near;
}
async function setup({ exposed = true, near = stubNear(), cap = 5, handover = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-talk-test-'));
  const data = join(dir, 'data'), state = join(dir, 'state'); mkdirSync(data, { recursive: true }); mkdirSync(state, { recursive: true });
  const tc = makeTestCouncil();
  writeFileSync(join(data, 'council.json'), JSON.stringify(tc.council));
  // a record where Upread is an ordinary product with builds; the committed record hands Upread over to Upread Mini (tested apart)
  const committed = JSON.parse(readFileSync(join(root, 'data/products.json'), 'utf8'));
  const upread = { ...committed.products.find((p) => p.id === 'upread') }; delete upread.successor;
  writeFileSync(join(data, 'products.json'), JSON.stringify(handover ? committed : { v: 1, products: [upread] }));
  cpSync(join(root, 'data/runs'), join(data, 'runs'), { recursive: true });
  cpSync(join(root, 'lessons/lessons.json'), join(dir, 'lessons.json'));
  const b = appConfig();
  const cfg = { ...b, dailyCapUsd: cap, retryMs: 0, mode: 'live', data, state, exposed, rp: { id: null, origin: null }, lineOverrides: { offline: true },
    nearai: { ...b.nearai, briefModel: null },
    files: { council: join(data, 'council.json'), stake: join(data, 'stake.json'), products: join(data, 'products.json'), lessons: join(dir, 'lessons.json'),
      talk: join(data, 'talk.json'), tickets: join(data, 'tickets'), runs: join(data, 'runs'), invites: join(state, 'invites.json') } };
  const live = await makeLive(cfg, { near });
  const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
  const post = (path, body) => live._test.handlers[path](body, req);
  // a streamed turn: what the page would receive, event by event
  const turn = async (body) => {
    const events = []; let head = null;
    const res = { writeHead: (status, h) => { head = { status, type: h['content-type'] }; }, end: () => {},
      write: (chunk) => { for (const l of String(chunk).split('\n')) if (l.startsWith('data: ')) events.push(JSON.parse(l.slice(6))); } };
    const answer = await live._test.handlers['/api/talk/turn'](body, req, res);
    return { answer, head, events, text: events.map((e) => e.t ?? '').join(''), id: events.find((e) => e.conversation_id)?.conversation_id };
  };
  const open = async (member) => {
    // nobody is named: the passkey that signs says who it is
    const o = await post('/api/talk/open/options', {});
    const r = await post('/api/talk/open', { talk_sha256: o[1].talk_sha256, ...tc.authenticators[member].assert(o[1].challenge) });
    assert.equal(r[1].member, member);
    return r[1].session;
  };
  const sendAs = async (member, conversation_id) => {
    // the conversation's own member is asked; `member` here is only whose device answers
    const o = await post('/api/talk/send/options', { conversation_id });
    return post('/api/talk/send', { conversation_id, ...tc.authenticators[member].assert(o[1].challenge) });
  };
  const tickets = () => (existsSync(join(data, 'tickets')) ? readdirSync(join(data, 'tickets')) : []);
  return { dir, cfg, tc, near, live, post, turn, open, sendAs, tickets, data, state, done: () => rmSync(dir, { recursive: true, force: true }) };
}
const IDEA = 'I want a site about tide pools with facts and a quiz for my class.';

test('1. a thinking turn is a conversation, streamed: it pushes back, asks at most two questions, and nothing is a brief yet', async () => {
  const s = await setup();
  try {
    const refused = await s.turn({ text: IDEA });
    assert.equal(refused.answer[0], 403, 'reachable from outside, a guest cannot talk'); assert.equal(s.near.seen.think.length, 0);
    const session = await s.open('jj');
    const t = await s.turn({ session, text: IDEA });
    assert.equal(t.answer, undefined, 'the handler streamed its own answer');
    assert.equal(t.head.type, 'text/event-stream');
    assert.ok(t.events.filter((e) => e.t).length >= 3, 'the text arrives in several pieces');
    assert.equal(t.text, 'That is two products. Which one matters first? Who reads it, a child or a teacher? '
      + 'I would cut the quiz and build the three facts.', 'a third question is dropped, and no exclamation mark gets through');
    assert.equal((t.text.match(/\?/g) || []).length, MAX_QUESTIONS);
    assert.equal(t.events.at(-1).done, true);
    const sys = s.near.seen.think[0][0].content;
    assert.match(sys, /Push back when the idea is vague, too big/); assert.match(sys, /Ask at most 2 questions in a turn/);
    assert.match(sys, /Do not write the brief/); assert.match(sys, /- upread/, 'the record is the context');
    assert.match(sys, /Rules learned from earlier builds/);
    assert.deepEqual(s.tickets(), [], 'no ticket'); assert.equal(s.near.seen.draft.length, 0, 'no drafting call');
    assert.equal(snapshot(s.cfg)['api/tickets.json'].tickets.length, 0, 'nothing waits for the council');
    const again = await s.turn({ session, conversation_id: t.id, text: 'For a child. Offline is fine.' });
    assert.deepEqual(s.near.seen.think[1].map((m) => m.role), ['system', 'user', 'assistant', 'user'], 'the next turn carries the conversation');
    assert.equal(again.id, t.id);
    const other = await s.open('michael');
    assert.equal((await s.turn({ session: other, conversation_id: t.id, text: 'mine now' })).answer[0], 409, 'a conversation belongs to its member');
  } finally { s.done(); }
});

test('2. "ready" drafts the brief from the conversation; each further instruction makes a new version with its changes shown', async () => {
  const s = await setup();
  try {
    const session = await s.open('jj');
    assert.equal((await s.turn({ session, text: 'ready' })).answer[0], 400, 'nothing to draft before an idea');
    const t = await s.turn({ session, text: IDEA });
    const ready = await s.turn({ session, conversation_id: t.id, text: 'Ready.' });
    assert.deepEqual(ready.answer, [200, { draft: true, conversation_id: t.id }], 'saying it is ready is not a thinking turn');
    const d1 = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'Ready.' });
    assert.equal(d1[0], 200, JSON.stringify(d1[1])); assert.equal(d1[1].version, 1);
    assert.deepEqual(d1[1].changes, ['First draft.']);
    assert.equal(d1[1].reply, 'A new product, Tide pool facts page. I drafted a brief from your idea.');
    const b = d1[1].brief;
    assert.equal(b.title, 'Tide pool facts page'); assert.match(b.goal, /for a child/); assert.equal(b.green.length, 2); assert.equal(b.budget.usd, 1);
    const asked = s.near.seen.draft[0];
    assert.match(asked[0].content, /Draft the brief they converged on: what it is, who it is for, the one thing it must do, the checks and the budget/);
    assert.match(asked[1].content, /^Member: I want a site about tide pools[\s\S]*Cambrian: That is two products\.[\s\S]*Member: Ready\.$/, 'the drafter reads the conversation');
    assert.deepEqual(s.tickets(), [], 'a draft is not yet in Approvals');
    // a further instruction is a new version, not a thinking turn
    const more = await s.turn({ session, conversation_id: t.id, text: 'simpler, drop the login' });
    assert.equal(more.answer[1].draft, true);
    const d2 = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'simpler, drop the login' });
    assert.equal(d2[1].version, 2);
    assert.deepEqual(d2[1].changes, ['Title: “Tide pool facts page” became “Tide pool facts, one page”.', 'Check dropped: there is a login page.',
      'Now out of scope: a login.']);
    assert.equal(d2[1].reply, `Draft 2. ${d2[1].changes.join(' ')}`);
    assert.notEqual(d2[1].ticket_sha256, d1[1].ticket_sha256);
    assert.equal(s.near.seen.think.length, 1, 'only the first message was a thinking turn');
  } finally { s.done(); }
  assert.equal(isReady('ok, draft it'), true); assert.equal(isReady("it's ready"), true); assert.equal(isReady('Draft the brief'), true);
  assert.equal(isReady('I am not ready to cut the quiz, it is the whole point of the idea'), false);
  assert.deepEqual(briefChanges(base, base), ['Nothing changed in the brief.']);
  const g = sentenceGate(1); assert.equal(g.push('One? Two? Thr') + g.push('ee.') + g.end(), 'One? Three.'); assert.equal(g.dropped, 1);
});

test('3. "Send to council" puts that exact ticket in Approvals, and every signature covers the conversation that shaped it', async () => {
  const s = await setup();
  try {
    const session = await s.open('jj');
    const t = await s.turn({ session, text: IDEA });
    const d1 = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'ready' });
    const d2 = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'simpler, drop the login' });
    assert.equal((await s.sendAs('michael', t.id))[0], 403, 'another member cannot send it');
    const sent = await s.sendAs('jj', t.id);
    assert.equal(sent[0], 200, JSON.stringify(sent[1]));
    assert.equal(sent[1].ticket_sha256, d2[1].ticket_sha256, 'the latest draft, byte for byte');
    const entry = JSON.parse(readFileSync(join(s.data, 'tickets', `${sent[1].ticket_id}.json`), 'utf8'));
    assert.deepEqual(entry.ticket, d2[1].brief); assert.equal(ticketHash(entry.ticket), d2[1].ticket_sha256);
    assert.equal(entry.conversation.draft, 2); assert.notEqual(d1[1].brief.conversation.sha256, entry.ticket.conversation.sha256);
    // the conversation is kept with the ticket and hashes to what the ticket names
    assert.equal(conversationHash(entry.conversation.messages), entry.ticket.conversation.sha256);
    assert.equal(entry.ticket.conversation.turns, entry.conversation.messages.length);
    assert.equal(entry.conversation.messages.at(-1).text, 'simpler, drop the login', 'up to the instruction that made this draft');
    const listed = snapshot(s.cfg)['api/tickets.json'].tickets.find((x) => x.ticket.id === entry.ticket.id);
    assert.equal(listed.status, 'awaiting-approval');
    // the sender signed the conversation's hash; that is not an approval
    assert.equal(verifyMemberSignature({ purpose: 'idea', subjectHash: entry.ticket.conversation.sha256, approval: entry.proposed_by.approval,
      council: s.tc.council }).ok, true);
    assert.equal(entry.proposed_by.approval.idea_sha256, entry.ticket.conversation.sha256);
    assert.deepEqual(entry.approvals, []);
    // two approvals release it; change one word of the conversation and its hash, and they no longer count
    const approvals = [s.tc.sign('clemens', entry.ticket), s.tc.sign('michael', entry.ticket)];
    assert.equal(verifyRelease(entry.ticket, approvals, s.tc.council).ok, true);
    const altered = entry.conversation.messages.map((m, i) => (i === 0 ? { ...m, text: `${m.text} And a shop.` } : m));
    const forged = { ...entry.ticket, conversation: { ...entry.ticket.conversation, sha256: conversationHash(altered) } };
    assert.deepEqual(verifyRelease(forged, approvals, s.tc.council).valid, [], 'a ticket naming another conversation is another ticket');
    assert.equal((await s.sendAs('jj', t.id))[0], 409, 'it goes to the council once');
    assert.equal((await s.turn({ session, conversation_id: t.id, text: 'one more thing' })).answer[0], 409);
    assert.equal(JSON.parse(readFileSync(s.cfg.files.talk, 'utf8')).conversations[0].messages.at(-1).brief.id, entry.ticket.id);
    assert.equal(ideaChallenge(entry.ticket.conversation.sha256).length > 20, true);
  } finally { s.done(); }
});

test('4. a draft that breaks an accepted lesson is shown with the rule, inline, and cannot go to the council', async () => {
  const money = { ...base, title: 'Tide pool facts for $8' };
  const s = await setup({ near: stubNear({ drafts: [money, money, base] }) });
  try {
    const session = await s.open('jj');
    const t = await s.turn({ session, text: IDEA });
    const d = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'ready' });
    assert.equal(d[0], 200); assert.equal(d[1].blocked, true); assert.equal(d[1].brief, undefined);
    assert.deepEqual(d[1].lint.refused.map((x) => x.lesson), ['no-money-in-brief-text']);
    assert.match(d[1].why, /title carries "\$8"/, 'the member sees which rule and why');
    const sent = await s.sendAs('jj', t.id);
    assert.equal(sent[0] === 404 || sent[0] === 422, true, 'nothing to send'); assert.deepEqual(s.tickets(), []);
    const ok = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'leave the price out of the title' });
    assert.equal(ok[1].version, 1); assert.deepEqual(ok[1].lint.refused, []);
    assert.equal(Array.isArray(ok[1].lint.applied), true, 'every draft carries what the lessons changed in it');
    assert.equal((await s.sendAs('jj', t.id))[0], 200);
  } finally { s.done(); }
});

test('5. a revision uses the same loop and starts from the product\'s last build', async () => {
  const s = await setup();
  try {
    const session = await s.open('jj');
    const t = await s.turn({ session, text: 'Upread feels cramped on a phone. The text needs more room between lines.' });
    const d = await s.post('/api/talk/draft', { session, conversation_id: t.id, text: 'draft it' });
    assert.equal(d[0], 200, JSON.stringify(d[1]));
    assert.equal(d[1].reply, 'A design pass on Upread. I drafted a revision brief from your notes.');
    const b = d[1].brief;
    assert.equal(b.product, 'upread'); assert.equal(b.revision.kind, 'design-pass'); assert.equal(b.revision.by, 'jj');
    const last = readdirSync(join(s.data, 'runs')).map((id) => JSON.parse(readFileSync(join(s.data, 'runs', id, 'run.json'), 'utf8')))
      .filter((r) => /^green/.test(r.state)).sort((x, y) => String(x.finished).localeCompare(String(y.finished))).at(-1);
    assert.equal(b.revision.of, last.ticket.id, 'the product\'s last passing build');
    assert.match(b.conversation.sha256, /^[0-9a-f]{64}$/);
    const sent = await s.sendAs('jj', t.id); assert.equal(sent[0], 200);
  } finally { s.done(); }
  const local = await setup({ exposed: false });
  try {
    const t = await local.turn({ text: 'Upread feels cramped on a phone. The text needs more room between lines.' });
    assert.equal(t.head.status, 200, 'on a machine that is not reachable from outside, a local guest can think aloud');
    const d = await local.post('/api/talk/draft', { conversation_id: t.id, text: 'draft it' });
    assert.equal(d[0], 403, 'but only a member revises a product');
  } finally { local.done(); }
});

test('6. the same caps hold, and thinking turns run on the cheap model', async () => {
  const s = await setup();
  try {
    const session = await s.open('jj');
    const t = await s.turn({ session, text: IDEA });
    assert.deepEqual([...s.near.seen.models], [BRIEF_MODEL], 'the brief model, not the build model');
    assert.equal(s.near.seen.streamed, true);
    assert.equal(JSON.parse(readFileSync(join(s.state, 'brief-spend.json'), 'utf8')).usd, 0.001, 'a thinking turn is counted in the day\'s spend');
    assert.equal(t.events.at(-1).total_usd, 0.001);
    assert.equal((await s.turn({ session, conversation_id: t.id, text: 'x'.repeat(8001) })).answer[0], 400);
  } finally { s.done(); }
  const spent = await setup({ cap: 0.001 });
  try {
    const session = await spent.open('jj');
    await spent.turn({ session, text: IDEA });
    const before = spent.near.seen.think.length;
    const t = await spent.turn({ session, text: 'another idea, about kelp forests' });
    assert.equal(t.answer[0], 402); assert.match(t.answer[1].why, /Today's cap/); assert.equal(spent.near.seen.think.length, before, 'no model call past the cap');
    const d = await spent.post('/api/talk/draft', { session, conversation_id: undefined, text: 'a page that lists three facts about kelp' });
    assert.equal(d[0], 402);
  } finally { spent.done(); }
  const plain = await setup({ near: stubNear({ stream: false }) });
  try {
    const session = await plain.open('jj');
    const t = await plain.turn({ session, text: IDEA });
    assert.match(t.text, /^That is two products\./, 'a client that cannot stream still answers, in one piece');
  } finally { plain.done(); }
});

test('an overloaded brief model: the same model is asked once more, then the next open model, and the brief names the one that wrote it', async () => {
  const near = stubNear({ stream: false }); const inner = near.chat; const asked = [];
  // the first answer is 429, the second 502: both mean "ask again, then ask the next model"
  near.chat = async (a) => { asked.push(a.model);
    return a.model === BRIEF_MODEL ? { ok: false, status: asked.length === 1 ? 429 : 502, usd: null, error: 'overloaded' } : inner(a); };
  const s = await setup({ near });
  try {
    const session = await s.open('jj');
    const t1 = await s.turn({ session, text: IDEA });
    assert.match(t1.text, /^That is two products\./, 'the conversation went on');
    assert.deepEqual(asked, [BRIEF_MODEL, BRIEF_MODEL, 'Qwen/Qwen3.6-35B-A3B-FP8']);
    const before = asked.length;
    const d = await s.post('/api/talk/draft', { session, conversation_id: t1.id, text: 'ready' });
    assert.equal(d[0], 200, JSON.stringify(d[1]));
    assert.equal(d[1].brief.drafted.model, 'Qwen/Qwen3.6-35B-A3B-FP8', 'the brief names the model that answered, not the one that was overloaded');
    assert.equal(asked.slice(before).includes(BRIEF_MODEL), false, 'a model that just failed is not asked again for a while');
  } finally { s.done(); }
});

test('a brief model that does not answer at all is given up on after the time limit, and the next model is asked', async () => {
  const near = stubNear({ stream: false }); const inner = near.chat; let aborted = false;
  near.chat = (a) => (a.model === BRIEF_MODEL ? new Promise(() => { a.signal.addEventListener('abort', () => { aborted = true; }); }) : inner(a));
  const s = await setup({ near }); s.cfg.modelWaitMs = 30;
  try {
    const live = await makeLive({ ...s.cfg, modelWaitMs: 30 }, { near });
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const d = await live._test.handlers['/api/talk/draft']({ text: 'a page that lists three facts about tide pools for a child' }, req);
    assert.equal(d[0], 403, 'exposed: a guest is still refused first');
  } finally { s.done(); }
  const local = await setup({ near, exposed: false });
  try {
    const live = await makeLive({ ...local.cfg, modelWaitMs: 30 }, { near });
    const req = { socket: { remoteAddress: '127.0.0.1' }, headers: {} };
    const d = await live._test.handlers['/api/talk/draft']({ text: 'a page that lists three facts about tide pools for a child' }, req);
    assert.equal(d[0], 200, JSON.stringify(d[1])); assert.equal(d[1].version, 1);
    assert.equal(d[1].brief.drafted.model, 'Qwen/Qwen3.6-35B-A3B-FP8');
    assert.equal(aborted, true, 'the call that hung was aborted, not left running');
  } finally { local.done(); }
});

test('Upread is built fresh here as Upread Mini: a message about Upread drafts the first build of upread-mini, with no parent, linted by the lessons', async () => {
  const s = await setup({ handover: true });
  try {
    const record = snapshot(s.cfg)['api/products.json'].products;
    const mini = record.find((p) => p.id === 'upread-mini');
    assert.equal(mini.runs.length, 0, 'no build of its own yet');
    assert.deepEqual(mini.history.map((r) => r.origin), ['private-line', 'private-line', 'private-line'], 'the imported Upread builds are shown as its history');
    assert.equal(mini.live_url, null);
    const session = await s.open('jj');
    const t1 = await s.turn({ session, text: 'Build Upread: a reader that shows an article one word at a time.' });
    const d = await s.post('/api/talk/draft', { session, conversation_id: t1.id, text: 'draft it' });
    assert.equal(d[0], 200, JSON.stringify(d[1]));
    const b = d[1].brief;
    assert.equal(b.product, 'upread-mini', 'on the new product, whatever the model wrote');
    assert.equal(b.revision, undefined, 'no parent: it does not continue the imported builds');
    assert.match(s.near.seen.draft.at(-1)[0].content, /first build of the product "upread-mini"/);
    assert.ok(d[1].lint.applied.length >= 1, 'the lessons carried over from the Upread builds were applied to the draft');
    assert.deepEqual(d[1].lint.refused, []);
  } finally { s.done(); }
});

test('at "Send to council" the latest draft is checked again against every lesson accepted since: one that adds to it changes the brief, one that refuses it stops it', async () => {
  const { acceptLesson } = await import('../../lessons/store.mjs');
  const { RUNTIME_LINE, lintBrief, parseLessons } = await import('../../lessons/lessons.mjs');
  const lesson = (fix) => ({ id: `no-build-time-fetch-${fix}`, rule: 'Products never fetch data at build time; live data is fetched in the browser at runtime.',
    failure: 'RED: the build tried to reach another host and has no network.', applies_to: ['brief', 'ticket'], check: 'no_build_time_fetch', fix,
    from_run: 'near-price-1', from_product: 'near-price' });
  const s = await setup();
  try {
    const session = await s.open('jj');
    const t1 = await s.turn({ session, text: IDEA });
    const d = await s.post('/api/talk/draft', { session, conversation_id: t1.id, text: 'ready' });
    assert.doesNotMatch(d[1].brief.task, /at runtime/, 'drafted before the lesson existed');
    // a member accepts a new lesson while the draft waits
    acceptLesson(s.cfg.files.lessons, lesson('append'), { member: 'michael', approval: { signature: 'x' }, at: '2026-11-14T06:00:00.000Z' });
    const sent = await s.sendAs('jj', t1.id);
    assert.equal(sent[0], 200, JSON.stringify(sent[1]));
    assert.deepEqual(sent[1].relinted.map((x) => x.lesson), ['no-build-time-fetch-append'], 'the response says which lesson changed the brief');
    assert.notEqual(sent[1].ticket_sha256, d[1].ticket_sha256, 'so the council signs the brief as it is now');
    const entry = JSON.parse(readFileSync(join(s.data, 'tickets', `${sent[1].ticket_id}.json`), 'utf8'));
    assert.ok(entry.ticket.task.endsWith(RUNTIME_LINE));
    assert.ok(entry.lint.applied.some((x) => x.lesson === 'no-build-time-fetch-append'), 'the brief names the new lesson, and so will its receipt');
    assert.equal(entry.ticket.conversation.sha256, d[1].brief.conversation.sha256, 'the conversation it came from is unchanged');
    assert.equal(ticketHash(entry.ticket), sent[1].ticket_sha256);
  } finally { s.done(); }
  // the planned failure, as an idea: with the lesson accepted as "refuse", such a brief no longer gets to the council
  const lessons = [{ ...lesson('refuse'), applies_to: ['brief', 'ticket'] }];
  const asked = { ...base, goal: 'A page that shows the current NEAR price, fetched live when the page is built.' };
  const r = lintBrief(asked, { lessons, products: [{ id: 'tides' }] });
  assert.deepEqual(r.refused.map((x) => x.lesson), ['no-build-time-fetch-refuse']);
  assert.match(r.refused[0].why, /the goal asks for data to be fetched while building/);
  const fine = lintBrief({ ...base, goal: 'A page that shows the current NEAR price, fetched in the browser when the page opens.' }, { lessons, products: [{ id: 'tides' }] });
  assert.deepEqual(fine.refused, []); assert.ok(fine.brief.task.endsWith(RUNTIME_LINE));
  assert.equal(typeof parseLessons, 'function');
});

test('a long message is kept whole: 7,500 characters reach the model, the conversation, the drafter and the brief in full', async () => {
  const long = `A reader for long articles. ${'Every sentence of this pasted note matters to the idea. '.repeat(140)}`.slice(0, 7499) + '§';
  assert.equal(long.length, 7500);
  const s = await setup();
  try {
    const session = await s.open('jj');
    const t1 = await s.turn({ session, text: long });
    assert.equal(t1.answer, undefined, JSON.stringify(t1.answer));
    assert.equal(s.near.seen.think[0].at(-1).content, long, 'the thinking model was sent every character');
    const kept = JSON.parse(readFileSync(join(s.state, 'talk', `${t1.id}.json`), 'utf8'));
    assert.equal(kept.messages[0].text, long, 'and the conversation holds it in full');
    const d = await s.post('/api/talk/draft', { session, conversation_id: t1.id, text: 'ready' });
    assert.equal(d[0], 200, JSON.stringify(d[1]));
    assert.ok(s.near.seen.draft[0][1].content.includes(long), 'the drafter read all of it, not a cut');
    const sent = await s.sendAs('jj', t1.id);
    const entry = JSON.parse(readFileSync(join(s.data, 'tickets', `${sent[1].ticket_id}.json`), 'utf8'));
    assert.equal(entry.conversation.messages[0].text, long); assert.equal(entry.idea, long);
    assert.equal(conversationHash(entry.conversation.messages), entry.ticket.conversation.sha256);
    assert.match(readFileSync(join(root, 'web/screens/talk.js'), 'utf8'), /maxlength: '8000'/, 'the box takes as much as the server does');
    const over = await s.turn({ session, text: 'y'.repeat(8001) });
    assert.equal(over.answer[0], 400); assert.match(over.answer[1].why, /under 8000 characters/);
  } finally { s.done(); }
});

test('Talk knows who is writing from the passkey, shows a member their own open conversations, and keeps them across a restart', async () => {
  const s = await setup();
  try {
    const o = await s.post('/api/talk/open/options', {});
    assert.equal(o[1].allowCredentials.length, 3, 'every enrolled passkey is offered; the device answers with its own');
    const jj = await s.open('jj'); const michael = await s.open('michael');
    const t1 = await s.turn({ session: jj, text: IDEA });
    const t2 = await s.turn({ session: jj, text: 'A second idea, about kelp forests and who lives in them.' });
    await s.post('/api/talk/draft', { session: jj, conversation_id: t1.id, text: 'ready' });
    const tm = await s.turn({ session: michael, text: 'An idea of my own, about lighthouses.' });
    const list = await s.post('/api/talk/list', { session: jj });
    assert.equal(list[1].member, 'jj');
    assert.deepEqual(list[1].conversations.map((c) => c.id).sort(), [t1.id, t2.id].sort(), 'her own, and nobody else\'s');
    assert.equal(list[1].conversations.find((c) => c.id === t1.id).drafts, 1);
    assert.equal((await s.post('/api/talk/get', { session: jj, conversation_id: tm.id }))[0], 404, 'another member\'s conversation cannot be opened');
    assert.equal((await s.post('/api/talk/list', {}))[0], 403, 'and nothing is listed without a passkey');
    // the app restarts: same state on disk, a new process
    const again = await makeLive(s.cfg, { near: s.near });
    const post2 = (path, body) => again._test.handlers[path](body, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
    const after = await post2('/api/talk/list', { session: jj });
    assert.equal(after[0], 200, 'still signed in'); assert.equal(after[1].conversations.length, 2);
    const got = await post2('/api/talk/get', { session: jj, conversation_id: t1.id });
    assert.equal(got[1].messages[0].text, IDEA); assert.equal(got[1].draft.version, 1); assert.equal(got[1].draft.brief.title, 'Tide pool facts page');
    // sending needs nobody named either: the conversation's member signs; another member's passkey is refused
    const wrong = await s.sendAs('michael', t1.id);
    assert.equal(wrong[0], 403);
    const sent = await s.sendAs('jj', t1.id);
    assert.equal(sent[0], 200, JSON.stringify(sent[1])); assert.equal(sent[1].proposed_by, 'jj');
    assert.deepEqual((await s.post('/api/talk/list', { session: jj }))[1].conversations.map((c) => c.id), [t2.id], 'a sent conversation is no longer open');
  } finally { s.done(); }
});
