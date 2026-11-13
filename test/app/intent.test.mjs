// Talk to Cambrian has no modes. One message is classified by the brief model with the record as context:
// a new product, a revision of a product on record, or a question. The model proposes and the code decides:
// a revision of a product that is not on record gets a question back, and a guest is refused.
// The model client is a stand-in: no call leaves the machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, cpSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../../app/config.mjs';
import { makeLive } from '../../app/live.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { approvalSubject, ticketHash, verifyRelease } from '../../approvals/release.mjs';
import { classifyIntent, INTENT_SYSTEM, plainLine, recordContext, replyLine } from '../../tickets/intent.mjs';
import { readAttachments } from '../../tickets/attachments.mjs';
import { parseTicket } from '../../tickets/ticket.mjs';
import { buildReceipt } from '../../receipts/receipt.mjs';
import { ticketText, HOUSE_KIT, houseKitHash } from '../../line/run.mjs';
import { revisionLine } from '../../web/lib/mini.js';

const root = appConfig().root;
const sha = (x) => createHash('sha256').update(x).digest('hex');
const PARENT = 'upread-v1-open-pdf';
const draft = { product: 'something-else', title: 'Upread, calmer reading view', goal: 'The reader looks calmer.',
  task: 'Change the reading view of the existing page: larger line height and a narrower column. Keep opening a PDF working. Out of scope: new features.',
  out_of_scope: ['new features'], budget: { usd: 1, calls: 20, minutes: 10 },
  green: [{ id: 'calmer', kind: 'file', path: 'index.html', contains: ['line-height'], name: 'the text has more room between lines' }] };
const fresh = { ...draft, product: 'tides', title: 'Tide pool facts page', goal: 'A page with three tide pool facts.',
  task: 'Write index.html with a heading and exactly three facts about tide pools in a list. No scripts, no external files. Out of scope: styling.',
  green: [{ id: 'page', kind: 'file', path: 'index.html', contains: ['tide'], name: 'the page exists' }] };

