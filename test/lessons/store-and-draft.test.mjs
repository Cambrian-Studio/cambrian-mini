// The lessons file only grows, and a lesson is drafted only from a RED run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lintBrief } from '../../lessons/lessons.mjs';
import { loadLessons, acceptLesson, recordFired } from '../../lessons/store.mjs';
import { draftLesson, validateModelLesson } from '../../lessons/draft.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const readJson = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const redRun = readJson('data/runs/upread-v1-one-word-at-a-time-reader-for/run.json');
const greenRun = readJson('data/runs/upread-v1-reader-shell/run.json');
const greenTicket = readJson('data/runs/upread-v1-reader-shell/ticket.json');

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'baby-lessons-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'lessons.json');
  writeFileSync(file, readFileSync(join(ROOT, 'lessons/lessons.json')));
  return { dir, file };
}
const acceptance = { member: 'member-a', approval: { member: 'member-a', signature: 'test-only' } };

test('acceptLesson appends, keeps who accepted, and the new lesson fires in a later lintBrief', (t) => {
  const { dir, file } = scratch(t);
  const before = JSON.parse(readFileSync(file, 'utf8'));
  const draft = {
    id: 'no-euro-prices', rule: 'A second money rule, accepted later, runs the same known check.',
    failure: 'A test failure with 3 numbers.', applies_to: ['brief'], check: 'no_money_words', fix: 'refuse',
    from_run: 'some-run', learned: '2026-11-12', status: 'drafted',
  };
  const brief = { ...greenTicket, title: 'Reader for 4 USD' };
  const without = lintBrief(brief, { lessons: loadLessons(file).lessons.filter((l) => l.check !== 'no_money_words') });
  assert.deepEqual(without.refused, []);

  const stored = acceptLesson(file, draft, acceptance);
  assert.equal(stored.accepted_by, 'member-a');
  const after = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(after.lessons.length, 9);
  assert.deepEqual(after.lessons.slice(0, 8), before.lessons, 'earlier lessons are untouched');
  assert.deepEqual(after._meta, before._meta);
  assert.equal(after.lessons[8].acceptance.member, 'member-a');
  assert.deepEqual(after.lessons[8].acceptance.approval, acceptance.approval);
  assert.ok(!('status' in after.lessons[8]));
  assert.deepEqual(readdirSync(dir), ['lessons.json'], 'no temporary file is left behind');

  const loaded = loadLessons(file);
  assert.deepEqual(loaded.problems, []);
  const fired = lintBrief(brief, { lessons: loaded.lessons.filter((l) => l.id === 'no-euro-prices') });
  assert.deepEqual(fired.refused.map((r) => r.lesson), ['no-euro-prices']);
});

test('acceptLesson refuses a duplicate id, a malformed draft and a missing acceptance, and writes nothing', (t) => {
  const { file } = scratch(t);
  const bytes = readFileSync(file, 'utf8');
  const good = { id: 'fresh-lesson', rule: 'A rule long enough to be a sentence.', applies_to: ['brief'], check: null };
  assert.throws(() => acceptLesson(file, { ...good, id: 'write-files-early' }, acceptance), /already exists/);
  assert.throws(() => acceptLesson(file, { ...good, rule: 'short' }, acceptance), /not a valid lesson.*rule must be a sentence/);
  assert.throws(() => acceptLesson(file, { ...good, applies_to: ['nowhere'] }, acceptance), /not a valid lesson/);
  assert.throws(() => acceptLesson(file, good, { member: 'member-a' }), /approval is required/);
  assert.throws(() => acceptLesson(file, good, { approval: {} }), /member is required/);
  assert.equal(readFileSync(file, 'utf8'), bytes);
});

