// run.mjs — ONE RUN of one build ticket. What happens, in order, each step asserting what is now true:
//
//   release     verifyRelease(ticket, approvals, council) — first thing. Not released → "refused": nothing runs.
//   preflight   the daily ceiling; a sandbox exists; the tools are there; live: the key file, the model's price
//   worktree    a fresh clone of the product's repository (no checkout), a linked worktree on build/<id> from main
//   attempt 1   the wall probe (both directions) → the agent, behind the wall, through the bridge → the harness
//               commits → the ticket's checks on a fresh clone. RED → attempt 2 with the findings. RED again → stop.
//   GREEN       verifyRelease AGAIN → push build/<id> (never main, never forced) → read main back, untouched →
//               build the static output once more from the commit, keep a copy with the record → deploy the preview
//
// The agent never sees a key, and nothing outside its worktree (kit/sandbox.mjs; proven per attempt by the probe).
// Everything the run knows is in <records>/<id>/run.json, written atomically after every step; a run that stops
// for a person says why in `waiting_on` and in a notification.
import { spawn } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { connect, createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { KIT } from './config.mjs';
import { ensureProductRepo, git, pushBranch, remoteRef, tokenState } from './github.mjs';
import { greenMessage, redMessage, waitingMessage } from './messages.mjs';
import { alertDue, alertText, ceilingDecision, readBudgetState, readSpentToday, runsToday, utcDay, writeBudgetState } from './budget.mjs';
import { inSandbox, manifest, runChecks, runProcess, wallEnv } from './checks.mjs';
import { notify } from './notify.mjs';
import { needsSockets, sandboxAvailable } from './kit/sandbox.mjs';
import { deployPreview, OUTPUT_KEEP_BYTES, outputFiles } from './vercel.mjs';
import { parseTicket, TICKET_ID, ticketHash } from '../tickets/ticket.mjs';
import { canonical, sha256Hex } from '../receipts/canonical.mjs';
import { verifyRelease } from '../approvals/release.mjs';

const NODE = process.execPath;
const PRICED_FROM = 'NEAR AI /v1/models pricing × usage';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const optional = (path) => import(path).catch(() => null); // a module another part of the repository provides; absent = do without

const dial = (host, port, ms) =>
  new Promise((res) => {
    const s = connect({ host, port }, () => {
      s.destroy();
      res(true);
    });
    s.on('error', () => res(false));
    s.setTimeout(ms, () => {
      s.destroy();
      res(false);
    });
  });
async function waitPort(port, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await dial('127.0.0.1', port, 500)) return true;
    await sleep(100);
  }
  return false;
}
const freePort = () =>
  new Promise((res, rej) => {
    const s = createServer();
    s.once('error', rej);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
const jsonLines = (file) => {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch { /* no trace */ }
  return text.split('\n').filter(Boolean).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
};

/** The ticket as the agent reads it: the task, every check in words, the rules of the room, and last time's findings. */
function ticketText(t, findings) {
  const line = (c) => {
    if (c.kind === 'run') {
      const net = c.network === 'registry' ? ' (registry.npmjs.org reachable)' : ' (no network)';
      return `\`${c.id}\` ${c.name} — the command \`${c.run.replace(/\n/g, ' ; ')}\` must exit ${c.exit}${net}${
        c.stdout_matches ? `, output matching /${c.stdout_matches}/` : ''
      }`;
    }
    if (c.kind === 'file') {
      return `\`${c.id}\` ${c.name} — the file \`${c.path}\` ${c.exists ? 'exists' : 'does not exist'}` +
        (c.contains ? `, contains ${c.contains.map((s) => JSON.stringify(s)).join(' and ')}` : '') +
        (c.matches ? `, matches ${c.matches.map((r) => `/${r}/`).join(' and ')}` : '') +
        (c.not_matches ? `, matches none of ${c.not_matches.map((r) => `/${r}/`).join(', ')}` : '') +
        (c.count ? `, /${c.count.pattern}/ occurs exactly ${c.count.equals} time(s)` : '');
    }
    return `\`${c.id}\` ${c.name} — nothing under \`${c.dir}/\` names another host (no http:// or https:// anywhere in it)`;
  };
  return [
    `# Ticket ${t.id}: ${t.title}`,
    '',
    t.task.trim(),
    '',
    ...(t.goal ? ['## Why', '', t.goal.trim(), ''] : []),
    ...(t.out_of_scope?.length ? ['## Out of scope', '', ...t.out_of_scope.map((s) => `- ${s}`), ''] : []),
    '## Checked after you stop',
    '',
    'All of these must hold. They run in this order on a fresh clone of the files you leave here:',
    '',
    ...t.green.map((c) => `- ${line(c)}`),
    '',
    '## The room you are in',
    '',
    '- You are working unattended; nobody will answer questions. Decide, build, verify, then stop and say in three lines what you built.',
    '- Write nothing outside this directory. Git is read-only for you here: do not commit — ' +
      'the harness commits your files when you stop.',
    '- `registry.npmjs.org` is the only host you can reach; every other host is refused.',
    '- `.oc/` is scratch space and is never committed.',
    ...(findings
      ? [
        '',
        '## Your previous attempt failed',
        '',
        'The files you left are still here. These checks failed; fix exactly these and leave the rest working:',
        '',
        ...findings.map((f) => `- \`${f.id}\` ${f.name} — ${f.detail}`),
      ]
      : []),
    '',
  ].join('\n');
}

const SECRET_SHAPES = [
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a GitHub token', /\b(?:gh[pous]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['an API key (sk-…)', /\bsk-[A-Za-z0-9_-]{32,}/],
  ['an AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['a Slack token', /\bxox[baprs]-[A-Za-z0-9-]{10,}/],
  ['a NEAR secret key', /\bed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
];
/** The staged files, scanned for things shaped like secrets. Fail closed: a file that cannot be read refuses the commit. */
function secretScan(wt) {
  const names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], { cwd: wt });
  if (names.code !== 0) return { ok: false, why: `the staged files could not be listed (${names.err})` };
  for (const rel of names.out.split('\0').filter(Boolean)) {
    const p = join(wt, rel);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      return { ok: false, why: `${rel} could not be read for the secret scan` };
    }
    if (!st.isFile() || st.size > 2e6) continue;
    const text = readFileSync(p, 'latin1');
    for (const [what, re] of SECRET_SHAPES) if (re.test(text)) return { ok: false, why: `${rel} holds what looks like ${what}` };
  }
  return { ok: true, why: null };
}

/**
 * The harness's commit: stage everything the agent left, scan it for secrets (built in; gitleaks too where it is
 * installed), hooks off — no hook may run on a tree an agent wrote. An attempt that changed nothing commits
 * nothing and reports the branch's head.
 */
async function commit(cfg, wt, message) {
  const a = git(['add', '-A'], { cwd: wt });
  if (a.code !== 0) return { ok: false, why: `git add: ${a.err}` };
  const head = () => git(['rev-parse', 'HEAD'], { cwd: wt }).out;
  if (git(['diff', '--cached', '--quiet'], { cwd: wt }).code === 0) return { ok: true, sha: head(), empty: true };
  const scan = secretScan(wt);
  if (!scan.ok) return { ok: false, why: `the secret scan refused the commit: ${scan.why}` };
  const gl = await runProcess('gitleaks', ['git', '--staged', '--redact', '--no-banner'], {
    cwd: wt,
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/var/empty' },
  });
  if (!gl.error && gl.status !== 0) return { ok: false, why: 'gitleaks found staged secrets — refusing' };
  const who = ['-c', `user.name=${cfg.commit_name}`, '-c', `user.email=${cfg.commit_email}`];
  const c = git([...who, 'commit', '-q', '-m', message], { cwd: wt });
  if (c.code !== 0) return { ok: false, why: `git commit: ${c.err}` };
  return { ok: true, sha: head(), empty: false };
}

/** One row per forwarded model call, from the bridge's trace. No message text is in the trace, so none is here. */
function callRows(traceFile) {
  return jsonLines(traceFile).filter((l) => l.kind === 'model' && !l.refused).map((l) => ({
    seq: l.seq,
    at: l.t,
    model: l.model_served ?? l.model_asked ?? null,
    prompt_tokens: l.usage?.prompt_tokens ?? 0,
    cached_tokens: l.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completion_tokens: l.usage?.completion_tokens ?? 0,
    usd: l.usd ?? null,
    ms: l.ms ?? null,
    status: l.status ?? null,
    chat_id: l.chat_id ?? null,
    request_sha256: l.request_sha256 ?? null,
    response_sha256: l.response_sha256 ?? null,
    attestation: null,
  }));
}

/**
 * Ask NEAR AI for the signature of each call and bind it to the request and response hashes the bridge recorded.
 * The TEE report (taken once, before the first call) is stored once beside the record; each row keeps the
 * attestation with the report replaced by its hash, and what the offline verifier says about it.
 * A lookup that fails leaves `attestation: null` with a note. It never fails the build.
 */
// Signatures are asked for as secp256k1 ("ecdsa"): the signer is then an Ethereum-style address anyone can recover.
const SIGNING_ALGO = 'ecdsa';
async function attest({ cfg, near, calls, report, recDir, fetchImpl }) {
  const todo = calls.filter((c) => c.status === 200 && c.chat_id);
  let got = 0, next = 0;
  const note = (c, why) => {
    c.attestation = null;
    c.attestation_note = String(why).slice(0, 200);
  };
  if (typeof near?.fetchAttestation !== 'function') {
    for (const c of todo) note(c, 'no attestation client (near/nearai.mjs)');
    return 0;
  }
  const keep = (rep) => {
    if (!rep) return;
    const first = join(recDir, 'attestation-report.json');
    const text = JSON.stringify(rep, null, 1) + '\n';
    if (!existsSync(first)) return writeFileSync(first, text);
    if (readFileSync(first, 'utf8') !== text) {
      writeFileSync(join(recDir, `attestation-report-${sha256Hex(JSON.stringify(rep)).slice(0, 12)}.json`), text);
    }
  };
  const worker = async () => {
    while (next < todo.length) {
      const c = todo[next++];
      try {
        const lookup = near.fetchAttestation({
          signingAlgo: SIGNING_ALGO,
          chatId: c.chat_id,
          model: cfg.model,
          requestSha256: c.request_sha256,
          responseSha256: c.response_sha256,
          keyFile: cfg.nearai_key_file,
          base: cfg.nearai_base,
          fetchImpl,
          ...(report ? { report } : {}),
        });
        let timer;
        const slow = new Promise((r) => {
          timer = setTimeout(() => r('timeout'), 45_000);
        });
        const a = await Promise.race([lookup, slow]).finally(() => clearTimeout(timer));
        if (a === 'timeout') {
          note(c, 'the signature lookup took too long');
          continue;
        }
        if (!a || typeof a !== 'object') {
          note(c, 'NEAR AI has no signature for this call');
          continue;
        }
        const d = typeof near.detachReport === 'function' ? near.detachReport(a) : { att: a, report: null };
        keep(d.report);
        c.attestation = d.att;
        got++;
        if (typeof near.verifyAttestation === 'function') {
          const v = near.verifyAttestation(d.att, { requestSha256: c.request_sha256, responseSha256: c.response_sha256, report: d.report });
          c.attestation_check = { ok: v.ok, checks: v.checks, ...(v.why ? { why: v.why } : {}) };
        }
      } catch (e) {
        note(c, `the signature lookup failed: ${e.message}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return got;
}

/**
 * Run one ticket. The caller has claimed the run (dispatch.mjs: a ticket id runs once).
 * input: { ticket, approvals, council, lessonsFired? }
 * options: log(id, line); fetchImpl; onUpdate(rec) after every save; onRed(rec, failureLog) when a run ends red — it may
 *          return a drafted lesson {id, rule}, which is stored in rec.lessons.drafted; near (a stand-in for near/nearai.mjs, for tests).
 * → the run record (also at <cfg.records>/<id>/run.json)
 */
export async function runTicket(
  cfg,
  { ticket, approvals = [], council, lessonsFired = [] },
  { log = () => {}, fetchImpl = fetch, onUpdate = null, onRed = null, near = undefined } = {},
) {
  if (!ticket || !TICKET_ID.test(String(ticket.id ?? ''))) throw new Error('runTicket: the ticket has no valid id');
  const recDir = join(cfg.records, ticket.id), workDir = join(cfg.home, 'runs-work', ticket.id);
  mkdirSync(cfg.scratch, { recursive: true });
  const scratchRoot = realpathSync(cfg.scratch); // real paths: the macOS sandbox matches those only
  const scratch = join(scratchRoot, ticket.id), repoDir = join(scratch, 'repo'), wt = join(scratch, 'wt');
  mkdirSync(recDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const started = now();
  const rec = {
    v: 1,
    origin: 'mini',
    mode: cfg.offline ? 'offline' : 'live',
    ticket: {
      id: ticket.id,
      title: ticket.title,
      product: ticket.product,
      branch: ticket.branch,
      budget: ticket.budget,
      checks: (ticket.green ?? []).map((c) => c?.id),
    },
    ticket_sha256: null,
    approvals: Array.isArray(approvals) ? approvals : [],
    release: { ok: false, valid: [], threshold: council?.threshold ?? null },
    state: 'running',
    waiting_on: null,
    started,
    finished: null,
    stations: { brief: { at: started } },
    budget: null,
    attempts: [],
    main: { before: null, after: null, untouched: null },
    push: { pushed: false },
    preview: null,
    cost: null,
    lessons: { fired: Array.isArray(lessonsFired) ? lessonsFired : [], drafted: null },
    notifications: [],
    receipt_sha256: null,
  };
  // the exact ticket this run answers to is kept beside its record, so the approvals can be re-checked later
  writeFileSync(join(recDir, 'ticket.json'), JSON.stringify(ticket, null, 1) + '\n');
  const save = () => {
    writeFileSync(join(recDir, 'run.json.tmp'), JSON.stringify(rec, null, 1) + '\n');
    renameSync(join(recDir, 'run.json.tmp'), join(recDir, 'run.json'));
    if (onUpdate) {
      try {
        onUpdate(JSON.parse(JSON.stringify(rec)));
      } catch { /* a listener never stops a run */ }
    }
  };
  const say = (m) => {
    log(ticket.id, m);
    appendFileSync(join(workDir, 'run.log'), `${now()}  ${m}\n`);
  };
  const tell = async (kind, message) => {
    const r = await notify(cfg, kind, message, { fetchImpl });
    rec.notifications.push({ ts: now(), kind, text: r.text, html: r.html, sent: r.sent, via: r.via, ...(r.why ? { why: r.why } : {}) });
    say(`notify ${kind}: ${r.sent ? 'sent' : 'NOT SENT — ' + r.why} (${r.via})`);
    save();
    return r;
  };
  const totalCost = () => {
    const calls = rec.attempts.flatMap((a) => a.calls ?? []);
    const usd = rec.attempts.reduce(
      (s, a) => s + (a.calls?.length ? a.calls.reduce((x, c) => x + (c.usd ?? 0), 0) : (a.bridge?.computed_usd ?? 0)),
      0,
    );
    return { usd: Number(usd.toFixed(6)), calls: calls.length, priced_from: PRICED_FROM };
  };
  const finish = async (state, { waiting = null, green = null } = {}) => {
    rec.state = state;
    rec.waiting_on = waiting;
    rec.finished = now();
    rec.cost = totalCost();
    save();
    say(`STATE ${state}${waiting ? ' — waiting on a person: ' + waiting : ''}`);
    if (green) await tell('GREEN', greenMessage({ rec, ticket, ...green }));
    else if (state === 'red') await tell('RED', redMessage({ rec, ticket, waiting }));
    else if (waiting) await tell('WAITING', waitingMessage({ rec, ticket, state, waiting }));
    if (state === 'red' && onRed) {
      const last = rec.attempts.at(-1);
      const failureLog = [
        `${ticket.id}: ${waiting ?? 'red'}`,
        ...(last?.checks ?? []).filter((c) => !c.pass)
          .map((c) => `${c.unverified ? 'UNVERIFIED' : 'FAIL'} ${c.id} (${c.kind}) ${c.name} — ${c.detail}`),
      ].join('\n');
      try {
        const draft = await onRed(JSON.parse(JSON.stringify(rec)), failureLog);
        if (draft && typeof draft === 'object' && draft.id && draft.rule) {
          rec.lessons.drafted = { id: draft.id, rule: draft.rule, from_run: draft.from_run ?? ticket.id };
        }
      } catch (e) {
        say(`onRed hook failed: ${String(e.message).slice(0, 160)}`);
      }
    }
    // the receipt: a pure projection of this record; its hash is what is later recorded on NEAR
    const receipts = await optional('../receipts/receipt.mjs');
    if (receipts?.buildReceipt && receipts?.receiptHash) {
      try {
        const sha256 = receipts.receiptHash(receipts.buildReceipt(rec));
        rec.receipt_sha256 = sha256;
        rec.stations.receipt = { at: now(), sha256 };
      } catch (e) {
        say(`receipt not built: ${String(e.message).slice(0, 160)}`);
      }
    }
    save();
    return rec;
  };
  const budgetAlert = async (spent, runsCount) => {
    const day = utcDay();
    const st = readBudgetState(cfg);
    if (!alertDue({ spent_usd: spent, ceiling_usd: cfg.daily_ceiling_usd, day, state: st })) return;
    const r = await tell('BUDGET', alertText({ spent_usd: spent, ceiling_usd: cfg.daily_ceiling_usd, runs_today: runsCount }));
    writeBudgetState(cfg, { alerted_day: day, alerted_at: now(), spent_usd: spent, sent: r.sent });
  };
  let bridge = null, sockDir = null;
  const stopBridge = async () => {
    if (!bridge) return;
    const b = bridge;
    bridge = null;
    b.kill();
    await new Promise((r) => {
      b.once('exit', r);
      setTimeout(r, 2000);
    });
  };
  /** Start a bridge for this attempt. model: {maxCalls, maxUsd, pricing} for the agent's bridge; null = the tunnel only. */
  const startBridge = async (aDir, name, ports, model) => {
    const secretFile = join(aDir, `${name}-secret`);
    writeFileSync(secretFile, `run-${randomBytes(16).toString('hex')}`, { mode: 0o600 });
    const args = [
      join(KIT, 'bridge.mjs'),
      '--secret-file',
      secretFile,
      '--trace',
      join(aDir, `${name}-trace.jsonl`),
      '--port',
      String(ports.bridgePort),
      '--proxy-port',
      String(ports.proxyPort),
      '--session',
      `${name}-${ticket.id}`,
    ];
    if (ports.sockDir) args.push('--unix-dir', ports.sockDir);
    if (model) {
      args.push(
        '--base',
        cfg.nearai_base,
        '--key-file',
        cfg.nearai_key_file,
        '--pricing',
        model.pricing,
        '--model',
        cfg.model,
        '--max-calls',
        String(model.maxCalls),
        '--max-usd',
        String(Math.max(0, model.maxUsd).toFixed(4)),
      );
    }
    bridge = spawn(NODE, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    bridge.stderr.on('data', (d) => {
      err += d;
    });
    const up = (await waitPort(ports.bridgePort)) && (await waitPort(ports.proxyPort));
    if (!up) await stopBridge();
    return { up, secretFile, why: err.trim().slice(0, 160) || 'no answer' };
  };
  save();

  try {
    // ---- the release: before anything else ----------------------------------------------------------------------------------
    let parsed = null, fault = null;
    try {
      parsed = parseTicket(ticket);
    } catch (e) {
      fault = e.message;
    }
    if (!fault && canonical(parsed) !== canonical(ticket)) {
      fault = 'the ticket is not in its validated form (parse it with tickets/ticket.mjs before it is signed)';
    }
    if (fault) return await finish('refused', { waiting: `not a valid ticket: ${fault}. Nothing ran.` });
    rec.ticket_sha256 = ticketHash(ticket);
    const release = verifyRelease(ticket, approvals, council);
    rec.release = { ok: release.ok, valid: release.valid ?? [], threshold: council?.threshold ?? null };
    say(
      `run start: ticket ${ticket.id} (${ticket.product}) → ${ticket.branch}, ${ticket.green.length} check(s), ` +
        `budget $${ticket.budget.usd} / ` +
        `${ticket.budget.calls} calls / ${ticket.budget.minutes} min; ticket ${rec.ticket_sha256.slice(0, 12)}; ${rec.mode}`,
    );
    if (!release.ok) return await finish('refused', { waiting: `not released by the council: ${release.why}. Nothing ran.` });
    rec.stations.approved = { at: now() };
    say(
      `released: ${rec.release.valid.join(', ')} (${rec.release.valid.length} of ${council.members.length}, ${council.threshold} needed)`,
    );
    save();

    // ---- preflight: every refusal here is before any model call and before any write to a repository --------------------------
    {
      const day = utcDay();
      const spent = readSpentToday(cfg);
      const others = runsToday(cfg, { exceptId: ticket.id, day });
      const dec = ceilingDecision({
        spent_usd: spent,
        committed_usd: others.committed_usd,
        ticket_usd: ticket.budget.usd,
        ceiling_usd: cfg.daily_ceiling_usd,
        day,
      });
      rec.budget = {
        day,
        ceiling_usd: cfg.daily_ceiling_usd,
        spent_usd_at_start: Number.isFinite(spent) ? spent : null,
        ticket_usd: ticket.budget.usd,
        decision: dec.ok ? 'ok' : 'blocked',
        detail: dec.detail,
      };
      say(`budget: ${dec.detail}${dec.ok ? '' : ' — BLOCKED by the daily ceiling'}`);
      await budgetAlert(spent, others.runs_today);
      if (!dec.ok) return await finish('blocked', { waiting: dec.why });
    }
    const wall = sandboxAvailable({ force: cfg.sandbox ?? (process.env.LINE_SANDBOX || null) });
    if (!wall.ok) return await finish('blocked', { waiting: `${wall.why}. Nothing ran.` });
    if (cfg.offline) {
      mkdirSync(cfg.tools, { recursive: true });
      if (!existsSync(join(cfg.stand_in, cfg.agent_stub))) {
        return await finish('blocked', { waiting: `the stand-in agent is not at ${join(cfg.stand_in, cfg.agent_stub)}. Nothing ran.` });
      }
      rmSync(join(cfg.tools, 'stand-in'), { recursive: true, force: true });
      cpSync(cfg.stand_in, join(cfg.tools, 'stand-in'), { recursive: true });
    } else if (!existsSync(join(cfg.tools, 'node_modules/.bin/opencode'))) {
      return await finish('blocked', {
        waiting: `the agent runtime is not installed at ${cfg.tools} (run line/kit/setup-tools.sh). Nothing ran.`,
      });
    }
    const tools = realpathSync(cfg.tools);
    // the wall reads the tools folder; the probe is placed there fresh each run
    for (const f of ['line-probe.sh', 'probe-net.mjs']) copyFileSync(join(KIT, f), join(tools, f));
    const nearai = near === undefined ? await optional('../near/nearai.mjs') : near;
    let pricingFile = cfg.pricing_file, report = null, reportScope = 'model';
    if (!cfg.offline) {
      const key = tokenState(cfg.nearai_key_file);
      if (!key.ok) return await finish('blocked', { waiting: `the NEAR AI key is not usable (${key.why}). Nothing ran.` });
      if (!cfg.model) return await finish('blocked', { waiting: 'no model is named in the config. Nothing ran.' });
      if (!pricingFile) {
        if (typeof nearai?.fetchPricing !== 'function') {
          return await finish('blocked', {
            waiting: 'the price list could not be read (near/nearai.mjs has no fetchPricing). Nothing ran.',
          });
        }
        let table;
        try {
          table = await nearai.fetchPricing({ keyFile: cfg.nearai_key_file, base: cfg.nearai_base, fetchImpl });
        } catch (e) {
          return await finish('blocked', {
            waiting: `NEAR AI's price list could not be read (${String(e.message).slice(0, 120)}). Nothing ran.`,
          });
        }
        pricingFile = join(workDir, 'pricing.json');
        writeFileSync(pricingFile, JSON.stringify(table?.models ?? table ?? {}, null, 1) + '\n');
      }
      let price = null;
      try {
        const t = JSON.parse(readFileSync(pricingFile, 'utf8'));
        price = (t.models ?? t)[cfg.model];
      } catch { /* unreadable = no price */ }
      if (!Number.isFinite(price?.prompt) || !Number.isFinite(price?.completion)) {
        return await finish('blocked', {
          waiting: `NEAR AI lists no price for the model ${cfg.model}; an unpriced model is never called. Nothing ran.`,
        });
      }
      // ONE TEE report for the whole run, taken before the first model call; every call's signature is checked against it
      if (typeof nearai?.fetchReport === 'function') {
        try {
          report = await nearai.fetchReport({ model: cfg.model, signingAlgo: SIGNING_ALGO, nonce: randomBytes(32).toString('hex'), base: cfg.nearai_base, fetchImpl });
        } catch {
          report = null;
        }
        // A model NEAR AI routes to an outside provider has no report of its own. Its calls are signed by NEAR AI's
        // attested gateway, so the gateway's report is the one taken here, still before the first call.
        if (!report) {
          try {
            report = await nearai.fetchReport({ signingAlgo: SIGNING_ALGO, nonce: randomBytes(32).toString('hex'), base: cfg.nearai_base, fetchImpl });
            if (report) reportScope = 'gateway';
          } catch {
            report = null;
          }
        }
      }
      say(`preflight: ${reportScope} TEE report for ${cfg.model} ${report ? 'taken' : 'NOT available (calls will carry no attestation report)'}`);
      say(
        `preflight: key file ok; model ${cfg.model} at $${(price.prompt * 1e6).toFixed(2)} in / $${
          (price.completion * 1e6).toFixed(2)
        } out per million tokens`,
      );
    }
    let url;
    try {
      url = ensureProductRepo(cfg, ticket.product).url;
    } catch (e) {
      return await finish('blocked', { waiting: `the repository of ${ticket.product} could not be made (${e.message}). Nothing ran.` });
    }
    const tokenFile = cfg.product_token_file;
    let mainBefore;
    try {
      mainBefore = remoteRef(url, 'refs/heads/main', tokenFile);
    } catch (e) {
      return await finish('blocked', { waiting: `the repository of ${ticket.product} could not be read (${e.message}). Nothing ran.` });
    }
    if (!mainBefore) {
      return await finish('blocked', { waiting: `the repository of ${ticket.product} has no main branch yet. Nothing ran.` });
    }
    rec.main.before = mainBefore;
    let taken;
    try {
      taken = remoteRef(url, `refs/heads/${ticket.branch}`, tokenFile);
    } catch (e) {
      return await finish('blocked', { waiting: `the repository of ${ticket.product} could not be read (${e.message}). Nothing ran.` });
    }
    if (taken) {
      return await finish('blocked', {
        waiting: `${ticket.branch} already exists in the repository of ${ticket.product} (${
          taken.slice(0, 10)
        }) — a ticket id is used once. Nothing ran.`,
      });
    }

    // ---- the worktree: a fresh clone, the repository's .git outside the agent's reach, build/<id> from main's sha -------------
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    const cl = git(['clone', '-q', '--no-checkout', url, repoDir], { tokenFile, timeout: 300_000 });
    if (cl.code !== 0) return await finish('blocked', { waiting: `the clone of ${ticket.product} failed (${cl.err}). Nothing ran.` });
    const base = git(['rev-parse', '--verify', 'refs/remotes/origin/main'], { cwd: repoDir });
    if (base.code !== 0 || base.out !== mainBefore) {
      throw new Error(`the clone's main (${base.out || base.err}) is not the remote's (${mainBefore})`);
    }
    const wa = git(['worktree', 'add', '-q', '--no-track', '-b', ticket.branch, wt, mainBefore], { cwd: repoDir });
    if (wa.code !== 0) throw new Error(`worktree add failed: ${wa.err}`);
    appendFileSync(join(repoDir, '.git/info/exclude'), "\n# the line: the agent's scratch space is never committed\n.oc/\n");
    const linkBefore = readFileSync(join(wt, '.git'));
    say(`worktree on ${ticket.branch} at ${mainBefore.slice(0, 10)} (main of ${ticket.product})`);
    save();

    // ---- the attempts -----------------------------------------------------------------------------------------------------------
    const registry = (await dial('registry.npmjs.org', 443, 3000)) ? 'online' : 'offline';
    const secretsDir = existsSync(dirname(cfg.nearai_key_file)) ? dirname(cfg.nearai_key_file) : '-';
    const checkDirs = [join(scratch, 'check-a1'), join(scratch, 'check-a2')];
    let usdLeft = ticket.budget.usd,
      callsLeft = ticket.budget.calls,
      secondsLeft = ticket.budget.minutes * 60,
      findings = null,
      green = false,
      lastCommit = null;
    let ports = null;
    for (let n = 1; n <= 2; n++) {
      const aDir = join(workDir, `a${n}`), chk = checkDirs[n - 1];
      mkdirSync(aDir, { recursive: true });
      const att = {
        n,
        started: now(),
        finished: null,
        walls: null,
        sandbox: { kind: wall.kind },
        agent: null,
        bridge: null,
        calls: [],
        commit: null,
        green: false,
        failing: [],
        checks: [],
      };
      rec.attempts.push(att);
      if (!rec.stations.build) rec.stations.build = { at: att.started, done: null };
      mkdirSync(join(wt, '.oc'), { recursive: true });
      writeFileSync(join(wt, '.oc/TICKET.md'), ticketText(ticket, findings));
      const again = findings ? ' Your previous attempt failed some checks; they are listed at the end of the ticket.' : '';
      writeFileSync(
        join(aDir, 'prompt.txt'),
        `Read .oc/TICKET.md in this directory and complete the ticket.${again} ` +
          'You are working unattended: decide, build, verify, then stop.\n',
      );
      const before = manifest(scratch, [wt, ...checkDirs]);
      // a wall with its own network namespace reaches the bridge through unix sockets in a short-named directory
      if (needsSockets(wall.kind) && !sockDir) sockDir = mkdtempSync(join(tmpdir(), 'cl-'));
      ports = {
        bridgePort: cfg.bridge_port ?? await freePort(),
        proxyPort: cfg.proxy_port ?? await freePort(),
        tools,
        sockDir,
        sandbox: cfg.sandbox,
      };
      // the bridge: the model (live) and the registry tunnel; offline there is no model behind it at all
      const b = await startBridge(
        aDir,
        'bridge',
        ports,
        cfg.offline ? null : { maxCalls: callsLeft, maxUsd: usdLeft, pricing: pricingFile },
      );
      if (!b.up) return await finish('blocked', { waiting: `the bridge did not start (${b.why}). No model call was made.` });
      // the walls, both directions, in this worktree — before the agent, every attempt. The probe must NOT reach `other`.
      const other = createServer((s) => s.destroy());
      await new Promise((r) => other.listen(0, '127.0.0.1', r));
      const probe = await runProcess(join(KIT, 'in-sandbox.sh'), [
        wt,
        String(ports.bridgePort),
        String(ports.proxyPort),
        '/bin/sh',
        join(tools, 'line-probe.sh'),
        String(ports.bridgePort),
        String(ports.proxyPort),
        scratch,
        realpathSync(cfg.records),
        realpathSync(workDir),
        realpathSync(homedir()),
        secretsDir,
        String(other.address().port),
        registry,
      ], { timeout: 180_000, env: wallEnv(ports) });
      other.close();
      writeFileSync(join(aDir, 'sandbox-probe.txt'), probe.stdout + probe.stderr);
      att.walls = probe.stdout.trim().split('\n').pop() ?? '';
      if (probe.status !== 0) {
        await stopBridge();
        save();
        return await finish('blocked', {
          waiting: `the sandbox probe failed (${att.walls || probe.stderr.trim().slice(0, 120) || 'no output'}). No model call was made.`,
        });
      }
      say(`a${n} walls (${wall.kind}): ${att.walls}`);
      // the agent
      const limit = Math.max(60, Math.floor(secondsLeft));
      const t0 = Date.now();
      if (cfg.offline) {
        const r = await inSandbox(wt, ports, ['/bin/sh', join(tools, 'stand-in', cfg.agent_stub), String(n)], { timeout: limit * 1000 });
        writeFileSync(join(aDir, 'agent-stub.out'), r.out);
        att.agent = { kind: 'stand-in (offline)', exit: r.code, seconds: Math.round((Date.now() - t0) / 1000), model: null };
      } else {
        say(`a${n} agent start: OpenCode, model ${cfg.model}, limit ${limit}s, bridge budget ${callsLeft} calls / $${usdLeft.toFixed(2)}`);
        const env = wallEnv(ports, {
          LINE_MODEL: cfg.model,
          LINE_MODEL_CONTEXT: String(cfg.model_context),
          LINE_MODEL_OUTPUT: String(cfg.model_output),
        });
        const r = await runProcess(join(KIT, 'run-agent.sh'), [
          wt,
          String(ports.bridgePort),
          String(ports.proxyPort),
          b.secretFile,
          join(aDir, 'prompt.txt'),
          aDir,
          String(limit),
        ], { timeout: (limit + 60) * 1000, env });
        let ex = null;
        try {
          ex = JSON.parse(readFileSync(join(aDir, 'agent-exit.json'), 'utf8'));
        } catch { /* the wrapper did not finish */ }
        att.agent = {
          kind: 'OpenCode',
          exit: ex?.exit ?? r.status,
          seconds: ex?.seconds ?? Math.round((Date.now() - t0) / 1000),
          model: cfg.model,
        };
      }
      const t1 = Date.now();
      await stopBridge();
      secondsLeft -= (t1 - t0) / 1000;
      const traceFile = join(aDir, 'bridge-trace.jsonl');
      const down = jsonLines(traceFile).filter((j) => j.event === 'down').pop();
      att.bridge = down
        ? { forwarded: down.forwarded, refused: down.refused, computed_usd: down.computed_usd, unpriced_calls: down.unpriced_calls }
        : { forwarded: null, refused: null, computed_usd: null, unpriced_calls: null };
      att.calls = callRows(traceFile);
      usdLeft -= down?.computed_usd ?? 0;
      callsLeft -= down?.forwarded ?? 0;
      say(
        `a${n} agent stopped after ${att.agent.seconds}s, exit ${att.agent.exit}; bridge forwarded ${att.bridge.forwarded} call(s), ` +
          `computed $${(att.bridge.computed_usd ?? 0).toFixed(4)}`,
      );
      if (!cfg.offline && att.calls.length) {
        const got = await attest({ cfg, near: nearai, calls: att.calls, report, recDir, fetchImpl });
        say(`a${n} attestations: ${got} of ${att.calls.length} call(s)`);
      }
      rec.stations.build.done = now();
      save();
      const after = manifest(scratch, [wt, ...checkDirs]);
      // the harness commits what the agent left — only if the worktree's link file is still the one git wrote
      if (!readFileSync(join(wt, '.git')).equals(linkBefore)) {
        return await finish('blocked', {
          waiting: "the worktree's .git link changed during the run — git was not run in it; nothing committed, nothing pushed.",
        });
      }
      const message = `build ${ticket.id}: ${ticket.title}\n\nTicket-Sha256: ${rec.ticket_sha256}\nApproved-By: ${
        rec.release.valid.join(', ')
      }\nAttempt: ${n}\n`;
      const cm = await commit(cfg, wt, message);
      if (!cm.ok) {
        return await finish('blocked', { waiting: `the harness could not commit the agent's files (${cm.why}); nothing pushed.` });
      }
      att.commit = cm.sha;
      lastCommit = cm.sha;
      say(`a${n} commit ${cm.sha.slice(0, 10)}${cm.empty ? ' (the agent left no change)' : ''}`);
      // the ticket's checks, on a fresh clone; the tunnel is up for the checks that ask for the registry, with no model behind the bridge
      if (!rec.stations.test) rec.stations.test = { at: now(), done: null, green: false };
      const cb = await startBridge(aDir, 'check', ports, null);
      if (!cb.up) say(`a${n} the checks' tunnel did not start (${cb.why}); checks that need the registry will fail`);
      const res = await runChecks({
        ticket,
        repoDir,
        workDir: chk,
        ports,
        git,
        manifestBefore: before,
        manifestAfter: after,
        manifestRoot: scratch,
      });
      await stopBridge();
      writeFileSync(join(aDir, 'checks.json'), JSON.stringify(res, null, 1) + '\n');
      Object.assign(att, { green: res.green, failing: res.failing, checks: res.checks, finished: now() });
      Object.assign(rec.stations.test, { done: att.finished, green: res.green });
      for (const c of res.checks) say(`a${n} check ${c.pass ? 'PASS' : c.unverified ? 'UNVERIFIED' : 'FAIL'}  ${c.id} — ${c.detail}`);
      say(`a${n} ${res.green ? `GREEN: ${res.checks.length} of ${res.checks.length}` : `RED: ${res.failing.join(', ')}`}`);
      if (!cfg.offline) {
        const tr = await runProcess(NODE, [join(KIT, 'trace.mjs'), traceFile, join(aDir, 'opencode-events.jsonl')]);
        writeFileSync(join(aDir, 'trace.txt'), tr.stdout);
      }
      save();
      if (res.green) {
        green = true;
        break;
      }
      findings = res.checks.filter((c) => !c.pass).map((c) => ({ id: c.id, name: c.name, detail: c.detail }));
      if (n === 1 && (usdLeft < 0.05 || callsLeft < 2 || secondsLeft < 120) && !cfg.offline) {
        return await finish('red', {
          waiting: `RED after one attempt (${
            res.failing.join(', ')
          }) and the ticket's budget is spent — no second attempt, nothing pushed.`,
        });
      }
    }
    rec.cost = totalCost();
    save();
    {
      const sp = readSpentToday(cfg);
      if (Number.isFinite(sp)) await budgetAlert(sp, runsToday(cfg, { day: utcDay() }).runs_today);
    }
    const readMain = () => {
      try {
        rec.main.after = remoteRef(url, 'refs/heads/main', tokenFile);
        rec.main.untouched = rec.main.after === rec.main.before;
      } catch { /* unread stays null */ }
    };
    const branchAbsent = () => {
      try {
        return remoteRef(url, `refs/heads/${ticket.branch}`, tokenFile) === null;
      } catch {
        return null;
      }
    };

    // ---- RED twice: nothing leaves this machine --------------------------------------------------------------------------------
    if (!green) {
      const [a, b] = rec.attempts;
      const same = a && b && a.failing.join(',') === b.failing.join(',');
      const absent = branchAbsent();
      rec.push = { pushed: false };
      readMain();
      return await finish('red', {
        waiting: `RED twice — ${same ? 'the same failure both times' : 'a different failure each time'}: ` +
          `${(b ?? a).failing.join(', ')}. Nothing was pushed${
            absent === true ? ` (${ticket.branch} is absent in the repository, read)` : ''
          }.`,
      });
    }

    // ---- GREEN: the release is checked again, then the one write, then the reads that prove what it was --------------------------
    const again = verifyRelease(ticket, approvals, council);
    if (!again.ok || ticketHash(ticket) !== rec.ticket_sha256) {
      rec.release = { ok: false, valid: again.valid ?? [], threshold: council?.threshold ?? null };
      readMain();
      return await finish('refused', {
        waiting: `the release no longer holds right before the push: ${
          again.why ?? 'the ticket changed during the run'
        }. Nothing was pushed.`,
      });
    }
    // What the run asks for is guarded in pushBranch. push_override exists for tests alone (offline), so the guard is seen refusing.
    const ask = {
      branch: ticket.branch,
      commit: lastCommit,
      force: false,
      refspec: null,
      ...(cfg.offline && cfg.push_override?.[ticket.id] ? cfg.push_override[ticket.id] : {}),
    };
    const p = pushBranch({ repoDir, url, tokenFile, ...ask });
    if (!p.ok) {
      rec.push = { pushed: false, refused: p.refused ?? { ref: `refs/heads/${ask.branch}`, why: p.why } };
      readMain();
      const absent = branchAbsent();
      return await finish('red', {
        waiting:
          `RED — the push was refused: ${p.why}. Nothing was pushed${
            absent === true ? ` (${ticket.branch} is absent in the repository, read)` : ''
          }; ` +
          `main ${rec.main.untouched === true ? 'untouched' : 'NOT CONFIRMED UNTOUCHED'}.`,
      });
    }
    rec.push = { pushed: true, ref: p.ref, commit: lastCommit, remote_sha: p.remote_sha };
    say(`pushed ${lastCommit.slice(0, 10)} → ${ticket.product} ${p.ref} (read back at the remote)`);
    readMain();
    say(
      `main at the remote: before ${String(rec.main.before).slice(0, 10)}, after ${String(rec.main.after).slice(0, 10)} — ${
        rec.main.untouched ? 'untouched' : 'NOT CONFIRMED UNTOUCHED'
      }`,
    );
    save();
    // an optional second remote gets the same commit, through the same guard; its token only through askpass
    const publishUrl = typeof cfg.publish_remote === 'function' ? cfg.publish_remote(ticket.product) : cfg.publish_remote;
    if (publishUrl) {
      const pp = pushBranch({
        repoDir,
        url: String(publishUrl),
        tokenFile: cfg.publish_token_file,
        branch: ticket.branch,
        commit: lastCommit,
      });
      rec.push.publish = pp.ok
        ? { pushed: true, ref: pp.ref, remote_sha: pp.remote_sha }
        : { pushed: false, refused: pp.refused ?? { ref: p.ref, why: pp.why } };
      say(pp.ok ? `published ${lastCommit.slice(0, 10)} → the publish remote ${pp.ref} (read back)` : `NOT published: ${pp.why}`);
      save();
    }

    // ---- the static output, built once more from the commit; a copy is kept with the record; the preview deploys the same files ----
    const out = await buildOutput({ cfg, ticket, repoDir, scratch, recDir, ports, startBridge, stopBridge, workDir, say });
    rec.stations.preview = { at: now(), url: null };
    let preview;
    if (cfg.offline) preview = { state: 'skipped', why: 'offline', url: null, deployment_id: null, public: false };
    else if (!cfg.vercel_token_file || !existsSync(cfg.vercel_token_file)) {
      preview = { state: 'skipped', why: 'no Vercel token', url: null, deployment_id: null, public: false };
    } else if (!out.ok) preview = { state: 'failed', why: out.why, url: null, deployment_id: null, public: false };
    else {
      const pv = await deployPreview(cfg, { product: ticket.product, files: out.files, ticket: ticket.id, commit: lastCommit }, {
        fetchImpl,
        log: say,
      });
      preview = {
        state: pv.state,
        url: pv.url ?? null,
        deployment_id: pv.deployment_id ?? null,
        public: pv.public === true,
        ...(pv.why ? { why: pv.why } : {}),
      };
    }
    rec.preview = preview;
    rec.stations.preview.url = preview.url;
    save();
    say(
      preview.state === 'success'
        ? `preview ${preview.url} (deployment ${preview.deployment_id}, read back with no sign-in: 200)`
        : `no preview: ${preview.why}`,
    );
    return await finish(preview.state === 'success' ? 'green-preview' : 'green-no-preview', { green: { preview, commit: lastCommit } });
  } catch (e) {
    await stopBridge();
    say(`error: ${String(e.stack ?? e.message).slice(0, 1500)}`);
    return await finish('error', { waiting: `the run stopped on an error: ${String(e.message).slice(0, 200)}` });
  } finally {
    await stopBridge();
    if (sockDir) rmSync(sockDir, { recursive: true, force: true });
  }
}

