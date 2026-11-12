// budget.mjs — the line's daily ceiling. One number, cfg.daily_ceiling_usd, bounds a UTC day.
// Before every start the line sums today's spend from its own run records and refuses a run whose ticket
// budget, together with the budgets of runs still running, would carry the day past the ceiling. At half
// the ceiling it says so once per UTC day. PURE except the reads of the run records and one small state file.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const utcDay = (iso = new Date().toISOString()) => String(iso).slice(0, 10);
const usd = (n) => `$${Number(n).toFixed(2)}`;

/**
 * PURE. Would this ticket carry the day past the ceiling? → {ok, why, detail}.
 * `why` is the same sentence all day (no live figures in it); `detail` carries the figures for the record.
 * A meter that could not be read blocks: nothing starts on an unread meter.
 */
export function ceilingDecision({ spent_usd, committed_usd = 0, ticket_usd, ceiling_usd, day }) {
  if (!Number.isFinite(spent_usd)) {
    return {
      ok: false,
      why: `daily ceiling: today's spend could not be read (UTC ${day}) — nothing starts on an unread meter`,
      detail: 'spend UNVERIFIED',
    };
  }
  const after = spent_usd + committed_usd + ticket_usd;
  const detail = `today (UTC ${day}) ${usd(spent_usd)} spent + ${usd(committed_usd)} committed by running tickets` +
    ` + this ticket's ${usd(ticket_usd)} = ${usd(after)} of the ${usd(ceiling_usd)} daily ceiling`;
  if (after > ceiling_usd + 1e-9) {
    const why = `daily ceiling: this ticket's ${usd(ticket_usd)} budget would carry today's spend past the line's ${usd(ceiling_usd)}` +
      ` (UTC ${day}); start it again after midnight UTC`;
    return { ok: false, why, detail };
  }
  return { ok: true, why: null, detail };
}

/** PURE. Is the half-ceiling alert due? Once per UTC day, when the spend has reached half the ceiling. */
export function alertDue({ spent_usd, ceiling_usd, day, state }) {
  if (!Number.isFinite(spent_usd) || spent_usd < ceiling_usd / 2) return false;
  return state?.alerted_day !== day;
}
export const alertText = ({ spent_usd, ceiling_usd, runs_today }) =>
  `${usd(spent_usd)} of ${usd(ceiling_usd)} today, ${runs_today} run${runs_today === 1 ? '' : 's'}`;

function records(cfg) {
  let ids = [];
  try {
    ids = readdirSync(cfg.records);
  } catch {
    return [];
  }
  const out = [];
  for (const id of ids) {
    const f = join(cfg.records, id, 'run.json');
    if (!existsSync(f)) continue;
    try {
      out.push({ id, rec: JSON.parse(readFileSync(f, 'utf8')) });
    } catch { /* an unreadable record is not counted */ }
  }
  return out;
}
/** What one run record spent: the sum of its per-call dollars (the bridge's total where a record has no call rows). */
export function spentOf(rec) {
  let sum = 0;
  for (const a of rec?.attempts ?? []) {
    if (Array.isArray(a.calls) && a.calls.length) { for (const c of a.calls) sum += Number(c.usd ?? 0) || 0; }
    else sum += Number(a.bridge?.computed_usd ?? 0) || 0;
  }
  return sum;
}

/** Today's spend (UTC day) from the line's own run records. Offline nothing is metered: 0, or a fixture file {"spent_usd": n}. */
export function readSpentToday(cfg, { day = utcDay() } = {}) {
  if (cfg.offline && cfg.spend_fixture) {
    try {
      const n = Number(JSON.parse(readFileSync(cfg.spend_fixture, 'utf8')).spent_usd);
      return Number.isFinite(n) ? n : NaN;
    } catch {
      return NaN;
    }
  }
  if (cfg.offline) return 0;
  let sum = 0;
  for (const { rec } of records(cfg)) {
    if ((rec.origin ?? 'mini') !== 'mini' || utcDay(rec.started ?? '') !== day) continue;
    sum += spentOf(rec);
  }
  return Number(sum.toFixed(6));
}

/** The budgets of OTHER runs still running, and how many runs started today (UTC). */
export function runsToday(cfg, { exceptId = null, day = utcDay() } = {}) {
  let committed = 0, today = 0;
  for (const { id, rec } of records(cfg)) {
    if ((rec.origin ?? 'mini') !== 'mini') continue;
    if (id !== exceptId && rec.state === 'running') committed += Number(rec.ticket?.budget?.usd ?? 0);
    if (utcDay(rec.started ?? '') === day && (rec.attempts?.length ?? 0) > 0) today++;
  }
  return { committed_usd: committed, runs_today: today };
}

const stateFile = (cfg) => join(cfg.home, 'budget-state.json');
export function readBudgetState(cfg) {
  try {
    return JSON.parse(readFileSync(stateFile(cfg), 'utf8'));
  } catch {
    return {};
  }
}
export function writeBudgetState(cfg, st) {
  const f = stateFile(cfg);
  mkdirSync(cfg.home, { recursive: true });
  writeFileSync(f + '.tmp', JSON.stringify(st, null, 1) + '\n');
  renameSync(f + '.tmp', f);
}
