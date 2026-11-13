// store.mjs — the record on disk (data/), read into the JSON the UI shows. The SAME function, snapshot(),
// feeds the running server and the static REPLAY build, so the hosted demo cannot drift from the app.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { publicCouncil, loadCouncil } from '../approvals/council.mjs';
import { verifyRelease } from '../approvals/release.mjs';
import { DAO_STATUS } from '../approvals/dao.mjs';
import { buildReceipt, receiptHash } from '../receipts/receipt.mjs';

const readJson = (file, fallback = null) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } };
export const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2) + '\n'); renameSync(`${file}.tmp`, file);
};
const dirs = (d) => (existsSync(d) ? readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort() : []);
const files = (d, ext) => (existsSync(d) ? readdirSync(d).filter((n) => n.endsWith(ext)).sort() : []);
const ID = /^[a-z0-9][a-z0-9-]{2,39}$/;

// ---- council ---------------------------------------------------------------------------------------------
/** The council file, with the site (rp id, origin) overridden when the app is served on another host. */
export function council(cfg) {
  const c = loadCouncil(cfg.files.council);
  if (cfg.rp?.id) c.rp.id = cfg.rp.id;
  if (cfg.rp?.origin && !c.rp.origins.includes(cfg.rp.origin)) c.rp.origins = [...c.rp.origins, cfg.rp.origin];
  return c;
}

// ---- tickets (briefs and their approvals) -----------------------------------------------------------------
export const ticketFile = (cfg, id) => { if (!ID.test(String(id))) throw new Error('bad ticket id'); return join(cfg.files.tickets, `${id}.json`); };
export const readTicketEntry = (cfg, id) => readJson(ticketFile(cfg, id));
export const writeTicketEntry = (cfg, entry) => writeJson(ticketFile(cfg, entry.ticket.id), entry);
/** The short public form of a brief's recorded signature: who signed, and what the server's check said. */
export const attestationSummary = (brief) => (brief?.attestation ? { kind: brief.attestation.kind ?? null,
  signing_algo: brief.attestation.signing_algo ?? null, signing_address: brief.attestation.signing_address ?? null,
  ok: brief.attestation_check?.ok === true } : null);