test('recordFired appends to one lesson and changes nothing else', (t) => {
  const { file } = scratch(t);
  const before = JSON.parse(readFileSync(file, 'utf8'));
  recordFired(file, 'write-files-early', { brief: 'brief-1', at: '2026-11-12T10:00:00.000Z', what: 'task ends with the builder line' });
  recordFired(file, 'write-files-early', { run: 'run-2', at: '2026-11-12T11:00:00.000Z', what: 'again' });
  const after = JSON.parse(readFileSync(file, 'utf8'));
  const l = after.lessons.find((x) => x.id === 'write-files-early');
  assert.deepEqual(l.fired, [
    { at: '2026-11-12T10:00:00.000Z', what: 'task ends with the builder line', brief: 'brief-1' },
    { at: '2026-11-12T11:00:00.000Z', what: 'again', run: 'run-2' },
  ]);
  l.fired = [];
  assert.deepEqual(after, before);
  assert.equal(loadLessons(file).lessons.find((x) => x.id === 'write-files-early').fired.length, 2);
  assert.throws(() => recordFired(file, 'no-such-lesson', { run: 'r' }), /no lesson/);
  assert.throws(() => recordFired(file, 'write-files-early', { what: 'nowhere' }), /name the run or the brief/);
});

test('loadLessons reports a missing file instead of throwing', () => {
  const r = loadLessons(join(tmpdir(), 'baby-lessons-test-no-such-file.json'));
  assert.equal(r.lessons.length, 0);
  assert.match(r.error, /cannot read/);
});

test('draftLesson: a GREEN run drafts nothing, with or without a model', async () => {
  let asked = 0;
  const chat = async () => { asked += 1; return { ok: true, content: '{}' }; };
  assert.equal(await draftLesson({ run: greenRun }), null);
  assert.equal(await draftLesson({ run: greenRun, chat }), null);
  assert.equal(asked, 0, 'the model is not asked about a GREEN run');
});

test('draftLesson: the real RED run without a model gives the timeout draft from the record', async () => {
  const d = await draftLesson({ run: redRun });
  assert.equal(d.status, 'drafted');
  assert.equal(d.drafted_by, 'rules');
  assert.equal(d.id, 'timeout-upread-v1-one-word-at-a-time-read');
  assert.equal(d.check, 'scope_named');
  assert.equal(d.from_run, redRun.ticket.id);
  assert.equal(d.learned, '2026-11-09');
  assert.match(d.rule, /smaller ticket/);
  assert.match(d.failure, /RED after 2701 s.*build, test, manifest, extract-fn, no-external/);
  assert.deepEqual(await draftLesson({ run: redRun }), d, 'the same record gives the same draft');
});

const redFixture = (checks, agent = { kind: 'stand-in', exit: 0, seconds: 30, model: 'none' }) => ({
  state: 'red', finished: '2026-11-12T09:00:00.000Z',
  ticket: { id: 'fixture-ticket', product: 'upread', budget: { usd: 1, calls: 10, minutes: 5 } },
  attempts: [{ n: 1, agent, green: false, failing: checks.filter((c) => !c.pass).map((c) => c.id), checks }],
});

test('draftLesson: the fallback names a check that can pass when a check could not', async () => {
  const nx = await draftLesson({ run: redFixture([
    { id: 'install', kind: 'run', pass: true, detail: 'exit 0' },
    { id: 'no-external', kind: 'no_external_hosts', pass: false, detail: '2 external hosts in dist' }]) });
  assert.equal(nx.check, 'checks_can_pass');
  assert.match(nx.rule, /Name a check that can pass/);
  assert.equal(nx.id, 'unpassable-check-fixture-ticket');
  const missing = [{ id: 'page', kind: 'file', pass: false, detail: 'site/index.html does not exist' }];
  const file = await draftLesson({ run: redFixture(missing) });
  assert.equal(file.check, null);
  assert.match(file.rule, /Name a check that can pass/);
  const other = await draftLesson({ run: redFixture([{ id: 'test', kind: 'run', pass: false, detail: 'exit 1, wanted 0' }]) });
  assert.equal(other.id, 'red-fixture-ticket');
  assert.match(other.failure, /failing checks: test/);
  const failed = [{ id: 'test', kind: 'run', pass: false, detail: 'exit 1' }];
  const slow = await draftLesson({ run: redFixture(failed, { exit: 0, seconds: 300 }) });
  assert.equal(slow.check, 'scope_named', 'reaching the ticket\'s minutes counts as a timeout');
});

