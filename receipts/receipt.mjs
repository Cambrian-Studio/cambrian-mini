// receipt.mjs — every run leaves a receipt: what was asked, who approved it, what each model call cost,
// what was built and what the checks said. The receipt is a PURE projection of the run record, so anyone
// holding the record can rebuild it, and its hash (sha256 over canonical JSON) is what goes on chain.
// No I/O, no clock: the same run record always gives the same receipt and the same hash.
import { canonical, sha256Hex } from './canonical.mjs';

const round6 = (n) => Number(Number(n ?? 0).toFixed(6));
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

/** The approvals as the receipt carries them: who signed, with which passkey, and the signature itself. */
const approvalRows = (run) => (run.approvals ?? []).map((a) => pick(a, [
  'member', 'credential_id', 'ticket_sha256', 'authenticator_data', 'client_data_json', 'signature', 'at',
]));

function callRows(run) {
  const rows = [];
  for (const att of run.attempts ?? []) {
    for (const c of att.calls ?? []) {
      rows.push({
        attempt: att.n, seq: c.seq, at: c.at ?? null, model: c.model ?? null, status: c.status ?? null,
        prompt_tokens: c.prompt_tokens ?? 0, cached_tokens: c.cached_tokens ?? 0, completion_tokens: c.completion_tokens ?? 0,
        usd: c.usd == null ? null : round6(c.usd), ms: c.ms ?? null,
        chat_id: c.chat_id ?? null, request_sha256: c.request_sha256 ?? null, response_sha256: c.response_sha256 ?? null,
        attestation: c.attestation ?? null, attestation_check: c.attestation_check ?? null,
      });
    }
  }
  return rows;
}

/** run record → receipt. Throws when the record is not a finished run (a receipt is written once, at the end). */
export function buildReceipt(run) {
  if (!run || typeof run !== 'object') throw new Error('receipt: no run record');
  if (!run.finished) throw new Error('receipt: the run has not finished');
  const calls = callRows(run);
  const last = (run.attempts ?? []).at(-1) ?? null;
  const sum = (k) => calls.reduce((s, c) => s + (Number(c[k]) || 0), 0);
  const usdFromCalls = round6(calls.reduce((s, c) => s + (c.usd ?? 0), 0));
  return {
    kind: 'cambrian-receipt', v: 1,
    run_id: run.ticket?.id ?? null,
    origin: run.origin ?? 'mini',
    mode: run.mode ?? null,
    ticket: { ...pick(run.ticket ?? {}, ['id', 'title', 'product', 'branch', 'budget']), sha256: run.ticket_sha256 ?? null },
    approvals: { threshold: run.release?.threshold ?? null, valid: run.release?.valid ?? [], note: run.release?.note ?? null, signatures: approvalRows(run) },
    result: { state: run.state, green: /^green/.test(String(run.state)), attempts: (run.attempts ?? []).length, started: run.started, finished: run.finished },
    build: {
      commit: last?.commit ?? null,
      pushed: run.push?.pushed === true, ref: run.push?.ref ?? null, remote_sha: run.push?.remote_sha ?? null,
      main_before: run.main?.before ?? null, main_after: run.main?.after ?? null,
      main_untouched: run.main?.untouched ?? null,
      walls: (run.attempts ?? []).map((a) => ({ attempt: a.n, sandbox: a.sandbox?.kind ?? null, probe: a.walls ?? null })),
    },
    attempts: (run.attempts ?? []).map((a) => ({ n: a.n, commit: a.commit ?? null, green: a.green === true, failing: a.failing ?? [],
      agent: pick(a.agent ?? {}, ['kind', 'exit', 'seconds', 'model']) })),
    checks: (last?.checks ?? []).map((c) => pick(c, ['id', 'name', 'kind', 'pass', 'unverified', 'detail'])),
    preview: run.preview?.url ? { url: run.preview.url, public: run.preview.public ?? null, deployment_id: run.preview.deployment_id ?? null } : null,
    calls,
    totals: {
      calls: calls.length,
      prompt_tokens: sum('prompt_tokens'), cached_tokens: sum('cached_tokens'), completion_tokens: sum('completion_tokens'),
      usd: usdFromCalls,
      usd_recorded: run.cost?.usd == null ? null : round6(run.cost.usd),
      priced_from: run.cost?.priced_from ?? null,
      attested_calls: calls.filter((c) => c.attestation).length,
    },
    lessons: { fired: run.lessons?.fired ?? [], drafted: run.lessons?.drafted ? pick(run.lessons.drafted, ['id', 'rule']) : null },
  };
}

/** sha256 over the receipt's canonical JSON, lowercase hex. This is the value recorded on NEAR. */
export const receiptHash = (receipt) => sha256Hex(canonical(receipt));

/** Check a stored receipt against the run record it claims to come from. → {ok, why, sha256} */
export function verifyReceipt({ receipt, run, expectedSha256 = null }) {
  const sha256 = receiptHash(receipt);
  if (expectedSha256 && sha256 !== expectedSha256) return { ok: false, sha256, why: `the receipt hashes to ${sha256.slice(0, 12)}…, the record says ${String(expectedSha256).slice(0, 12)}…` };
  if (run) {
    const rebuilt = receiptHash(buildReceipt(run));
    if (rebuilt !== sha256) return { ok: false, sha256, why: 'the receipt is not what the run record produces (one of them was changed)' };
  }
  return { ok: true, sha256, why: null };
}
