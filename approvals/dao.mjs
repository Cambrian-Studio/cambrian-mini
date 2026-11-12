// dao.mjs — ON-CHAIN APPROVAL: NOT BUILT YET. This file is the interface the app already calls, as a stub.
//
// Today a ticket is released by 2 of 3 passkey signatures checked in approvals/release.mjs.
// Next: the same decision as a Sputnik DAO proposal (a FunctionCall proposal on the council's DAO, created
// and voted through Trezu), so the approval itself is a NEAR transaction anyone can read.
//
// TODO(on-chain approval):
//   1. proposeRelease(): add_proposal on the DAO with kind FunctionCall → receipts contract
//      `approve_ticket(ticket_sha256)`; return the proposal id.
//   2. readRelease(): view get_proposal(id); released when status is "Approved" and the proposal's
//      argument equals the ticket hash the line is about to build.
//   3. The line then requires BOTH: the passkey threshold and the approved proposal.
// Until then every function here says plainly that it is not available. Nothing pretends.

export const DAO_STATUS = Object.freeze({
  available: false,
  label: 'On-chain council: next',
  detail: 'Today the council approves with passkeys (2 of 3). The on-chain vote is not wired; no transaction is sent.',
});

const notYet = () => ({ ok: false, available: false, why: DAO_STATUS.detail });

/** Would create the DAO proposal that approves a ticket hash. Not built: sends nothing. */
export async function proposeRelease(_ticketSha256, _opts = {}) { return notYet(); }

/** Would read the DAO proposal's status by public RPC. Not built: reads nothing. */
export async function readRelease(_ticketSha256, _opts = {}) { return notYet(); }
