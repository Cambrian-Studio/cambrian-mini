// The approval rule, both directions: 2 of 3 real signatures release a ticket; anything less, or anything forged, does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyRelease, ticketHash, approvalChallenge, ideaChallenge, ideaHash, lessonChallenge, verifyMemberSignature }
  from '../../approvals/release.mjs';
import { createHash } from 'node:crypto';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';

const ticket = () => ({ kind: 'build-ticket', v: 1, id: 'facts-page-1', product: 'facts', title: 'A facts page',
  task: 'Build one static page that lists three facts.', green: [{ id: 'page', kind: 'file', name: 'page', path: 'index.html', exists: true }],
  budget: { usd: 1, calls: 20, minutes: 10 }, base: 'main', branch: 'build/facts-page-1' });

test('2 of 3 valid signatures release the ticket', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  const r = verifyRelease(t, [sign('clemens', t), sign('michael', t)], council);
  assert.equal(r.ok, true); assert.deepEqual(r.valid, ['clemens', 'michael']); assert.equal(r.ticket_sha256, ticketHash(t));
});
test('3 of 3 also release it', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  assert.equal(verifyRelease(t, [sign('clemens', t), sign('jj', t), sign('michael', t)], council).ok, true);
});
test('no approval: refused', () => {
  const { council } = makeTestCouncil();
  const r = verifyRelease(ticket(), [], council); assert.equal(r.ok, false); assert.match(r.why, /0 of 3 valid approvals; 2 are required/);
});
test('1 of 3: refused', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  const r = verifyRelease(t, [sign('jj', t)], council); assert.equal(r.ok, false); assert.deepEqual(r.valid, ['jj']);
});
test('the same member signing twice counts once', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  assert.equal(verifyRelease(t, [sign('jj', t), sign('jj', t)], council).ok, false);
});
test('an altered ticket: every signature stops verifying', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  const approvals = [sign('clemens', t), sign('jj', t)];
  assert.equal(verifyRelease(t, approvals, council).ok, true);
  const altered = { ...t, budget: { ...t.budget, usd: 5 } };
  const r = verifyRelease(altered, approvals, council);
  assert.equal(r.ok, false); assert.equal(r.valid.length, 0); assert.match(r.why, /signed a different ticket body/);
});
test('an altered ticket with the hash field rewritten to match still fails (the signature is over the old challenge)', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  const altered = { ...t, task: t.task + ' Also delete everything.' };
  const forged = [sign('clemens', t), sign('jj', t)].map((a) => ({ ...a, ticket_sha256: ticketHash(altered) }));
  const r = verifyRelease(altered, forged, council);
  assert.equal(r.ok, false); assert.match(r.why, /different challenge/);
});
test('a signature by a key that is not the member\'s: refused', () => {
  const a = makeTestCouncil(), b = makeTestCouncil(); const t = ticket();
  const stolen = { ...b.sign('clemens', t), credential_id: a.council.members[0].credentials[0].id };
  const r = verifyRelease(t, [stolen, a.sign('jj', t)], a.council);
  assert.equal(r.ok, false); assert.match(r.why, /does not verify/);
});
test('a stranger is not a council member', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  const r = verifyRelease(t, [{ ...sign('jj', t), member: 'mallory' }, sign('clemens', t)], council);
  assert.equal(r.ok, false); assert.match(r.why, /not a council member/);
});
test('wrong origin, wrong site, no user presence, no user verification, wrong ceremony type: each refused', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket(); const good = sign('clemens', t);
  for (const [forge, re] of [[{ origin: 'https://evil.example' }, /origin/], [{ rpId: 'evil.example' }, /another site/],
    [{ flags: 0x00 }, /user-present/], [{ flags: 0x01 }, /user-verified flag is not set/], [{ type: 'webauthn.create' }, /type/]]) {
    const r = verifyRelease(t, [good, sign('jj', t, forge)], council);
    assert.equal(r.ok, false, JSON.stringify(forge)); assert.match(r.why, re);
  }
});
test('an approval signature cannot be replayed as a lesson acceptance (the purposes have different challenges)', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket(); const a = sign('clemens', t);
  assert.equal(verifyMemberSignature({ purpose: 'approval', subjectHash: ticketHash(t), approval: a, council }).ok, true);
  assert.equal(verifyMemberSignature({ purpose: 'lesson', subjectHash: ticketHash(t), approval: a, council }).ok, false);
});
test('a council with a threshold below 2 is refused outright', () => {
  const { council, sign } = makeTestCouncil(); const t = ticket();
  assert.equal(verifyRelease(t, [sign('jj', t)], { ...council, threshold: 1 }).ok, false);
});
test('the challenge is a function of the ticket hash only', () => {
  assert.equal(approvalChallenge('a'.repeat(64)), approvalChallenge('a'.repeat(64)));
  assert.notEqual(approvalChallenge('a'.repeat(64)), approvalChallenge('b'.repeat(64)));
});

