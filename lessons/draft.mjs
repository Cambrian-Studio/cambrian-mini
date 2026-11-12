// draft.mjs — after a RED run, draft ONE lesson for a council member to accept or discard.
// With a `chat` function the model is asked for the lesson and its answer is validated hard;
// without one, or when the answer fails validation, the draft is derived from the failing
// checks alone. A run that did not end RED never produces a lesson.
import { SCOPES, FIXES, KNOWN_CHECKS, LESSON_ID } from './lessons.mjs';

const URL_LIKE = /https?:\/\/|www\.|\b[a-z0-9-]+\.(com|org|net|io|app|dev|xyz)\b/i;
const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : new Date().toISOString().slice(0, 10));

const lastAttempt = (run) => (Array.isArray(run?.attempts) && run.attempts.length ? run.attempts[run.attempts.length - 1] : null);
const failingChecks = (run) => {
  const a = lastAttempt(run);
  const all = Array.isArray(a?.checks) ? a.checks : [];
  const ids = new Set(Array.isArray(a?.failing) ? a.failing : all.filter((c) => c && c.pass === false).map((c) => c.id));
  return all.filter((c) => c && ids.has(c.id));
};

/** A lesson id that is unique per run: "<kind>-<ticket id>", cut to the id length. */
function lessonId(kind, run) {
  const t = String(run?.ticket?.id ?? 'run').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `${kind}-${t}`.slice(0, 41).replace(/-+$/, '');
}

/**
 * The draft a machine can make from the record alone. In order:
 *   the agent ran into the time limit            → a smaller ticket (check scope_named)
 *   a no_external_hosts check failed             → a check that can pass (check checks_can_pass)
 *   a file check failed on a file never written  → name files the task asks for (text only)
 *   anything else                                → say how each failed check passes (text only)
 */
export function deterministicDraft(run, failureLog = '') {
  const a = lastAttempt(run);
  const failing = failingChecks(run);
  const ids = failing.map((c) => c.id);
  const list = ids.length ? ids.join(', ') : 'no named check';
  const seconds = Number(a?.agent?.seconds);
  const limit = Number(run?.ticket?.budget?.minutes) * 60;
  const exit = a?.agent?.exit;
  const timedOut = exit === 142 || exit === 124 || (Number.isFinite(seconds) && Number.isFinite(limit) && limit > 0 && seconds >= limit)
    || /\b(timed out|timeout|time limit)\b/i.test(String(failureLog));
  const secs = Number.isFinite(seconds) ? `${seconds} s` : 'its time limit';
  let kind, rule, failure, check, fix, appliesTo;
  if (timedOut) {
    kind = 'timeout';
    rule = 'A ticket that ran into the time limit comes back as a smaller ticket: one feature, with the rest named as out of scope.';
    failure = `RED after ${secs}: the builder ran out of time; failing checks: ${list}.`;
    check = 'scope_named'; fix = 'refuse'; appliesTo = ['brief', 'ticket'];
  } else if (failing.some((c) => c.kind === 'no_external_hosts')) {
    kind = 'unpassable-check';
    rule = 'Name a check that can pass: a build that installs or bundles a library does not carry a no_external_hosts check.';
    failure = `RED after ${secs}: a no_external_hosts check failed; failing checks: ${list}.`;
    check = 'checks_can_pass'; fix = 'drop'; appliesTo = ['brief', 'ticket'];
  } else if (failing.some((c) => c.kind === 'file' && /does not exist/i.test(String(c.detail ?? '')))) {
    kind = 'missing-file';
    rule = 'Name a check that can pass: a file check names a file the task tells the builder to write, by the same path.';
    failure = `RED after ${secs}: a checked file was never written; failing checks: ${list}.`;
    check = null; fix = 'say'; appliesTo = ['brief', 'ticket'];
  } else {
    kind = 'red';
    rule = 'After a RED run, the next ticket for the product says how each check that failed will pass.';
    failure = `RED after ${secs}; failing checks: ${list}.`;
    check = null; fix = 'say'; appliesTo = ['brief', 'ticket'];
  }
  return {
    id: lessonId(kind, run), rule, failure, applies_to: appliesTo, check, fix,
    from_run: run?.ticket?.id ?? null, from_product: run?.ticket?.product ?? null,
    learned: day(run?.finished), status: 'drafted', drafted_by: 'rules',
  };
}