const VALID = {
  id: 'split-pdf-from-reader', rule: 'Build the reader first and leave PDF reading to a second ticket.',
  failure: 'RED after 2701 s; 5 of 6 checks failed with no build script.',
  applies_to: ['brief', 'ticket'], check: 'scope_named', fix: 'refuse',
};

test('draftLesson: a model answer that is valid JSON becomes the draft; the model sees no more than the record', async () => {
  let seen = null;
  const chat = async (req) => { seen = req; return { ok: true, content: JSON.stringify({ ...VALID, extra: 'ignored' }), usd: 0.0004 }; };
  const d = await draftLesson({ run: redRun, failureLog: 'the builder ran out of time', chat, model: 'some-model' });
  assert.equal(d.drafted_by, 'model');
  assert.equal(d.id, VALID.id);
  assert.equal(d.rule, VALID.rule);
  assert.equal(d.check, 'scope_named');
  assert.equal(d.from_run, redRun.ticket.id);
  assert.equal(d.status, 'drafted');
  assert.equal(d.usd, 0.0004);
  assert.ok(!('extra' in d));
  assert.equal(seen.model, 'some-model');
  assert.equal(seen.messages.length, 2);
  assert.match(seen.messages[0].content, /ONE JSON object and nothing else/);
  assert.match(seen.messages[1].content, /the builder ran out of time/);
  const fencedChat = async () => ({ ok: true, content: '```json\n' + JSON.stringify(VALID) + '\n```' });
  const fenced = await draftLesson({ run: redRun, chat: fencedChat });
  assert.equal(fenced.drafted_by, 'model');
});

test('draftLesson: garbage, a failed call or a thrown call fall back to the record\'s draft and say why', async () => {
  const fallback = await draftLesson({ run: redRun });
  const says = (over) => async () => ({ ok: true, content: JSON.stringify({ ...VALID, ...over }) });
  const cases = [
    ['prose', async () => ({ ok: true, content: 'Sure! Here is a lesson: build smaller things.' }), /not a single JSON object/],
    ['a web address', says({ rule: 'Read https://example.com before building anything.' }), /web address/],
    ['a bad id', async () => ({ ok: true, content: JSON.stringify({ ...VALID, id: 'Not An Id' }) }), /id must be/],
    ['not a sentence', says({ rule: 'smaller tickets are better ok' }), /rule must be a sentence/],
    ['too long', async () => ({ ok: true, content: JSON.stringify({ ...VALID, rule: `A${' very'.repeat(80)} long rule.` }) }), /20\.\.300/],
    ['an unknown check', async () => ({ ok: true, content: JSON.stringify({ ...VALID, check: 'rm_rf' }) }), /known check/],
    ['a failed call', async () => ({ ok: false, content: '' }), /did not answer/],
    ['a thrown call', async () => { throw new Error('offline'); }, /model call failed \(offline\)/],
  ];
  for (const [name, chat, why] of cases) {
    const d = await draftLesson({ run: redRun, chat });
    assert.equal(d.drafted_by, 'rules', name);
    assert.match(d.model_note, why, name);
    const { model_note, ...rest } = d;
    assert.deepEqual(rest, fallback, name);
  }
});

test('validateModelLesson accepts the good answer and nothing around it', () => {
  assert.equal(validateModelLesson(JSON.stringify(VALID)).ok, true);
  assert.equal(validateModelLesson(`Here you go: ${JSON.stringify(VALID)}`).ok, false);
  assert.equal(validateModelLesson(JSON.stringify([VALID])).ok, false);
  assert.equal(validateModelLesson(JSON.stringify({ ...VALID, applies_to: [] })).ok, false);
  assert.equal(validateModelLesson(JSON.stringify({ ...VALID, fix: 'delete' })).ok, false);
  assert.equal(validateModelLesson(null).ok, false);
});
