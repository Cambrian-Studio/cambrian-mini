// release.mjs — THE RULE: nothing is built until 2 of the 3 council members have signed the ticket.
//
// Each approval is a passkey signature over a challenge derived from the ticket's hash. The line calls
// verifyRelease() before it does anything and again right before it pushes. Change one byte of the ticket
// after signing and the hash changes, the challenge changes, and every signature stops verifying.
// PURE: no I/O, no network, no clock.
import { createHash } from 'node:crypto';
import { canonical, sha256Hex } from '../receipts/canonical.mjs';
import { verifyAssertion } from './webauthn.mjs';

const HEX64 = /^[0-9a-f]{64}$/;
const challengeFor = (purpose, subjectHash) => createHash('sha256').update(`cambrian-${purpose}-v1:${subjectHash}`).digest().toString('base64url');

/** sha256 of the ticket's canonical JSON — the thing the council signs. */
export const ticketHash = (ticket) => sha256Hex(canonical(ticket));
/** The WebAuthn challenge (base64url) a member's passkey signs to approve the ticket with this hash. */
export const approvalChallenge = (ticketSha256) => challengeFor('approval', ticketSha256);
/** The challenge a member signs to accept a drafted lesson with this hash. */
export const lessonChallenge = (lessonSha256) => challengeFor('lesson', lessonSha256);
/** The challenge a member signs to propose an idea: the subject is sha256 (hex) of the idea's exact utf8 text.
 *  It is another purpose than "approval", so a proposer's signature can never count as an approval. */
export const ideaChallenge = (ideaSha256) => challengeFor('idea', ideaSha256);
/** With images attached, the proposer signs the text AND the images: the text, then each image's sha256 on its own line. */
export const ideaHash = (idea, attachmentShas = []) => createHash('sha256')
  .update(attachmentShas.length ? `${String(idea)}\n${attachmentShas.join('\n')}` : String(idea), 'utf8').digest('hex');

/** A taste note is a member's own short remark, given with the signature: why they signed, or what to watch for. */
export const MAX_TASTE_NOTE = 200;
export const tasteNote = (v) => (typeof v === 'string' && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, MAX_TASTE_NOTE) : null);
/** What an approval signs: the ticket hash alone, or with a taste note the hash of the ticket hash and the note.
 *  So a note cannot be added to, changed in or removed from a signature after the fact. */
export const approvalSubject = (ticketSha256, note = null) => (tasteNote(note)
  ? sha256Hex(`${ticketSha256}\n${createHash('sha256').update(tasteNote(note), 'utf8').digest('hex')}`) : ticketSha256);

function credentialOf(council, memberId, credentialId) {
  const member = (council?.members ?? []).find((m) => m.id === memberId);
  if (!member) return { why: `'${memberId}' is not a council member` };
  const cred = (member.credentials ?? []).find((c) => c.id === credentialId);
  if (!cred) return { why: `${memberId} has no enrolled passkey with that id` };
  return { member, cred };
}

/** One member's signature over one subject hash. → {ok, member, why} */
export function verifyMemberSignature({ purpose, subjectHash, approval, council }) {
  const memberId = String(approval?.member ?? '');
  if (!HEX64.test(String(subjectHash ?? ''))) return { ok: false, member: memberId, why: 'no subject hash' };
  const found = credentialOf(council, memberId, approval?.credential_id);
  if (found.why) return { ok: false, member: memberId, why: found.why };
  const r = verifyAssertion({
    publicKeySpki: found.cred.public_key_spki,
    authenticatorData: approval.authenticator_data,
    clientDataJSON: approval.client_data_json,
    signature: approval.signature,
    expectedChallenge: challengeFor(purpose, subjectHash),
    rpId: found.cred.rp_id ?? council.rp?.id,
    origins: council.rp?.origins ?? [],
  });
  return { ok: r.ok, member: memberId, why: r.why, userVerified: r.userVerified };
}

/**
 * May the line build this ticket?
 * @returns {{ok:boolean, valid:string[], invalid:{member:string,why:string}[], threshold:number, ticket_sha256:string, why:string|null}}
 */
export function verifyRelease(ticket, approvals, council) {
  const threshold = Number(council?.threshold);
  const ticket_sha256 = ticketHash(ticket);
  const base = { valid: [], invalid: [], threshold, ticket_sha256 };
  if (!Number.isInteger(threshold) || threshold < 2) return { ...base, ok: false, why: 'the council file names no threshold of 2 or more' };
  if ((council?.members ?? []).length < threshold) return { ...base, ok: false, why: 'the council has fewer members than its threshold' };

  const valid = new Set(); const invalid = [];
  for (const a of Array.isArray(approvals) ? approvals : []) {
    if (a?.ticket_sha256 !== ticket_sha256) { invalid.push({ member: String(a?.member ?? '?'), why: 'signed a different ticket body' }); continue; }
    const r = verifyMemberSignature({ purpose: 'approval', subjectHash: approvalSubject(ticket_sha256, a.taste_note), approval: a, council });
    if (r.ok) valid.add(r.member); else invalid.push({ member: r.member, why: r.why });
  }
  const out = { ...base, valid: [...valid].sort(), invalid };
  if (valid.size < threshold) {
    return { ...out, ok: false, why: `${valid.size} of ${council.members.length} valid approvals; ${threshold} are required${invalid.length ? ` (${invalid.map((i) => `${i.member}: ${i.why}`).join('; ')})` : ''}` };
  }
  return { ...out, ok: true, why: null };
}
