// The founding council's passkeys, pinned. A council build's record counts only when at least two of its approvals are
// valid passkey signatures over that brief's hash, by keys that are the ones enrolled on 13 November 2026.
//
// What this proves: the two signatures in a record were made by the holders of the keys that were in data/council.json at the
// commit named below, over exactly this brief. What it does not prove: who holds those keys. The council file is a file in
// this repository, written by the build machine at enrolment; nothing on chain names the members or their keys.
import { createHash } from 'node:crypto';
import { verifyRelease } from './release.mjs';

export const FOUNDING_COUNCIL = Object.freeze({
  commit: '6846e6ddc93ce2485a6436d6646bc29f18dc2a16',   // "The founding council's three enrolled passkeys (public keys only)", 13 Nov 2026
  members_digest: 'ad3285ea659bdb12545390998e64bfb49643176c080fdcdeefca7ab4d96d18fd',
});
export const MIN_SIGNATURES = 2;

/** One hash over who the members are and which public keys they hold; names, figures and labels do not enter it. */
export function councilKeysHash(council) {
  const members = (council?.members ?? []).map((m) => [String(m.id),
    (m.credentials ?? []).map((c) => [String(c.id), String(c.alg), String(c.public_key_spki)]).sort((a, b) => (a[0] < b[0] ? -1 : 1))]);
  members.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash('sha256').update(JSON.stringify(members)).digest('hex');
}

/** { ok, why, signers }: does this run's record carry at least two valid signatures by the pinned keys over its brief? */
export function checkCouncilBuild({ run, ticket, council, pin = FOUNDING_COUNCIL }) {
  const found = councilKeysHash(council);
  if (found !== pin.members_digest) {
    return { ok: false, signers: [], why: `the council file's keys are not the ones enrolled at commit ${pin.commit.slice(0, 7)}` };
  }
  const v = verifyRelease(ticket, run?.approvals, council);
  if (v.ticket_sha256 !== run?.ticket_sha256) return { ok: false, signers: v.valid, why: 'the brief kept beside the record does not hash to the record\'s brief hash' };
  if (v.valid.length < MIN_SIGNATURES) {
    const bad = v.invalid.length ? ` (${v.invalid.map((i) => `${i.member}: ${i.why}`).join('; ')})` : '';
    return { ok: false, signers: v.valid, why: `${v.valid.length} valid signature(s) over the brief hash; at least ${MIN_SIGNATURES} are needed${bad}` };
  }
  return { ok: true, signers: v.valid, why: null };
}
