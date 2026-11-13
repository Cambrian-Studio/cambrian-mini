// test-authenticator.mjs — TEST ONLY. A software passkey: it makes P-256 keys and signs WebAuthn
// assertions the same way a phone or a security key does, so tests and the offline demo exercise the REAL
// verifier (webauthn.mjs / release.mjs) without a human. These keys are generated fresh, live in memory,
// and are never a real council member's.
import { createHash, generateKeyPairSync, sign as cryptoSign, randomBytes } from 'node:crypto';
import { approvalChallenge, approvalSubject, ideaChallenge, ideaHash, lessonChallenge, tasteNote, ticketHash } from './release.mjs';

const sha256 = (b) => createHash('sha256').update(b).digest();
const b64u = (b) => Buffer.from(b).toString('base64url');

export function makeTestAuthenticator({ rpId = 'localhost', origin = 'http://localhost:8787' } = {}) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const credentialId = b64u(randomBytes(16));
  let counter = 0;
  /** Sign a challenge (base64url). Options let a test forge a wrong origin, site or flag. */
  const assert = (challenge, { origin: o = origin, rpId: r = rpId, flags = 0x05, type = 'webauthn.get' } = {}) => {
    const count = Buffer.alloc(4); count.writeUInt32BE(++counter);
    const authenticatorData = Buffer.concat([sha256(Buffer.from(r)), Buffer.from([flags]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge, origin: o, crossOrigin: false }));
    const signature = cryptoSign('sha256', Buffer.concat([authenticatorData, sha256(clientDataJSON)]), { key: privateKey, dsaEncoding: 'der' });
    return { credential_id: credentialId, authenticator_data: b64u(authenticatorData), client_data_json: b64u(clientDataJSON), signature: b64u(signature) };
  };
  const credential = { id: credentialId, alg: -7, rp_id: rpId, public_key_spki: b64u(publicKey.export({ format: 'der', type: 'spki' })), enrolled_at: '2026-11-12T00:00:00.000Z', test_only: true };
  return { credential, assert };
}

/**
 * A council with software passkeys: three members and a threshold of two unless told otherwise
 * (`members`: ids, `threshold`: how many must sign). sign(memberId, ticket) → an approval the line accepts.
 */
export function makeTestCouncil({ rpId = 'localhost', origin = 'http://localhost:8787', at = '2026-11-12T00:00:00.000Z',
  members = ['clemens', 'jj', 'michael'], threshold = 2 } = {}) {
  const ids = members;
  const auth = Object.fromEntries(ids.map((id) => [id, makeTestAuthenticator({ rpId, origin })]));
  const council = {
    v: 1, threshold, test_only: true,
    rp: { id: rpId, name: 'Cambrian Mini (test council)', origins: [origin] },
    members: ids.map((id) => ({ id, name: id === 'jj' ? 'JJ' : id[0].toUpperCase() + id.slice(1), credentials: [auth[id].credential] })),
  };
  /** `note`: a taste note signed with the ticket. */
  const sign = (memberId, ticket, forge, note = null) => {
    const ticket_sha256 = ticketHash(ticket);
    return { member: memberId, ticket_sha256, ...auth[memberId].assert(approvalChallenge(approvalSubject(ticket_sha256, note)), forge), at,
      ...(tasteNote(note) ? { taste_note: tasteNote(note) } : {}) };
  };
  const signLesson = (memberId, lessonSha256, forge) => ({ member: memberId, lesson_sha256: lessonSha256, ...auth[memberId].assert(lessonChallenge(lessonSha256), forge), at });
  /** A proposer's signature over an idea's exact text: the body /api/ideas wants when the app is exposed. */
  const signIdea = (memberId, idea, forge, attachmentShas = []) => {
    const idea_sha256 = ideaHash(idea, attachmentShas);
    return { member: memberId, idea_sha256, ...auth[memberId].assert(ideaChallenge(idea_sha256), forge), at };
  };
  return { council, sign, signLesson, signIdea, authenticators: auth };
}
