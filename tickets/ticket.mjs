// ticket.mjs — the build ticket: one JSON object that names a product, the task, what GREEN means
// (a list of checks) and a budget. PURE: no I/O.
//
// What a ticket can NOT say is as important as what it can: there is no repository, no path on the
// build machine and no host in it. The line resolves the product's one repository itself, and every
// path in a check is relative and stays inside the clone. An unknown key is refused, so a ticket
// cannot smuggle in a field that some later reader might honour.
import { canonical, sha256Hex } from '../receipts/canonical.mjs';

export const TICKET_ID = /^[a-z0-9][a-z0-9-]{2,39}$/;
export const MAX_TICKET_BYTES = 64 * 1024;
const DEFAULT_CAP_USD = 5;
const CHECK_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CTRL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/; // tab, newline and carriage return are text; the rest are not
const KINDS = ['run', 'file', 'no_external_hosts'];
const TICKET_KEYS = ['kind', 'v', 'id', 'product', 'title', 'task', 'goal', 'out_of_scope', 'green', 'budget', 'base', 'branch', 'drafted', 'revision'];
const REVISION_KINDS = ['design-pass', 'fix', 'feature'];
const HEX64 = /^[0-9a-f]{64}$/;

/** The daily cap in USD: 5, unless the environment raises it. It is also the most one ticket may carry. */
export function budgetCapUsd(env = process.env) {
  const raised = Number(env.CAMBRIAN_DAILY_CAP_USD);
  return Number.isFinite(raised) && raised > DEFAULT_CAP_USD ? raised : DEFAULT_CAP_USD;
}
export const budgetCeiling = (env = process.env) => ({ usd: budgetCapUsd(env), calls: 120, minutes: 45 });
export function branchOf(id) {
  return `build/${id}`;
}
/** sha256 over the ticket's canonical JSON. The council signs this hash. */
export function ticketHash(ticket) {
  return sha256Hex(canonical(ticket));
}

