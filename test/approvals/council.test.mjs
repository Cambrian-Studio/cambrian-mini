// Enrolment by one-time invite: a link works once, for one member, and only an ES256 passkey made for this site is stored.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createInvite, findInvite, enrol, loadCouncil, publicCouncil } from '../../approvals/council.mjs';

const b64u = (b) => Buffer.from(b).toString('base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-council-test-'));
  const councilFile = join(dir, 'council.json'), invitesFile = join(dir, 'invites.json');
  writeFileSync(councilFile, JSON.stringify({ v: 1, threshold: 2, rp: { id: 'localhost', name: 't', origins: ['http://localhost:8787'] },
    members: [{ id: 'clemens', name: 'Clemens', credentials: [] }, { id: 'jj', name: 'JJ', credentials: [] }, { id: 'michael', name: 'Michael', credentials: [] }] }));
  return { dir, councilFile, invitesFile, council: loadCouncil(councilFile) };
}
function registration(challenge, { origin = 'http://localhost:8787', rpId = 'localhost', curve = 'prime256v1', flags = 0x45 } = {}) {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: curve });
  return { credential_id: b64u(randomBytes(16)), public_key_spki: b64u(publicKey.export({ format: 'der', type: 'spki' })),
    authenticator_data: b64u(Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), Buffer.alloc(4)])),
    client_data_json: b64u(JSON.stringify({ type: 'webauthn.create', challenge, origin })) };
}

test('an invite enrols one passkey for its member, once', () => {
  const s = setup();
  try {
    const inv = createInvite({ invitesFile: s.invitesFile, council: s.council, memberId: 'jj' });
    assert.equal(statSync(s.invitesFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(s.invitesFile, 'utf8').includes(inv.token), false, 'the token itself is never written');
    const found = findInvite({ invitesFile: s.invitesFile, token: inv.token }); assert.equal(found.ok, true); assert.equal(found.member, 'jj');
    const r = enrol({ councilFile: s.councilFile, invitesFile: s.invitesFile, token: inv.token, registration: registration(found.challenge) });
    assert.equal(r.ok, true);
    const c = loadCouncil(s.councilFile); assert.equal(c.members.find((m) => m.id === 'jj').credentials.length, 1);
    assert.equal(publicCouncil(c).members.find((m) => m.id === 'jj').enrolled, true);
    const again = enrol({ councilFile: s.councilFile, invitesFile: s.invitesFile, token: inv.token, registration: registration(found.challenge) });
    assert.equal(again.ok, false); assert.match(again.why, /already used/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});
test('unknown token, expired invite, wrong challenge, wrong origin, non-P-256 key: each refused and nothing stored', () => {
  const s = setup();
  try {
    assert.match(findInvite({ invitesFile: s.invitesFile, token: 'nope' }).why, /not known/);
    const inv = createInvite({ invitesFile: s.invitesFile, council: s.council, memberId: 'clemens', now: 1000 });
    assert.match(findInvite({ invitesFile: s.invitesFile, token: inv.token, now: 1000 + 25 * 3600 * 1000 }).why, /expired/);
    const f = findInvite({ invitesFile: s.invitesFile, token: inv.token, now: 2000 });
    const tries = [registration('other-challenge'), registration(f.challenge, { origin: 'https://evil.example' }),
      registration(f.challenge, { rpId: 'evil.example' }), registration(f.challenge, { curve: 'secp384r1' })];
    for (const reg of tries) assert.equal(enrol({ councilFile: s.councilFile, invitesFile: s.invitesFile, token: inv.token, registration: reg, now: 2000 }).ok, false);
    assert.equal(loadCouncil(s.councilFile).members.every((m) => m.credentials.length === 0), true);
    assert.throws(() => createInvite({ invitesFile: s.invitesFile, council: s.council, memberId: 'mallory' }), /not a council member/);
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
});

test('a passkey that does not verify its user cannot be enrolled, and cannot sign', async () => {
  const s = setup();
  try {
    const inv = createInvite({ invitesFile: s.invitesFile, council: s.council, memberId: 'jj' });
    const f = findInvite({ invitesFile: s.invitesFile, token: inv.token });
    // 0x41: user present and a key attached, but no fingerprint, face or PIN was checked
    const touchOnly = enrol({ councilFile: s.councilFile, invitesFile: s.invitesFile, token: inv.token, registration: registration(f.challenge, { flags: 0x41 }) });
    assert.equal(touchOnly.ok, false);
    assert.match(touchOnly.why, /created without user verification/);
    assert.equal(loadCouncil(s.councilFile).members.every((m) => m.credentials.length === 0), true, 'nothing stored');
    assert.equal(enrol({ councilFile: s.councilFile, invitesFile: s.invitesFile, token: inv.token, registration: registration(f.challenge) }).ok, true,
      'the same invite still enrols a passkey that verifies its user');
  } finally { rmSync(s.dir, { recursive: true, force: true }); }
  // the server asks for it at every ceremony, and the page asks for it by default
  const live = readFileSync(new URL('../../app/live.mjs', import.meta.url), 'utf8');
  assert.equal((live.match(/userVerification: 'preferred'/g) || []).length, 0);
  assert.ok((live.match(/userVerification: 'required'/g) || []).length >= 6);
  const page = readFileSync(new URL('../../web/lib/webauthn.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(page, /userVerification: (options\.userVerification \|\| )?'preferred'/);
  // a software authenticator that answers with user-present only: its approval is refused by the line and by the page's own check
  const { makeTestCouncil } = await import('../../approvals/test-authenticator.mjs');
  const { verifyRelease } = await import('../../approvals/release.mjs');
  const web = await import('../../web/lib/webauthn.mjs');
  const { council, sign } = makeTestCouncil();
  const ticket = { v: 1, id: 't-uv', product: 'p', goal: 'g', task: 't', green: [], budget_usd: 1 };
  const weak = sign('jj', ticket, { flags: 0x01 }); const strong = sign('clemens', ticket);
  const r = verifyRelease(ticket, [strong, weak], council);
  assert.equal(r.ok, false);
  assert.deepEqual(r.invalid.map((i) => i.member), ['jj']);
  assert.match(r.invalid[0].why, /user-verified flag is not set/);
  const subject = await web.approvalSubject(r.ticket_sha256, weak.taste_note);
  const inPage = await web.verifyMemberSignature({ purpose: 'approval', subjectHash: subject, approval: weak, council });
  assert.equal(inPage.ok, false);
  assert.match(inPage.why, /user-verified flag is not set/);
});
