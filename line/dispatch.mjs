// dispatch.mjs — the one way a run starts. startRun claims the ticket's run directory EXACTLY ONCE and
// then calls runTicket: a ticket id runs once, whoever asks and however often.
//
// The claim is a directory made with an exclusive mkdir, so two callers racing for the same id cannot both
// win. The only id that may be started again is one whose earlier run was stopped in preflight ("blocked",
// no attempt made — for example by the daily ceiling): nothing ran, so nothing is repeated.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runTicket } from './run.mjs';
import { TICKET_ID } from '../tickets/ticket.mjs';

/** Claim <records>/<id>. → {ok, why} */
export function claimRun(cfg, id) {
  if (!TICKET_ID.test(String(id ?? ''))) return { ok: false, why: 'not a ticket id' };
  mkdirSync(cfg.records, { recursive: true });
  const dir = join(cfg.records, id);
  try {
    mkdirSync(dir);
    return { ok: true, why: null };
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
  }
  let prior = null;
  try {
    prior = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
  } catch { /* claimed, no record yet */ }
  const nothingRan = prior?.state === 'blocked' && (prior.attempts?.length ?? 0) === 0;
  if (!nothingRan) {
    return { ok: false, why: `ticket ${id} already has a run (${prior?.state ?? 'claimed, in progress'}) — a ticket id runs once` };
  }
  // one retry per earlier blocked record: the exclusive create of this marker is the claim
  try {
    writeFileSync(join(dir, `retry-${String(prior.started).replace(/[^0-9A-Za-z]/g, '')}.claim`), `${new Date().toISOString()}\n`, {
      flag: 'wx',
    });
  } catch (e) {
    if (e.code === 'EEXIST') return { ok: false, why: `ticket ${id} is already being started again — a ticket id runs once` };
    throw e;
  }
  return { ok: true, why: null };
}

/**
 * Start one run. → a promise of the final run record. Throws when the id is already claimed.
 * hooks: { onUpdate(rec), onRed(rec, failureLog) → a drafted lesson or null, log(id, line) }
 */
export async function startRun(
  cfg,
  { ticket, approvals = [], council, lessonsFired = [], hooks = {} },
  { fetchImpl = fetch, near = undefined } = {},
) {
  const claim = claimRun(cfg, ticket?.id);
  if (!claim.ok) throw new Error(`run not started: ${claim.why}`);
  return runTicket(cfg, { ticket, approvals, council, lessonsFired }, {
    log: hooks.log,
    onUpdate: hooks.onUpdate,
    onRed: hooks.onRed,
    fetchImpl,
    near,
  });
}