// what the stand-in model says each message is; everything else it is asked is a drafting call
const SAYS = {
  'a page that lists three facts about tide pools': { intent: 'new' },
  'Upread feels cramped. Give the text more room between lines.': { intent: 'revision', product: 'Upread', kind: 'design-pass' },
  'What did the Upread builds cost?': { intent: 'question', answer: 'The three Upread builds cost $5.36 in total!' },
  'Make Tidebook darker.': { intent: 'revision', product: 'Tidebook', kind: 'design-pass' },
  'hmm': { intent: 'unclear', ask: 'Is this a new product, a change, or a question?' },
};
function stubNear() {
  const seen = { intent: 0, draft: 0, context: null, drafting: null };
  return { seen, detachReport: (a) => ({ att: a, report: null }), fetchPricing: async () => ({ models: {} }), fetchReport: async () => null,
    fetchAttestation: async () => null, verifyAttestation: () => ({ ok: false, why: 'stub' }),
    chat: async ({ model, messages }) => {
      const said = messages.at(-1).content;
      if (String(messages[0].content).startsWith(INTENT_SYSTEM)) {
        seen.intent++; seen.context = messages[0].content;
        return { ok: true, model, usd: 0.002, content: JSON.stringify(SAYS[said] ?? { intent: 'unclear' }) };
      }
      seen.draft++; seen.drafting = messages[0].content;
      const content = JSON.stringify(/Upread/.test(messages[1].content) ? draft : fresh);
      return { ok: true, model, usd: 0.01, content, id: `c-${seen.draft}`, request_sha256: sha('q'), response_sha256: sha(content) };
    } };
}
async function setup({ exposed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-intent-test-'));
  const data = join(dir, 'data'), state = join(dir, 'state'); mkdirSync(data, { recursive: true }); mkdirSync(state, { recursive: true });
  const tc = makeTestCouncil(); const near = stubNear();
  writeFileSync(join(data, 'council.json'), JSON.stringify(tc.council));
  cpSync(join(root, 'data/products.json'), join(data, 'products.json'));
  cpSync(join(root, 'data/runs'), join(data, 'runs'), { recursive: true });
  cpSync(join(root, 'lessons/lessons.json'), join(dir, 'lessons.json'));
  const base = appConfig();
  const cfg = { ...base, dailyCapUsd: 5, mode: 'live', data, state, exposed, rp: { id: null, origin: null }, lineOverrides: { offline: true },
    nearai: { ...base.nearai, briefModel: null },
    files: { council: join(data, 'council.json'), stake: join(data, 'stake.json'), products: join(data, 'products.json'), lessons: join(dir, 'lessons.json'),
      talk: join(data, 'talk.json'), tickets: join(data, 'tickets'), runs: join(data, 'runs'), invites: join(state, 'invites.json') } };
  const live = await makeLive(cfg, { near });
  const post = (path, body) => live._test.handlers[path](body, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  const say = (member, idea, extra = {}, shas = []) => post('/api/ideas', { idea, ...tc.signIdea(member, idea, undefined, shas), ...extra });
  return { dir, cfg, tc, near, post, say, data, tickets: () => (existsSync(join(data, 'tickets')) ? readdirSync(join(data, 'tickets')) : []) };
}
const done = (s) => rmSync(s.dir, { recursive: true, force: true });
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('not a real image, only its first bytes')]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-ish')]);

test('a new idea is classified as a new product and gets a brief and one plain line', async () => {
  const s = await setup();
  try {
    const r = await s.say('jj', 'a page that lists three facts about tide pools');
    assert.equal(r[0], 200, JSON.stringify(r[1]));
    assert.equal(r[1].intent, 'new'); assert.equal(r[1].brief.product, 'tides'); assert.equal(r[1].brief.revision, undefined);
    assert.equal(r[1].reply, 'A new product, Tide pool facts page. I drafted a brief from your idea.');
    assert.match(s.near.seen.context, /- upread.*Builds: .*upread-v1-open-pdf ".*" passed/s, 'the record is the context: products with their builds');
    assert.equal(s.near.seen.intent, 1); assert.equal(s.near.seen.draft, 1);
    assert.equal(r[1].usd, 0.012, 'the intent call and the draft are one message\'s cost');
  } finally { done(s); }
});

test('a revision of Upread is classified as a revision: the brief is linked to the product and its build, and the notes become its checks', async () => {
  const s = await setup();
  try {
    const note = 'Upread feels cramped. Give the text more room between lines.';
    const r = await s.say('jj', note);
    assert.equal(r[0], 200, JSON.stringify(r[1]));
    assert.equal(r[1].intent, 'revision');
    assert.equal(r[1].reply, 'A design pass on Upread. I drafted a revision brief from your notes.');
    const b = r[1].brief;
    assert.equal(b.product, 'upread', 'a revision stays on its product, whatever the model wrote');
    assert.equal(b.revision.kind, 'design-pass'); assert.equal(b.revision.by, 'jj');
    assert.match(b.revision.of, /^upread-v1-/, 'linked to a build of that product');
    const parent = JSON.parse(readFileSync(join(s.data, 'runs', b.revision.of, 'run.json'), 'utf8'));
    assert.match(parent.state, /^green/, 'the latest passing build is the parent');
    assert.match(s.near.seen.drafting, /Each note in the member's message becomes one acceptance check/);
    assert.match(s.near.seen.drafting, /The house kit applies to every build/);
    assert.equal(b.green[0].name, 'the text has more room between lines');
    // the link is under the council's signatures: change it and the signatures stop counting
    const approvals = [s.tc.sign('clemens', b), s.tc.sign('michael', b)];
    assert.equal(verifyRelease(b, approvals, s.tc.council).ok, true, 'a revision is signed 2 of 3 like any brief');
    assert.equal(verifyRelease({ ...b, revision: { ...b.revision, by: 'clemens' } }, approvals, s.tc.council).ok, false);
    assert.equal(JSON.parse(readFileSync(s.cfg.files.talk, 'utf8')).conversations[0].messages[1].text, r[1].reply);
  } finally { done(s); }
});

test('a question is answered in one plain line: no brief, no ticket, nothing to sign', async () => {
  const s = await setup();
  try {
    const before = s.tickets();
    const r = await s.say('michael', 'What did the Upread builds cost?');
    assert.equal(r[0], 200); assert.equal(r[1].intent, 'question'); assert.equal(r[1].brief, undefined);
    assert.equal(r[1].reply, 'The three Upread builds cost $5.36 in total.', 'no exclamation mark reaches the member');
    assert.deepEqual(s.tickets(), before); assert.equal(s.near.seen.draft, 0);
  } finally { done(s); }
});

test('a revision of a product that does not exist gets one question back, and an unclear message too', async () => {
  const s = await setup();
  try {
    const r = await s.say('jj', 'Make Tidebook darker.');
    assert.equal(r[0], 200); assert.equal(r[1].intent, 'ask'); assert.equal(r[1].brief, undefined);
    assert.equal(r[1].reply, 'I have no product called Tidebook on record. Did you mean Upread, or is this a new product?');
    const u = await s.say('jj', 'hmm');
    assert.equal(u[1].intent, 'ask'); assert.equal(u[1].reply, 'Is this a new product, a change, or a question?');
    assert.equal(s.near.seen.draft, 0, 'no brief was drafted for either');
  } finally { done(s); }
});

test('a guest is refused: no signature, no model call; and without a passkey nobody revises a product or attaches an image', async () => {
  const s = await setup();
  try {
    const r = await s.post('/api/ideas', { idea: 'Upread feels cramped. Give the text more room between lines.' });
    assert.equal(r[0], 403); assert.match(r[1].why, /only an enrolled council member/);
    assert.equal(s.near.seen.intent, 0, 'the model was never asked');
  } finally { done(s); }
  const local = await setup({ exposed: false });
  try {
    const r = await local.post('/api/ideas', { idea: 'Upread feels cramped. Give the text more room between lines.' });
    assert.equal(r[0], 403); assert.match(r[1].why, /Only an enrolled member can revise a product/);
    const img = await local.post('/api/ideas', { idea: 'a page that lists three facts about tide pools', attachments: [{ data: PNG.toString('base64') }] });
    assert.equal(img[0], 403); assert.match(img[1].why, /Only an enrolled member can attach images/);
  } finally { done(local); }
});

test('images: at most 3, PNG or JPEG, under 5 MB, signed with the message, kept beside the brief and named in it by hash', async () => {
  assert.equal(readAttachments([{ data: 'R0lGODlhAQABAAAAACw=' }]).why, 'image 1 is not a PNG or a JPEG');
  assert.equal(readAttachments(Array(4).fill({ data: PNG.toString('base64') })).why, 'at most 3 images');
  const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024)]);
  assert.match(readAttachments([{ data: big.toString('base64') }]).why, /the limit is under 5 MB/);
  assert.deepEqual(readAttachments(undefined), { ok: true, files: [] });
  const s = await setup();
  try {
    const note = 'Upread feels cramped. Give the text more room between lines.';
    const shas = [sha(PNG), sha(JPG)]; const attachments = [{ data: PNG.toString('base64') }, { data: JPG.toString('base64') }];
    const unsigned = await s.say('jj', note, { attachments });
    assert.equal(unsigned[0], 403, 'a signature over the text alone does not cover the images');
    const r = await s.say('jj', note, { attachments }, shas);
    assert.equal(r[0], 200, JSON.stringify(r[1]));
    assert.deepEqual(r[1].brief.revision.attachments, [{ type: 'png', bytes: PNG.length, sha256: shas[0] }, { type: 'jpeg', bytes: JPG.length, sha256: shas[1] }]);
    const id = r[1].brief.id;
    assert.deepEqual(readFileSync(join(s.data, 'tickets', `${id}.attach-1.png`)), PNG);
    assert.deepEqual(readFileSync(join(s.data, 'tickets', `${id}.attach-2.jpg`)), JPG);
    assert.doesNotMatch(s.near.seen.drafting + s.near.seen.context, new RegExp(PNG.toString('base64').slice(0, 24)), 'no image byte goes to the model');
    const gif = await s.say('michael', note, { attachments: [{ data: 'R0lGODlhAQABAAAAACw=' }] });
    assert.equal(gif[0], 400);
  } finally { done(s); }
});

