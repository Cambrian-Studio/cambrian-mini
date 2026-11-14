// provenance.mjs — re-check, offline, where a drafted ticket's text came from. The judge runs this over
// every entry in data/tickets whose ticket carries `drafted`. Reads files; no network, no key.
//
// Three things must agree on one hash:
//   the kept model response  — sha256 of <id>.brief-response.json is ticket.drafted.response_sha256
//   the model's signature    — made in the model's TEE over "<model>:<request sha256>:<response sha256>"
//   the council's approvals  — each signs a challenge derived from ticketHash(ticket), which covers `drafted`
// What this does not say: that the ticket equals the response. The ticket is derived from it by code.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ticketHash } from './ticket.mjs';
import { approvalSubject, ideaHash, verifyMemberSignature } from '../approvals/release.mjs';
import { conversationHash } from './think.mjs';
import { verifyAttestation } from '../near/nearai.mjs';

const sha256Hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8'));

/**
 * @param {object} a
 * @param {string} a.dir      the tickets directory (the kept files lie beside the entry)
 * @param {object} a.entry    one ticket entry: { ticket, approvals, brief: { attestation }, proposed_by, idea }
 * @param {object} a.council  the council the approvals are checked against
 * @returns {{faults: string[], signed: boolean, approvals: number, signature_without_tee_report?: boolean}} `signed` is true
 *   only when a model-TEE signature is recorded AND verifies; an entry recorded without one has signed:false and no fault
 *   for it; `signature_without_tee_report` marks a signature that verifies over the hashes with no TEE report for its key.
 */
export function checkDrafted({ dir, entry, council }) {
  const t = entry.ticket; const d = t.drafted; const faults = [];
  const beside = (name) => join(dir, `${t.id}.${name}.json`);
  const sha = ticketHash(t);

  if (!existsSync(beside('brief-response'))) faults.push('the model response was not kept');
  else if (sha256Hex(readFileSync(beside('brief-response'))) !== d.response_sha256) {
    faults.push('the kept response is not the one the ticket names');
  }
  if (existsSync(beside('brief-request')) && sha256Hex(readFileSync(beside('brief-request'))) !== d.request_sha256) {
    faults.push('the kept request is not the one the ticket names');
  }

  let approvals = 0;
  for (const a of entry.approvals ?? []) {
    // a signature given with a taste note covers the ticket hash and the note together
    const v = a?.ticket_sha256 === sha ? verifyMemberSignature({ purpose: 'approval', subjectHash: approvalSubject(sha, a.taste_note), approval: a, council })
      : { ok: false, why: 'signed another ticket hash (the ticket, or its drafted hash, changed after signing)' };
    if (v.ok) approvals++; else faults.push(`approval by ${a?.member ?? '?'}: ${v.why}`);
  }
  // A brief that came from a conversation names it by hash: the kept conversation must hash to that, and the member who sent
  // the brief signed that hash. A brief from a single idea was signed over the idea's text.
  if (t.conversation) {
    if (!Array.isArray(entry.conversation?.messages)) faults.push('the conversation the ticket names was not kept');
    else if (conversationHash(entry.conversation.messages) !== t.conversation.sha256) faults.push('the kept conversation is not the one the ticket names');
  }
  if (entry.proposed_by?.approval) {
    const subjectHash = t.conversation ? t.conversation.sha256 : ideaHash(entry.idea);
    const v = verifyMemberSignature({ purpose: 'idea', subjectHash, approval: entry.proposed_by.approval, council });
    if (!v.ok) faults.push(`the proposer's signature over the ${t.conversation ? 'conversation' : 'idea'}: ${v.why}`);
  }

  const att = entry.brief?.attestation ?? null;
  if (!att) return { faults, signed: false, approvals };
  const report = existsSync(beside('brief-report')) ? readJson(beside('brief-report')) : undefined;
  const v = verifyAttestation(att, { requestSha256: d.request_sha256, responseSha256: d.response_sha256, report });
  // The signature can be good over the exact request and response while NEAR AI's report names no TEE for the key that made
  // it. That is not a fault in the record, and it is not a model-TEE signature either: it is reported as its own case.
  const held = (name) => (v.checks ?? []).some((c) => c.name === name && c.ok === true);
  if (!v.ok && held('signature') && held('text_binds_hashes') && /no TEE report for this signer/.test(String(v.why))) {
    return { faults, signed: false, signature_without_tee_report: true, approvals };
  }
  if (!v.ok) faults.push(`the model's signature: ${v.why}`);
  // only a signature made in the model's own TEE has the model id in its signed text
  else if (att.kind !== 'provider_tee' || att.model !== d.model) faults.push(`the signature does not bind the model ${d.model}`);
  return { faults, signed: v.ok && att.kind === 'provider_tee' && att.model === d.model, approvals };
}