const str = (v, what, { min = 1, max = 200, multiline = false } = {}) => {
  if (typeof v !== 'string') throw new Error(`${what}: a string is required`);
  if (v.length < min || v.length > max) throw new Error(`${what}: ${v.length} characters, wanted ${min}..${max}`);
  if (CTRL.test(v) || (!multiline && /[\n\r\t]/.test(v))) throw new Error(`${what}: control characters not permitted`);
  return v;
};
const relPath = (v, what) => {
  str(v, what, { max: 300 });
  const escapes = v.startsWith('/') || v.includes('\\') || v.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (escapes) throw new Error(`${what}: a relative path inside the repository, no '..' (got ${JSON.stringify(v)})`);
  return v;
};
const regex = (v, what) => {
  str(v, what, { max: 300 });
  try {
    new RegExp(v);
  } catch (e) {
    throw new Error(`${what}: not a regular expression (${e.message})`);
  }
  return v;
};
const list = (v, what, each, max = 20) => {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length < 1 || v.length > max) throw new Error(`${what}: a list of 1..${max}`);
  return v.map((x, i) => each(x, `${what}[${i}]`));
};
const only = (o, keys, what) => {
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${what}: unknown key '${k}' (known: ${keys.join(', ')})`);
};

function parseRunCheck(c, at, out) {
  only(c, ['id', 'kind', 'name', 'run', 'exit', 'network', 'timeout_s', 'stdout_matches', 'stdout_not_matches'], at);
  out.run = str(c.run, `${at}.run`, { max: 2000, multiline: true });
  out.exit = c.exit === undefined ? 0 : c.exit;
  if (!Number.isInteger(out.exit) || out.exit < 0 || out.exit > 255) throw new Error(`${at}.exit: an exit code 0..255`);
  out.network = c.network === undefined ? 'none' : c.network;
  if (!['none', 'registry'].includes(out.network)) throw new Error(`${at}.network: 'none' or 'registry' (registry.npmjs.org only)`);
  out.timeout_s = c.timeout_s === undefined ? 300 : c.timeout_s;
  if (!Number.isInteger(out.timeout_s) || out.timeout_s < 1 || out.timeout_s > 600) throw new Error(`${at}.timeout_s: 1..600`);
  if (c.stdout_matches !== undefined) out.stdout_matches = regex(c.stdout_matches, `${at}.stdout_matches`);
  if (c.stdout_not_matches !== undefined) out.stdout_not_matches = regex(c.stdout_not_matches, `${at}.stdout_not_matches`);
}

function parseFileCheck(c, at, out) {
  only(c, ['id', 'kind', 'name', 'path', 'exists', 'contains', 'matches', 'not_matches', 'count'], at);
  out.path = relPath(c.path, `${at}.path`);
  out.exists = c.exists === undefined ? true : c.exists;
  if (typeof out.exists !== 'boolean') throw new Error(`${at}.exists: true or false`);
  const contains = list(c.contains, `${at}.contains`, (x, w) => str(x, w, { max: 500, multiline: true }));
  if (contains) out.contains = contains;
  const matches = list(c.matches, `${at}.matches`, regex);
  if (matches) out.matches = matches;
  const not = list(c.not_matches, `${at}.not_matches`, regex);
  if (not) out.not_matches = not;
  if (c.count !== undefined) {
    if (!c.count || typeof c.count !== 'object' || Array.isArray(c.count)) throw new Error(`${at}.count: {pattern, equals}`);
    only(c.count, ['pattern', 'equals'], `${at}.count`);
    if (!Number.isInteger(c.count.equals) || c.count.equals < 0 || c.count.equals > 100000) {
      throw new Error(`${at}.count.equals: a whole number`);
    }
    out.count = { pattern: regex(c.count.pattern, `${at}.count.pattern`), equals: c.count.equals };
  }
  if (!out.exists && (out.contains || out.matches || out.not_matches || out.count)) {
    throw new Error(`${at}: exists:false takes no content conditions`);
  }
}

function parseCheck(c, i) {
  const at = `green[${i}]`;
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error(`${at}: an object is required`);
  if (typeof c.id !== 'string' || !CHECK_ID.test(c.id)) throw new Error(`${at}.id: a-z 0-9 -, 1..32 characters`);
  if (!KINDS.includes(c.kind)) throw new Error(`${at}.kind: one of ${KINDS.join(', ')}`);
  const out = { id: c.id, kind: c.kind, name: str(c.name ?? c.id, `${at}.name`, { max: 120 }) };
  if (c.kind === 'run') parseRunCheck(c, at, out);
  else if (c.kind === 'file') parseFileCheck(c, at, out);
  else {
    only(c, ['id', 'kind', 'name', 'dir'], at);
    out.dir = relPath(c.dir, `${at}.dir`);
  }
  return out;
}

// Where the ticket's text came from: the model call that drafted it. It is part of the ticket, so the
// ticket hash (and with it every approval) covers the hash of that model response.
function parseDrafted(d) {
  const at = 'build ticket: drafted';
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error(`${at} — {model, completion_id, request_sha256, response_sha256}`);
  only(d, ['model', 'completion_id', 'request_sha256', 'response_sha256'], at);
  for (const k of ['request_sha256', 'response_sha256']) {
    if (typeof d[k] !== 'string' || !HEX64.test(d[k])) throw new Error(`${at}.${k}: 64 lowercase hex characters`);
  }
  return { model: str(d.model, `${at}.model`, { max: 120 }), completion_id: str(d.completion_id, `${at}.completion_id`),
    request_sha256: d.request_sha256, response_sha256: d.response_sha256 };
}

// A revision names the build it revises, what kind of change it is, who asked for it, and the images kept
// with it (by hash). It is part of the ticket, so the council's signatures cover it.
function parseRevision(r, product) {
  const at = 'build ticket: revision';
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Error(`${at} — {of, kind, by, product, attachments?}`);
  only(r, ['of', 'kind', 'by', 'product', 'attachments'], at);
  if (typeof r.of !== 'string' || !TICKET_ID.test(r.of)) throw new Error(`${at}.of: the id of the build it revises`);
  if (!REVISION_KINDS.includes(r.kind)) throw new Error(`${at}.kind: one of ${REVISION_KINDS.join(', ')}`);
  if (typeof r.by !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(r.by)) throw new Error(`${at}.by: a member id`);
  if (r.product !== product) throw new Error(`${at}.product: must be the ticket's own product`);
  const out = { of: r.of, kind: r.kind, by: r.by, product };
  if (r.attachments !== undefined) {
    if (!Array.isArray(r.attachments) || r.attachments.length < 1 || r.attachments.length > 3) throw new Error(`${at}.attachments: 1..3 images`);
    out.attachments = r.attachments.map((a, i) => {
      if (!a || typeof a !== 'object') throw new Error(`${at}.attachments[${i}]: {type, bytes, sha256}`);
      only(a, ['type', 'bytes', 'sha256'], `${at}.attachments[${i}]`);
      if (!['png', 'jpeg'].includes(a.type)) throw new Error(`${at}.attachments[${i}].type: png or jpeg`);
      if (!Number.isInteger(a.bytes) || a.bytes < 1 || a.bytes >= 5 * 1024 * 1024) throw new Error(`${at}.attachments[${i}].bytes: under 5 MB`);
      if (typeof a.sha256 !== 'string' || !HEX64.test(a.sha256)) throw new Error(`${at}.attachments[${i}].sha256: 64 lowercase hex characters`);
      return { type: a.type, bytes: a.bytes, sha256: a.sha256 };
    });
  }
  return out;
}

