// What the browser verifies must agree with what the line verifies: the passkey check in
// web/lib/webauthn.mjs against approvals/release.mjs, and receipt hashes against the real record.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appConfig } from '../../app/config.mjs';
import { snapshot } from '../../app/store.mjs';
import { hashOfAsync } from '../../receipts/canonical.mjs';
import * as reference from '../../approvals/release.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { publicCouncil } from '../../approvals/council.mjs';
import { verifyMemberSignature, approvalChallenge, lessonChallenge, ideaChallenge, ideaHash, derToRaw } from '../../web/lib/webauthn.mjs';
import { stationStates, replaySteps } from '../../web/screens/line.js';

const snap = snapshot({ ...appConfig(), mode: 'replay', reasons: [] });
const ticket = { kind: 'build-ticket', v: 1, id: 'web-test-ticket', product: 'upread', title: 'A test ticket', task: 'x',
  green: [{ id: 'unit', kind: 'run', run: 'node --test' }], budget: { usd: 1, calls: 10, minutes: 5 }, base: 'main', branch: 'build/web-test-ticket' };

test('the browser derives the same challenges as the line', async () => {
  const hash = 'ab'.repeat(32);
  assert.equal(await approvalChallenge(hash), reference.approvalChallenge(hash));
  assert.equal(await lessonChallenge(hash), reference.lessonChallenge(hash));
  assert.notEqual(await approvalChallenge(hash), await lessonChallenge(hash));
  assert.equal(await ideaChallenge(hash), reference.ideaChallenge(hash));
  assert.notEqual(await ideaChallenge(hash), await approvalChallenge(hash));
  assert.notEqual(await ideaChallenge(hash), await lessonChallenge(hash));
  for (const idea of ['a page about tide pools', 'Gezeitentümpel — drei Fakten ✓', ' spaces kept ']) {
    assert.equal(await ideaHash(idea), reference.ideaHash(idea), idea);
  }
});

test('the browser accepts what the line accepts and refuses what it refuses', async () => {
  const { council, sign, signLesson, signIdea } = makeTestCouncil();
  const idea = 'a page that lists three facts about tide pools'; const ideaSha = await ideaHash(idea);
  const served = publicCouncil(council);            // the browser only ever sees the served council
  const hash = reference.ticketHash(ticket);
  const lessonHash = 'cd'.repeat(32);
  const good = sign('clemens', ticket);
  const cases = [
    ['a good approval', 'approval', hash, good, true],
    ['a second member', 'approval', hash, sign('jj', ticket), true],
    ['another origin', 'approval', hash, sign('clemens', ticket, { origin: 'https://elsewhere.example' }), false],
    ['another site', 'approval', hash, sign('clemens', ticket, { rpId: 'elsewhere.example' }), false],
    ['no user present', 'approval', hash, sign('clemens', ticket, { flags: 0x00 }), false],
    ['a creation, not a signature', 'approval', hash, sign('clemens', ticket, { type: 'webauthn.create' }), false],
    ['an altered ticket', 'approval', reference.ticketHash({ ...ticket, task: 'y' }), good, false],
    ['another member\'s name on it', 'approval', hash, { ...good, member: 'michael' }, false],
    ['someone outside the council', 'approval', hash, { ...good, member: 'nobody' }, false],
    ['a broken signature', 'approval', hash, { ...good, signature: good.signature.slice(0, -4) + 'AAAA' }, false],
    ['an approval offered as a lesson acceptance', 'lesson', hash, good, false],
    ['a good lesson acceptance', 'lesson', lessonHash, signLesson('michael', lessonHash), true],
    ['a lesson acceptance offered as an approval', 'approval', lessonHash, signLesson('michael', lessonHash), false],
    ['a recorded proposer signature', 'idea', ideaSha, signIdea('jj', idea), true],
    ['a proposer signature over another idea', 'idea', reference.ideaHash(`${idea}.`), signIdea('jj', idea), false],
    ['a proposer signature offered as an approval', 'approval', ideaSha, signIdea('jj', idea), false],
    ['an approval offered as a proposer signature', 'idea', hash, good, false],
  ];
  for (const [what, purpose, subjectHash, approval, want] of cases) {
    const theirs = reference.verifyMemberSignature({ purpose, subjectHash, approval, council });
    const ours = await verifyMemberSignature({ purpose, subjectHash, approval, council: served });
    assert.equal(theirs.ok, want, `the line on ${what}`);
    assert.equal(ours.ok, want, `the browser on ${what}: ${ours.why}`);
  }
});

test('derToRaw pads short integers and refuses a non-DER signature', () => {
  const raw = derToRaw(new Uint8Array([0x30, 0x08, 0x02, 0x02, 0x00, 0x81, 0x02, 0x02, 0x01, 0x02]));
  assert.equal(raw.length, 64);
  assert.deepEqual([raw[31], raw[62], raw[63]], [0x81, 0x01, 0x02]);
  assert.throws(() => derToRaw(new Uint8Array([0x31, 0x00])));
});

test('every receipt in the record verifies the way the Verify button does, and a changed one does not', async () => {
  const names = Object.keys(snap).filter((k) => /^api\/receipts\/.+\.json$/.test(k));
  assert.ok(names.length >= 3);
  for (const name of names) {
    const file = snap[name];
    assert.equal(await hashOfAsync(file.receipt), file.receipt_sha256, name);
    const altered = structuredClone(file.receipt);
    altered.totals.usd += 0.01;
    assert.notEqual(await hashOfAsync(altered), file.receipt_sha256, name);
  }
});

test('an imported run carries a note in place of signatures, so nothing verifiable-looking is drawn', () => {
  const imported = Object.entries(snap).filter(([k, v]) => /^api\/receipts\/.+\.json$/.test(k) && v.origin === 'private-line');
  assert.ok(imported.length >= 3);
  for (const [name, file] of imported) {
    assert.deepEqual(file.receipt.approvals.signatures, [], name);
    assert.match(file.receipt.approvals.note, /not verifiable from this repository/, name);
  }
});

test('stations: red lights through test (red) and its receipt, never the preview; refused stops at approved', () => {
  const run = (id) => snap[`api/runs/${id}.json`];
  const red = run('upread-v1-one-word-at-a-time-reader-for');
  assert.equal(red.state, 'red');
  assert.deepEqual(Object.values(stationStates(red)), ['on', 'on', 'on', 'red', 'off', 'on']);
  assert.deepEqual(Object.values(stationStates({ ...red, stations: { ...red.stations, preview: { at: red.finished } } })),
    ['on', 'on', 'on', 'red', 'off', 'on']);
  assert.deepEqual(Object.values(stationStates(run('upread-v1-reader-shell'))), ['on', 'on', 'on', 'on', 'on', 'on']);
  const refused = { ...red, state: 'refused' };
  assert.deepEqual(Object.values(stationStates(refused)), ['on', 'red', 'off', 'off', 'off', 'off']);
  assert.equal(replaySteps(refused).at(-1).station, 'approved');
  const running = { state: 'running', stations: { brief: { at: 'x' }, approved: { at: 'x' }, build: { at: 'x' } } };
  assert.deepEqual(Object.values(stationStates(running)), ['on', 'on', 'now', 'off', 'off', 'off']);
  const two = replaySteps(run('upread-v1-open-pdf')).map((x) => `${x.station}:${x.state}`);
  assert.deepEqual(two, ['brief:on', 'approved:on', 'build:on', 'test:red', 'build:on', 'test:on', 'preview:on', 'receipt:on']);
});