test('proposing an idea is its own purpose: the signature holds over that exact idea and can never count as an approval', () => {
  const { council, sign, signIdea } = makeTestCouncil(); const t = ticket(); const idea = 'a page that lists three facts — tide pools';
  assert.equal(ideaHash(idea), createHash('sha256').update(Buffer.from(idea, 'utf8')).digest('hex'), 'sha256 of the exact utf8 text');
  const h = ideaHash(idea);
  assert.notEqual(ideaChallenge(h), approvalChallenge(h)); assert.notEqual(ideaChallenge(h), lessonChallenge(h));
  const p = signIdea('jj', idea);
  assert.equal(verifyMemberSignature({ purpose: 'idea', subjectHash: h, approval: p, council }).ok, true);
  assert.equal(verifyMemberSignature({ purpose: 'idea', subjectHash: ideaHash(`${idea} `), approval: p, council }).ok, false,
    'one more character');
  assert.equal(verifyMemberSignature({ purpose: 'approval', subjectHash: h, approval: p, council }).ok, false);
  assert.equal(verifyMemberSignature({ purpose: 'idea', subjectHash: ticketHash(t), approval: sign('jj', t), council }).ok, false,
    'nor the other way round');
  // offered as approvals of a ticket, with the hash field rewritten to fit: none is valid, so nothing is released
  const posed = ['jj', 'clemens', 'michael'].map((m) => ({ ...signIdea(m, idea), ticket_sha256: ticketHash(t) }));
  const r = verifyRelease(t, posed, council); assert.equal(r.ok, false); assert.deepEqual(r.valid, []);
  // even if the idea's text were the ticket hash itself, the purpose keeps the challenges apart
  const sly = ['jj', 'clemens'].map((m) => ({ ...signIdea(m, ticketHash(t)), ticket_sha256: ticketHash(t) }));
  assert.deepEqual(verifyRelease(t, sly, council).valid, []);
  assert.equal(verifyRelease(t, [sign('jj', t), ...posed], council).ok, false, 'one approval plus three proposals is still one');
});

const SEVEN = ['ada', 'ben', 'cy', 'dee', 'eli', 'fay', 'gus'];
test('a council of seven with a threshold of four: four signatures release, three do not, an altered brief does not', () => {
  const { council, sign } = makeTestCouncil({ members: SEVEN, threshold: 4 }); const t = ticket();
  assert.equal(council.members.length, 7); assert.equal(council.threshold, 4);
  const four = ['ada', 'cy', 'eli', 'gus'].map((m) => sign(m, t));
  const r = verifyRelease(t, four, council);
  assert.equal(r.ok, true); assert.deepEqual(r.valid, ['ada', 'cy', 'eli', 'gus']); assert.equal(r.threshold, 4);
  const three = verifyRelease(t, four.slice(0, 3), council);
  assert.equal(three.ok, false); assert.match(three.why, /3 of 7 valid approvals; 4 are required/);
  assert.equal(verifyRelease(t, [...four.slice(0, 3), four[0]], council).ok, false, 'the same member twice is still three');
  const altered = { ...t, task: `${t.task} Also publish it.` };
  const a = verifyRelease(altered, four, council);
  assert.equal(a.ok, false); assert.equal(a.valid.length, 0);
  assert.equal(verifyRelease(t, SEVEN.map((m) => sign(m, t)), council).ok, true, 'seven of seven also release it');
});
test('the threshold is a parameter of the council file, never below two and never above its size', () => {
  const { council, sign } = makeTestCouncil({ members: SEVEN, threshold: 4 }); const t = ticket();
  const all = SEVEN.map((m) => sign(m, t));
  assert.equal(verifyRelease(t, all.slice(0, 5), { ...council, threshold: 5 }).ok, true);
  assert.equal(verifyRelease(t, all.slice(0, 4), { ...council, threshold: 5 }).ok, false);
  assert.equal(verifyRelease(t, all, { ...council, threshold: 8 }).ok, false, 'more than there are members');
  assert.equal(verifyRelease(t, all, { ...council, threshold: 1 }).ok, false, 'one is not a council');
});