/** Hard validation of a model's answer → { ok, lesson | why }. Nothing outside these fields is kept. */
export function validateModelLesson(text) {
  const bad = (why) => ({ ok: false, why });
  if (typeof text !== 'string' || !text.trim()) return bad('empty answer');
  const body = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (!body.startsWith('{') || !body.endsWith('}')) return bad('not a single JSON object');
  let o;
  try { o = JSON.parse(body); } catch { return bad('not JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return bad('not a JSON object');
  const id = typeof o.id === 'string' ? o.id.trim() : '';
  if (!LESSON_ID.test(id)) return bad('id must be a-z 0-9 -, 2..41 characters');
  const oneLine = (v, min, max, name) => {
    if (typeof v !== 'string') return `${name} must be text`;
    const s = v.trim();
    if (s.length < min || s.length > max) return `${name} must be ${min}..${max} characters`;
    if (/[\r\n<>]/.test(s)) return `${name} must be one plain line`;
    if (URL_LIKE.test(s)) return `${name} must not carry a web address`;
    return null;
  };
  const ruleWhy = oneLine(o.rule, 20, 300, 'rule');
  if (ruleWhy) return bad(ruleWhy);
  const rule = o.rule.trim();
  if (!/^[A-Z]/.test(rule) || !/[.!]$/.test(rule) || rule.split(/\s+/).length < 5) return bad('rule must be a sentence');
  const failWhy = oneLine(o.failure, 10, 400, 'failure');
  if (failWhy) return bad(failWhy);
  if (!Array.isArray(o.applies_to) || !o.applies_to.length || !o.applies_to.every((s) => SCOPES.includes(s))) {
    return bad('applies_to must name brief, ticket or chat');
  }
  const check = o.check ?? null;
  if (check !== null && !KNOWN_CHECKS.includes(check)) return bad('check must be null or a known check name');
  const fix = o.fix ?? (check ? 'refuse' : 'say');
  if (!FIXES.includes(fix)) return bad('fix must be replace, drop, append, refuse or say');
  return { ok: true, lesson: { id, rule, failure: o.failure.trim(), applies_to: [...new Set(o.applies_to)], check, fix } };
}

function messagesFor(run, failureLog, failing) {
  const a = lastAttempt(run);
  const system = [
    'You write ONE lesson from a failed software build so the next ticket avoids the same failure.',
    'Answer with ONE JSON object and nothing else: no prose, no code fence.',
    'Fields: "id" (lowercase words joined by "-", at most 40 characters), "rule" (one or two plain sentences, at most 300',
    'characters, a general rule for future tickets, no web addresses), "failure" (what went wrong here, with the numbers,',
    'at most 400 characters), "applies_to" (a list from "brief", "ticket", "chat"), "check" (null, or one of:',
    `${KNOWN_CHECKS.join(', ')}), "fix" (one of: ${FIXES.join(', ')}).`,
  ].join(' ');
  const facts = {
    ticket: { id: run?.ticket?.id, title: run?.ticket?.title, budget: run?.ticket?.budget },
    state: run?.state,
    attempts: Array.isArray(run?.attempts) ? run.attempts.length : 0,
    agent: a?.agent ?? null,
    failing: failing.map((c) => ({ id: c.id, kind: c.kind, detail: String(c.detail ?? '').slice(0, 300) })),
  };
  const user = `The run record, reduced:\n${JSON.stringify(facts, null, 1)}\n\nThe end of the failure log:\n`
    + `${String(failureLog ?? '').slice(-3000) || '(none)'}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * Draft one lesson from a RED run.
 *   run         the run record (data/runs/<id>/run.json shape)
 *   failureLog  text from the end of the run's trace (optional)
 *   chat        async ({ model, messages, max_tokens }) → { ok, content, usd } (optional; injected)
 *   model       passed through to `chat`
 * → null when the run is not RED; otherwise
 *   { id, rule, failure, applies_to, check, fix, from_run, from_product, learned, status: "drafted",
 *     drafted_by: "model" | "rules", model_note? (why the model's answer was not used), usd? }
 */
export async function draftLesson({ run, failureLog = '', chat = null, model = undefined } = {}) {
  if (!run || run.state !== 'red') return null;
  const fallback = deterministicDraft(run, failureLog);
  if (typeof chat !== 'function') return fallback;
  let answer;
  try {
    answer = await chat({ model, messages: messagesFor(run, failureLog, failingChecks(run)), max_tokens: 500 });
  } catch (e) {
    return { ...fallback, model_note: `the model call failed (${String(e?.message ?? e).slice(0, 120)})` };
  }
  const spent = Number.isFinite(answer?.usd) ? { usd: answer.usd } : {};
  if (!answer || answer.ok === false) return { ...fallback, ...spent, model_note: 'the model did not answer' };
  const v = validateModelLesson(answer.content);
  if (!v.ok) return { ...fallback, ...spent, model_note: `the model's answer was not used: ${v.why}` };
  return {
    ...v.lesson,
    from_run: fallback.from_run, from_product: fallback.from_product, learned: fallback.learned,
    status: 'drafted', drafted_by: 'model', ...spent,
  };
}