test('a taste note is signed with the brief: it cannot be added, changed or removed afterwards', () => {
  const tc = makeTestCouncil();
  const t = parseTicket(readFileSync(join(root, 'test/line/fixtures/tickets/facts-page-1.json')));
  const noted = tc.sign('jj', t, undefined, 'Keep it quiet. No animation.');
  assert.equal(noted.taste_note, 'Keep it quiet. No animation.');
  assert.notEqual(approvalSubject(ticketHash(t), noted.taste_note), ticketHash(t));
  const plain = tc.sign('clemens', t);
  assert.equal(plain.taste_note, undefined);
  assert.equal(verifyRelease(t, [noted, plain], tc.council).ok, true);
  assert.deepEqual(verifyRelease(t, [{ ...noted, taste_note: 'Add animation.' }, plain], tc.council).valid, ['clemens']);
  const stripped = { ...noted }; delete stripped.taste_note;
  assert.deepEqual(verifyRelease(t, [stripped, plain], tc.council).valid, ['clemens']);
  assert.deepEqual(verifyRelease(t, [noted, { ...plain, taste_note: 'I never said this.' }], tc.council).valid, ['jj']);
  const receipt = buildReceipt({ ticket: { id: t.id }, finished: 'x', approvals: [noted, plain], attempts: [] });
  assert.equal(receipt.approvals.signatures[0].taste_note, 'Keep it quiet. No animation.', 'the receipt carries the note with its signature');
});