/** The ticket entries in data/tickets: <id>.json only. The files kept beside one (<id>.brief-response.json, …) are not entries. */
export const ticketIds = (cfg) => files(cfg.files.tickets, '.json').map((n) => n.slice(0, -5)).filter((id) => ID.test(id));
export function listTickets(cfg) {
  const c = council(cfg);
  return ticketIds(cfg).map((id) => readJson(join(cfg.files.tickets, `${id}.json`))).filter((e) => e?.ticket).map((e) => {
    const rel = verifyRelease(e.ticket, e.approvals ?? [], c);
    // the full signature stays in the file; the listing carries its summary and where the text came from
    const brief = e.brief ? { usd: e.brief.usd, model: e.brief.model, attempts: e.brief.attempts, attestation: attestationSummary(e.brief),
      ...(e.brief.attestation_note ? { attestation_note: e.brief.attestation_note } : {}) } : undefined;
    return { ...e, ...(brief ? { brief } : {}), drafted: e.ticket.drafted ?? null, ticket_sha256: rel.ticket_sha256,
      release: { ok: rel.ok, valid: rel.valid, threshold: rel.threshold, why: rel.why },
      status: e.run_started ? 'released' : rel.ok ? 'approved' : 'awaiting-approval' };
  }).sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

// ---- runs and receipts --------------------------------------------------------------------------------------
export const readRun = (cfg, id) => (ID.test(String(id)) ? readJson(join(cfg.files.runs, id, 'run.json')) : null);
export const listRuns = (cfg) => dirs(cfg.files.runs).map((id) => readRun(cfg, id)).filter(Boolean)
  .sort((a, b) => String(b.started).localeCompare(String(a.started)));

const seconds = (r) => (r.started && r.finished ? Math.round((Date.parse(r.finished) - Date.parse(r.started)) / 1000) : null);
export function runSummary(run) {
  const calls = (run.attempts ?? []).reduce((n, a) => n + (a.calls?.length ?? a.bridge?.forwarded ?? 0), 0);
  const usd = run.cost?.usd ?? (run.attempts ?? []).reduce((s, a) => s + (a.bridge?.computed_usd ?? 0), 0);
  return { id: run.ticket?.id, title: run.ticket?.title, product: run.ticket?.product, origin: run.origin ?? 'mini', mode: run.mode ?? null,
    state: run.state, waiting_on: run.waiting_on ?? null, started: run.started, finished: run.finished ?? null, seconds: seconds(run),
    attempts: (run.attempts ?? []).length, calls, usd: Number(Number(usd).toFixed(6)), stations: run.stations ?? null,
    preview_url: run.preview?.url ?? null, revision: run.revision ?? null, receipt_sha256: run.receipt_sha256 ?? null, model: run.attempts?.at(-1)?.agent?.model ?? null };
}
/** The receipt of a finished run, rebuilt from the record every time it is asked for. */
export function receiptOf(cfg, run) {
  if (!run?.finished) return null;
  const receipt = buildReceipt(run); const sha = receiptHash(receipt);
  const chainFile = join(cfg.files.runs, run.ticket.id, 'onchain.json');
  return { receipt, receipt_sha256: sha, recorded_sha256: run.receipt_sha256 ?? null, matches_record: run.receipt_sha256 ? run.receipt_sha256 === sha : null,
    origin: run.origin ?? 'mini', on_chain: readJson(chainFile),
    // onchain.json is written by the recorder: { network, contract, signer, tx_hash, receipt_sha256, recorded_at }
    on_chain_status: readJson(chainFile)?.receipt_sha256 === sha ? 'recorded in a transaction log (verify it with scripts/verify-receipt.mjs)' : 'hash computed, not yet on chain' };
}

// ---- everything the UI reads --------------------------------------------------------------------------------
/** path → JSON for every GET the UI makes. `extra` carries what only the live server knows (spend today, model). */
export function snapshot(cfg, extra = {}) {
  const out = {}; const runs = listRuns(cfg); const tickets = listTickets(cfg); const c = council(cfg);
  const live = cfg.mode === 'live';
  out['api/mode.json'] = { mode: cfg.mode, can_spend: live, can_sign: live && c.members.some((m) => m.credentials.length), reasons: cfg.reasons,
    daily_cap_usd: cfg.dailyCapUsd, exposed: cfg.exposed === true, guest_proposals: live && !cfg.exposed, chain: cfg.chain, dao: DAO_STATUS, generated_at: new Date().toISOString(), ...extra };
  out['api/council.json'] = publicCouncil(c);
  out['api/tickets.json'] = { tickets };
  out['api/runs.json'] = { runs: runs.map(runSummary) };
  const notifications = [];
  for (const run of runs) {
    const id = run.ticket.id;
    out[`api/runs/${id}.json`] = run;
    const rc = receiptOf(cfg, run); if (rc) out[`api/receipts/${id}.json`] = rc;
    for (const n of run.notifications ?? []) notifications.push({ ts: n.ts, kind: n.kind, text: n.text, run: id, origin: run.origin ?? 'mini' });
  }
  out['api/receipts.json'] = { receipts: runs.filter((r) => r.finished).map((r) => ({ ...runSummary(r), receipt_sha256: out[`api/receipts/${r.ticket.id}.json`].receipt_sha256 })) };
  out['api/notifications.json'] = { notifications: notifications.sort((a, b) => String(b.ts).localeCompare(String(a.ts))) };
  out['api/lessons.json'] = { ...readJson(cfg.files.lessons, { v: 1, lessons: [] }), drafts: readJson(join(cfg.data, 'lesson-drafts.json'), { drafts: [] }).drafts ?? [] };
  out['api/products.json'] = productsView(cfg, runs);
  out['api/stake.json'] = stakeView(cfg, runs);
  out['api/talk.json'] = readJson(cfg.files.talk, { v: 1, conversations: [] });
  return out;
}

function productsView(cfg, runs) {
  const doc = readJson(cfg.files.products, { v: 1, products: [] });
  return { ...doc, products: (doc.products ?? []).map((p) => {
    const mine = runs.filter((r) => r.ticket?.product === p.id).map(runSummary);
    return { ...p, runs: mine.map((r) => ({ id: r.id, title: r.title, state: r.state, usd: r.usd, origin: r.origin, finished: r.finished,
      preview_url: r.preview_url, revision: r.revision })),
      cost_usd: Number(mine.reduce((s, r) => s + r.usd, 0).toFixed(6)), live_url: p.live_url ?? mine.find((r) => r.preview_url && /^green/.test(r.state))?.preview_url ?? null };
  }) };
}
function stakeView(cfg, runs) {
  const doc = readJson(cfg.files.stake, { v: 1, placeholder: true });
  const sum = (origin) => Number(runs.filter((r) => (r.origin ?? 'mini') === origin).reduce((s, r) => s + runSummary(r).usd, 0).toFixed(6));
  return { ...doc, inference_spend: { ...(doc.inference_spend ?? {}), mini_line_usd: sum('mini'), private_line_usd: sum('private-line'), runs: runs.length } };
}