function toObject(input) {
  if (input && typeof input === 'object' && !Buffer.isBuffer(input) && !(input instanceof Uint8Array)) return input;
  const buf = Buffer.isBuffer(input) || input instanceof Uint8Array ? Buffer.from(input) : Buffer.from(String(input ?? ''), 'utf8');
  if (buf.length === 0) throw new Error('build ticket: empty');
  if (buf.length > MAX_TICKET_BYTES) throw new Error(`build ticket: ${buf.length} bytes, limit ${MAX_TICKET_BYTES}`);
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    throw new Error(`build ticket: not JSON (${e.message})`);
  }
}

/**
 * A ticket as bytes (Buffer or string) or as an object → the validated ticket, or throws naming the first fault.
 * `id`, when given, must be the ticket's own id (a caller that stores tickets by name passes the name).
 * Parsing a parsed ticket gives the same ticket back, so its hash is stable.
 */
export function parseTicket(input, id = undefined) {
  const t = toObject(input);
  if (!t || typeof t !== 'object' || Array.isArray(t)) throw new Error('build ticket: a JSON object is required');
  if (Buffer.byteLength(JSON.stringify(t), 'utf8') > MAX_TICKET_BYTES) {
    throw new Error(`build ticket: larger than ${MAX_TICKET_BYTES} bytes`);
  }
  only(t, TICKET_KEYS, 'build ticket');
  if (t.kind !== 'build-ticket') throw new Error(`build ticket: kind must be "build-ticket" (got ${JSON.stringify(t.kind ?? null)})`);
  if (t.v !== 1) throw new Error(`build ticket: v must be 1 (got ${JSON.stringify(t.v ?? null)})`);
  if (typeof t.id !== 'string' || !TICKET_ID.test(t.id)) throw new Error('build ticket: id — a-z 0-9 -, 3..40 characters');
  if (id !== undefined && id !== null && t.id !== id) {
    throw new Error(`build ticket: id ${JSON.stringify(t.id)} is not the expected '${id}'`);
  }
  if (typeof t.product !== 'string' || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(t.product)) {
    throw new Error('build ticket: product — a product id (a-z 0-9 -)');
  }
  const base = t.base === undefined ? 'main' : t.base;
  if (base !== 'main') throw new Error('build ticket: base must be "main" — a run starts from the product\'s main and never writes it');
  const branch = branchOf(t.id);
  if (t.branch !== undefined && t.branch !== branch) {
    throw new Error(`build ticket: branch must be "${branch}" — the line writes that branch only`);
  }
  const title = str(t.title ?? t.id, 'build ticket: title', { max: 72 });
  const task = str(t.task, 'build ticket: task', { min: 20, max: 20000, multiline: true });
  const goal = t.goal === undefined ? undefined : str(t.goal, 'build ticket: goal', { max: 500, multiline: true });
  const outOfScope = list(t.out_of_scope, 'build ticket: out_of_scope', (x, w) => str(x, w, { max: 200 }));
  if (!Array.isArray(t.green) || t.green.length < 1 || t.green.length > 20) {
    throw new Error('build ticket: green — a list of 1..20 checks; a ticket with no check cannot be green');
  }
  const green = t.green.map(parseCheck);
  const seen = new Set();
  for (const c of green) {
    if (seen.has(c.id)) throw new Error(`build ticket: green — check id '${c.id}' appears twice`);
    seen.add(c.id);
  }
  const b = t.budget;
  const cap = budgetCeiling();
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('build ticket: budget — {usd, calls, minutes}');
  only(b, ['usd', 'calls', 'minutes'], 'build ticket: budget');
  if (typeof b.usd !== 'number' || !Number.isFinite(b.usd) || b.usd <= 0 || b.usd > cap.usd) {
    throw new Error(`build ticket: budget.usd — above 0, at most ${cap.usd} (the daily cap)`);
  }
  const calls = b.calls === undefined ? 60 : b.calls;
  if (!Number.isInteger(calls) || calls < 1 || calls > cap.calls) throw new Error(`build ticket: budget.calls — 1..${cap.calls}`);
  const minutes = b.minutes === undefined ? 25 : b.minutes;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > cap.minutes) {
    throw new Error(`build ticket: budget.minutes — 1..${cap.minutes}`);
  }
  const drafted = t.drafted === undefined ? undefined : parseDrafted(t.drafted);
  const revision = t.revision === undefined ? undefined : parseRevision(t.revision, t.product);
  return {
    kind: 'build-ticket',
    v: 1,
    id: t.id,
    product: t.product,
    title,
    task,
    ...(goal !== undefined ? { goal } : {}),
    ...(outOfScope ? { out_of_scope: outOfScope } : {}),
    green,
    budget: { usd: b.usd, calls, minutes },
    base,
    branch,
    ...(drafted ? { drafted } : {}),
    ...(revision ? { revision } : {}),
  };
}