test('the house kit is in every build: the builder is told to read it, and the files are the ones hashed on the record', () => {
  const t = parseTicket(readFileSync(join(root, 'test/line/fixtures/tickets/facts-page-1.json')));
  assert.match(ticketText(t, null), /## The house kit\n\nRead `\.oc\/house\/HOUSE\.md` before you write anything/);
  assert.equal(existsSync(join(HOUSE_KIT, 'HOUSE.md')), true);
  assert.equal(readFileSync(join(HOUSE_KIT, 'tokens.css'), 'utf8'), readFileSync(join(root, 'web/tokens.css'), 'utf8'), 'the kit carries this app\'s own tokens');
  assert.match(houseKitHash(), /^[0-9a-f]{64}$/);
  const rev = parseTicket({ ...t, id: 'facts-page-2', branch: undefined, revision: { of: t.id, kind: 'design-pass', by: 'jj', product: t.product } });
  assert.match(ticketText(rev, null), /## This is a revision \(design pass\)\n\nThe files here are the build facts-page-1\./);
  assert.throws(() => parseTicket({ ...t, revision: { of: t.id, kind: 'rewrite', by: 'jj', product: t.product } }), /revision\.kind/);
  assert.throws(() => parseTicket({ ...t, revision: { of: t.id, kind: 'fix', by: 'jj', product: 'another' } }), /must be the ticket's own product/);
});

test('what a revision build says: "Design pass by JJ", v1 to v2, both previews', () => {
  const council = { members: [{ id: 'jj', name: 'JJ' }] };
  const runs = [{ id: 'a', state: 'green-preview', finished: '2026-11-13T10:00:00Z', preview_url: 'https://example.org/a' },
    { id: 'x', state: 'red', finished: '2026-11-13T11:00:00Z' },
    { id: 'b', state: 'green-preview', finished: '2026-11-13T12:00:00Z', preview_url: 'https://example.org/b', revision: { of: 'a', kind: 'design-pass', by: 'jj' } }];
  assert.deepEqual(revisionLine(runs[2], runs, council), { text: 'Design pass by JJ', versions: 'v1 → v2', previews: ['https://example.org/a', 'https://example.org/b'] });
  assert.equal(revisionLine(runs[0], runs, council), null);
  assert.equal(revisionLine({ id: 'c', state: 'red', revision: { of: 'a', kind: 'fix', by: 'jj' } }, runs, council).versions, 'from v1, not passed yet');
  assert.equal(replyLine({ intent: 'revision', kind: 'fix', productName: 'Upread' }), 'A fix on Upread. I drafted a revision brief from your notes.');
  assert.equal(plainLine('Great idea!!  It ships — soon.'), 'Great idea. It ships, soon.');
  assert.equal(recordContext([], []), 'There are no products yet.');
});

test('the model proposes, the code decides: an answer that is not JSON is a question back, and a silent model is an error', async () => {
  const chat = (content, ok = true) => async () => ({ ok, content, usd: 0.001, model: 'm', why: 'timeout' });
  assert.equal((await classifyIntent('x', { chat: chat('I think this is new') })).intent, 'ask');
  assert.equal((await classifyIntent('x', { chat: chat('', false) })).ok, false);
});