/**
 * Build the commit's static output in a fresh clone (behind the wall, registry only), then keep a copy beside the
 * run record: the files a preview deploys, at their repository paths, plus the files the ticket's `file` checks
 * name — so checks.mjs recheck() can re-read them later with nothing but the record. The copy is capped at 2 MB.
 * → {ok, files, root, why}
 */
async function buildOutput({ cfg, ticket, repoDir, scratch, recDir, ports, startBridge, stopBridge, workDir, say }) {
  const dir = join(scratch, 'output');
  const clone = join(dir, 'clone');
  mkdirSync(dir, { recursive: true });
  const c = git(['clone', '-q', '--branch', ticket.branch, repoDir, clone]);
  if (c.code !== 0) return { ok: false, why: `the commit could not be cloned for the output build (${c.err})` };
  let scripts = {};
  try {
    scripts = JSON.parse(readFileSync(join(clone, 'package.json'), 'utf8')).scripts ?? {};
  } catch { /* no package.json: nothing to build */ }
  if (typeof scripts.build === 'string') {
    const tunnel = await startBridge(workDir, 'output', ports, null);
    const r = tunnel.up
      ? await inSandbox(clone, ports, 'npm install --no-audit --no-fund && npm run build', { timeout: 600_000 })
      : { launched: false, out: tunnel.why };
    await stopBridge();
    writeFileSync(join(workDir, 'output-build.txt'), String(r.out ?? ''));
    if (!r.launched || r.code !== 0) return { ok: false, why: `the output build did not finish (exit ${r.code ?? 'none'})` };
  }
  const out = outputFiles(clone);
  const prefix = out.root === '.' ? '' : `${out.root}/`;
  const keep = new Map(out.files.map((f) => [prefix + f.rel, f.abs]));
  const base = realpathSync(clone);
  for (const chk of ticket.green) {
    if (chk.kind !== 'file' || keep.has(chk.path) || chk.path.split('/').includes('node_modules')) continue;
    const p = join(clone, chk.path);
    try {
      if (lstatSync(p).isFile() && realpathSync(p).startsWith(base + '/')) keep.set(chk.path, p);
    } catch { /* absent: recheck will say so */ }
  }
  const bytes = [...keep.values()].reduce((s, p) => s + lstatSync(p).size, 0);
  const dest = join(recDir, 'output');
  rmSync(dest, { recursive: true, force: true });
  if (bytes > OUTPUT_KEEP_BYTES) say(`output: ${bytes} bytes is over the ${OUTPUT_KEEP_BYTES} byte cap; no copy is kept with the record`);
  else {
    for (const [rel, abs] of keep) {
      mkdirSync(dirname(join(dest, rel)), { recursive: true });
      copyFileSync(abs, join(dest, rel));
    }
    say(`output: ${keep.size} file(s), ${bytes} bytes kept with the record (static root: ${out.root})`);
  }
  return { ok: out.files.length > 0, files: out.files, root: out.root, why: out.files.length ? null : 'the build left no static file' };
}
