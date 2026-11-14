// judge.mjs — `npm run judge`: check this repository's claims on your own machine. No keys, no account.
//
// It reads the committed record (data/), re-derives what can be re-derived, runs the line once offline with
// a stand-in agent, and replays the attacks the line must refuse. Each line is one of
//   [ok]    observed, and it held          [skip]  could not be observed here, with the reason
//   [FAIL]  observed, and it did not hold  → exit code 1
// A check that could not look is a skip, never an ok. What this does NOT prove is listed at the end.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from '../app/config.mjs';
import { listRuns, receiptOf, ticketIds } from '../app/store.mjs';
import { loadCouncil } from '../approvals/council.mjs';
import { verifyRelease } from '../approvals/release.mjs';
import { FOUNDING_COUNCIL, checkCouncilBuild, councilKeysHash } from '../approvals/founding.mjs';
import { makeTestCouncil } from '../approvals/test-authenticator.mjs';
import { buildReceipt, receiptHash } from '../receipts/receipt.mjs';
import { parseLessons, lintBrief } from '../lessons/lessons.mjs';
import { parseTicket } from '../tickets/ticket.mjs';
import { checkDrafted } from '../tickets/provenance.mjs';
import { loadConfig } from '../line/config.mjs';
import { startRun } from '../line/dispatch.mjs';
import { recheck } from '../line/checks.mjs';
import { pushGuard } from '../line/github.mjs';
import { ceilingDecision } from '../line/budget.mjs';
import { sandboxAvailable } from '../line/kit/sandbox.mjs';
import * as nearai from '../near/nearai.mjs';
import { compareCodeHash, rpcUrlFor, viewCall } from '../near/rpc.mjs';
import { verifyOnChain } from './verify-receipt.mjs';
import { checkWasm } from './check-wasm.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const cfg = { ...appConfig(), mode: 'replay' };
const json = (f) => JSON.parse(readFileSync(f, 'utf8'));
const results = []; let n = 0;
const say = (kind, title, detail) => { results.push(kind); console.log(`${String(++n).padStart(2)}. [${kind}] ${title}${detail ? ` — ${detail}` : ''}`); };
const ok = (t, d) => say('ok', t, d), skip = (t, d) => say('skip', t, d), fail = (t, d) => say('FAIL', t, d);
/** Run one check; a thrown error is a FAIL of that check, not a crash of the judge. */
async function check(title, fn) { try { await fn(); } catch (e) { fail(title, `the check itself failed: ${String(e.message).slice(0, 200)}`); } }

const runs = listRuns(cfg);
const baby = runs.filter((r) => (r.origin ?? 'mini') === 'mini');
const imported = runs.filter((r) => r.origin === 'private-line');
const scratch = mkdtempSync(join(tmpdir(), 'cambrian-judge-'));
const fixtureTicket = (name) => parseTicket(readFileSync(join(ROOT, 'test/line/fixtures/tickets', `${name}.json`)));
const offlineCfg = (name, over = {}) => loadConfig({ offline: true, home: join(scratch, name, 'home'), records: join(scratch, name, 'records'), ...over });
const wall = sandboxAvailable();

console.log(`judge: ${runs.length} recorded run(s) — ${baby.length} on this line, ${imported.length} imported from Cambrian's private line\n`);

await check('the committed contract wasm is the one SHA256SUMS names', () => {
  const r = checkWasm();
  if (r.skipped) return skip('contract wasm checksum', r.why);
  r.ok ? ok('the committed contract wasm is the one SHA256SUMS names', `sha256 ${r.sha256.slice(0, 16)}…`) : fail('contract wasm checksum', r.why);
});

await check('the council file names its members and a threshold of at least two', () => {
  const c = loadCouncil(cfg.files.council);
  const enrolled = c.members.filter((m) => m.credentials.length).length;
  const title = 'the council file names its members and a threshold of at least two';
  c.threshold >= 2 && c.threshold <= c.members.length
    ? ok(title, `${c.label ?? 'council'}: ${c.threshold} of ${c.members.length}; ${enrolled} of ${c.members.length} have enrolled a passkey`)
    : fail(title, `${c.members.length} members, threshold ${c.threshold}`);
});

await check('every recorded run rebuilds to a receipt; a recorded hash matches', () => {
  const finished = runs.filter((r) => r.finished); const bad = []; let pinned = 0;
  for (const r of finished) {
    const sha = receiptHash(buildReceipt(r));
    if (r.receipt_sha256) { pinned++; if (r.receipt_sha256 !== sha) bad.push(`${r.ticket.id}: record says ${r.receipt_sha256.slice(0, 12)}…, rebuilt ${sha.slice(0, 12)}…`); }
    const mutated = JSON.parse(JSON.stringify(r)); mutated.state = `${r.state}-x`;
    if (receiptHash(buildReceipt(mutated)) === sha) bad.push(`${r.ticket.id}: the hash did not change when the record did`);
  }
  if (!finished.length) return skip('receipts rebuild from the run records', 'no finished run is recorded');
  bad.length ? fail('receipts rebuild from the run records', bad.join('; '))
    : ok('receipts rebuild from the run records', `${finished.length} receipt(s) rebuilt; ${pinned} carry a recorded hash and match; each hash changes when its record is changed`);
});

await check('recorded approvals verify: 2 of 3 council passkeys over the ticket hash', () => {
  if (!baby.length) return skip('recorded approvals verify (2 of 3 passkeys)', `no run of this line is recorded yet; the ${imported.length} imported run(s) were approved on the private line and carry no signature to check`);
  const c = loadCouncil(cfg.files.council); const bad = []; let good = 0;
  for (const r of baby) {
    const ticket = json(join(cfg.files.runs, r.ticket.id, 'ticket.json'));
    const v = verifyRelease(ticket, r.approvals, c);
    if (r.state === 'refused') { if (v.ok) bad.push(`${r.ticket.id}: recorded as refused but its approvals verify`); else good++; continue; }
    if (!v.ok) bad.push(`${r.ticket.id}: ${v.why}`); else if (v.ticket_sha256 !== r.ticket_sha256) bad.push(`${r.ticket.id}: the ticket hash differs from the record`); else good++;
  }
  bad.length ? fail('recorded approvals verify (2 of 3 passkeys)', bad.join('; ')) : ok('recorded approvals verify (2 of 3 passkeys)', `${good} run(s) checked against data/council.json`);
});

await check('drafted briefs: the kept model response, its TEE signature and the approvals agree on one hash', () => {
  const title = 'drafted briefs: the kept model response, its TEE signature and the approvals agree on one hash';
  const entries = ticketIds(cfg).map((id) => json(join(cfg.files.tickets, `${id}.json`))).filter((e) => e?.ticket?.drafted);
  if (!entries.length) return skip(title, 'no ticket with a recorded model draft is in data/tickets yet');
  const c = loadCouncil(cfg.files.council); const bad = []; let signed = 0, approvals = 0, noTee = 0;
  for (const e of entries) {
    const r = checkDrafted({ dir: cfg.files.tickets, entry: e, council: c });
    for (const f of r.faults) bad.push(`${e.ticket.id}: ${f}`);
    if (r.signed) signed++; if (r.signature_without_tee_report) noTee++; approvals += r.approvals;
  }
  if (bad.length) return fail(title, bad.slice(0, 4).join('; '));
  const rest = entries.length - signed - noTee;
  const detail = `${entries.length} ticket(s): each kept response hashes to ticket.drafted.response_sha256; `
    + `${approvals} approval(s) signed those ticket hashes`;
  const without = (rest ? `; ${rest} recorded without a signature` : '')
    + (noTee ? `; ${noTee} signed over the exact request and response by a key for which NEAR AI's report shows no TEE (not verified as model-signed)` : '');
  signed ? ok(title, `${detail}; ${signed} model signature(s) verified offline and bind the hashes and the model${without}`)
    : skip(title, `${detail}${without}; no model signature could be verified as made in a TEE, so the TEE half is not shown here`);
});

await check('the kept build output still passes the ticket\'s file checks', () => {
  const kept = baby.filter((r) => /^green/.test(r.state) && existsSync(join(cfg.files.runs, r.ticket.id, 'output')));
  if (!kept.length) return skip('kept build output passes its checks again', 'no GREEN run of this line with kept output is recorded yet');
  const bad = []; let reread = 0;
  for (const r of kept) {
    const res = recheck({ ticket: json(join(cfg.files.runs, r.ticket.id, 'ticket.json')), outputDir: join(cfg.files.runs, r.ticket.id, 'output') });
    reread += res.checks.filter((c) => !c.skipped).length; if (res.failing.length) bad.push(`${r.ticket.id}: ${res.failing.join(', ')}`);
  }
  bad.length ? fail('kept build output passes its checks again', bad.join('; ')) : ok('kept build output passes its checks again', `${reread} file check(s) over ${kept.length} run(s)`);
});

await check('a NEAR AI response signature verifies offline, and a changed byte does not', async () => {
  // A real completion recorded from NEAR AI Cloud (test/near/fixtures/source.json): signed inside the model's TEE.
  const FIX = join(ROOT, 'test/near/fixtures'); const source = json(join(FIX, 'source.json'));
  const model = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
  const keyFile = join(scratch, 'not-a-key'); writeFileSync(keyFile, 'offline-replay-no-key', { mode: 0o600 });
  const serve = async (url) => {
    const u = new URL(url); const algo = u.searchParams.get('signing_algo');
    const file = u.pathname.endsWith('/attestation/report') ? `report.${algo}.json` : `tool.sig.${algo}.json`;
    return new Response(readFileSync(join(FIX, file)), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const hashes = { requestSha256: nearai.sha256Hex(readFileSync(join(FIX, 'tool.request.json'))), responseSha256: nearai.sha256Hex(readFileSync(join(FIX, 'tool.response.json'))) };
  const report = await nearai.fetchReport({ model, signingAlgo: 'ed25519', nonce: source.report.nonce, base: 'http://replay.invalid/v1', fetchImpl: serve });
  report.fetched_at = source.report.fetched_at;
  const att = await nearai.fetchAttestation({ chatId: source.chats.tool.chat_id, model, ...hashes, keyFile, base: 'http://replay.invalid/v1', signingAlgo: 'ed25519', report, fetchImpl: serve, retryMs: 1 });
  const good = nearai.verifyAttestation(att, hashes);
  const tampered = nearai.verifyAttestation(att, { ...hashes, responseSha256: hashes.responseSha256.replace(/^./, (c) => (c === '0' ? '1' : '0')) });
  const done = good.checks.filter((c) => c.ok === true).map((c) => c.name), skipped = good.checks.filter((c) => c.skipped).map((c) => c.name);
  good.ok && !tampered.ok ? ok('a NEAR AI response signature verifies offline, and a changed byte does not', `${att.kind}, ${done.length} checks held (${done.join(', ')}); online-only, not checked here: ${skipped.join(', ')}`)
    : fail('NEAR AI response signature', good.ok ? 'a tampered response hash still verified' : good.why);
});

await check('every model call recorded by this line carries a signature that verifies', () => {
  const calls = baby.flatMap((r) => (r.attempts ?? []).flatMap((a) => (a.calls ?? []).map((c) => ({ run: r.ticket.id, ...c }))));
  if (!calls.length) return skip('recorded model calls carry verifying signatures', 'no model call of this line is recorded yet (the imported runs did not capture signatures)');
  const bad = []; let verified = 0, without = 0;
  for (const c of calls) {
    if (!c.attestation) { without++; continue; }
    const reportFile = join(cfg.files.runs, c.run, 'attestation-report.json');
    const v = nearai.verifyAttestation(c.attestation, existsSync(reportFile) ? { report: json(reportFile) } : {});
    if (v.ok) verified++; else bad.push(`${c.run} call ${c.seq}: ${v.why ?? 'did not verify'}`);
  }
  if (bad.length) return fail('recorded model calls carry verifying signatures', bad.slice(0, 4).join('; '));
  verified ? ok('recorded model calls carry verifying signatures', `${verified} of ${calls.length} call(s) verified offline${without ? `; ${without} recorded without a signature` : ''}`)
    : skip('recorded model calls carry verifying signatures', `${calls.length} call(s) recorded, none with a signature`);
});

await check('lessons: the ticket that failed is caught by the rules it taught; the one that passed is not', () => {
  const lessons = parseLessons(readFileSync(cfg.files.lessons, 'utf8')).lessons;
  const products = json(cfg.files.products).products;
  const red = json(join(cfg.files.runs, 'upread-v1-one-word-at-a-time-reader-for', 'ticket.json'));
  const green = json(join(cfg.files.runs, 'upread-v1-reader-shell', 'ticket.json'));
  const r = lintBrief(red, { lessons, products, existing: [] }), g = lintBrief(green, { lessons, products, existing: [] });
  r.refused.length && !g.refused.length ? ok('lessons: the ticket that failed is caught by the rules it taught; the one that passed is not',
    `${lessons.length} lessons; the RED ticket is refused by ${r.refused.map((x) => x.lesson).join(', ')} and changed by ${r.applied.map((x) => x.lesson).join(', ')}`)
    : fail('lessons lint', `RED refused by ${r.refused.length}, GREEN refused by ${g.refused.length}`);
});

let offlineRun = null;
await check('the line runs a ticket end to end offline (stand-in agent, real walls, real checks)', async () => {
  if (!wall.ok) return skip('the line runs a ticket end to end offline', `no sandbox on this machine (${wall.why}); the line refuses to execute anything without one`);
  const ticket = fixtureTicket('facts-page-1'); const { council, sign } = makeTestCouncil(); const lc = offlineCfg('green');
  const rec = await startRun(lc, { ticket, approvals: [sign('clemens', ticket), sign('jj', ticket)], council });
  offlineRun = { rec, lc, ticket };
  const again = recheck({ ticket, outputDir: join(lc.records, ticket.id, 'output') });
  const sha = receiptHash(buildReceipt(rec));
  /^green/.test(rec.state) && rec.main?.untouched === true && again.ok && sha === rec.receipt_sha256
    ? ok('the line runs a ticket end to end offline', `${rec.state}; walls: ${rec.attempts[0].walls} (${rec.attempts[0].sandbox?.kind}); ${rec.attempts.at(-1).checks.length} checks pass; pushed ${rec.push.ref}; main untouched; receipt ${sha.slice(0, 12)}…`)
    : fail('the line runs a ticket end to end offline', `state ${rec.state}${rec.waiting_on ? ` — ${rec.waiting_on}` : ''}`);
});

await check('attack: an unapproved, a once-approved and an altered ticket are each refused before anything runs', async () => {
  const ticket = fixtureTicket('facts-page-1'); const { council, sign } = makeTestCouncil(); const out = [];
  const cases = { 'no approval': [ticket, []], 'one of three': [ticket, [sign('jj', ticket)]],
    'altered after signing': [{ ...ticket, task: `${ticket.task} Also publish it.` }, [sign('clemens', ticket), sign('jj', ticket)]] };
  let i = 0;
  for (const [name, [t, approvals]] of Object.entries(cases)) {
    const rec = await startRun(offlineCfg(`refuse-${++i}`), { ticket: t, approvals, council });
    if (rec.state !== 'refused' || (rec.attempts ?? []).length || rec.push?.pushed) out.push(`${name}: state ${rec.state}`);
  }
  out.length ? fail('attack: unapproved, 1-of-3 and altered tickets are refused', out.join('; ')) : ok('attack: unapproved, 1-of-3 and altered tickets are refused', 'three runs, each ended "refused" with no attempt and no push');
});

await check('the threshold is a parameter: a council of seven with a threshold of four', async () => {
  const title = 'the threshold is a parameter: a council of 7 with threshold 4 releases at 4, refuses at 3, refuses an altered brief';
  const ids = ['ada', 'ben', 'cy', 'dee', 'eli', 'fay', 'gus'];
  const { council, sign } = makeTestCouncil({ members: ids, threshold: 4 }); const ticket = fixtureTicket('facts-page-1'); const bad = [];
  const four = ids.slice(0, 4).map((m) => sign(m, ticket));
  if (!verifyRelease(ticket, four, council).ok) bad.push('four valid signatures did not release');
  // the line itself, not only the rule: three signatures and an altered brief each end "refused" before anything runs
  const three = await startRun(offlineCfg('seven-3'), { ticket, approvals: four.slice(0, 3), council });
  if (three.state !== 'refused' || (three.attempts ?? []).length) bad.push(`three of seven: state ${three.state}`);
  const altered = await startRun(offlineCfg('seven-altered'), { ticket: { ...ticket, task: `${ticket.task} Also publish it.` }, approvals: four, council });
  if (altered.state !== 'refused' || (altered.attempts ?? []).length) bad.push(`altered brief: state ${altered.state}`);
  bad.length ? fail(title, bad.join('; ')) : ok(title, '4 of 7 released; 3 of 7 and an altered brief each ended "refused" with no attempt');
});

await check('attack: the push guard refuses main, a forced push and a + refspec; it accepts build/<ticket-id>', () => {
  const commit = 'a'.repeat(40); const bad = [];
  const refuse = { main: { branch: 'main', commit }, force: { branch: 'build/facts-page-1', commit, force: true }, 'plus refspec': { branch: 'build/facts-page-1', commit, refspec: `+${commit}:refs/heads/build/facts-page-1` },
    'refspec to main': { branch: 'build/facts-page-1', commit, refspec: `${commit}:refs/heads/main` }, 'another branch': { branch: 'release', commit } };
  for (const [name, ask] of Object.entries(refuse)) if (pushGuard(ask).ok) bad.push(`${name} was allowed`);
  if (!pushGuard({ branch: 'build/facts-page-1', commit }).ok) bad.push('build/<ticket-id> was refused');
  bad.length ? fail('attack: the push guard', bad.join('; ')) : ok('attack: the push guard refuses main, a forced push and a + refspec; it accepts build/<ticket-id>', `${Object.keys(refuse).length} refusals, 1 acceptance`);
});

await check('attack: a ticket that would carry the day past the cap is blocked before it starts', () => {
  const over = ceilingDecision({ spent_usd: 4.5, committed_usd: 0, ticket_usd: 1, ceiling_usd: 5, day: '2026-11-12' });
  const under = ceilingDecision({ spent_usd: 1, committed_usd: 0, ticket_usd: 1, ceiling_usd: 5, day: '2026-11-12' });
  const unread = ceilingDecision({ spent_usd: NaN, ticket_usd: 1, ceiling_usd: 5, day: '2026-11-12' });
  !over.ok && under.ok && !unread.ok ? ok('attack: a ticket that would carry the day past the cap is blocked before it starts', '$4.50 + $1 of $5 blocked; $1 + $1 allowed; an unreadable meter blocks')
    : fail('daily cap', `over ${over.ok}, under ${under.ok}, unread ${unread.ok}`);
});

await check('no secret-shaped text in the tracked files', () => {
  const shapes = [/github_pat_[A-Za-z0-9_]{30,}/, /\bgh[pousr]_[A-Za-z0-9]{30,}/, /\bsk-[A-Za-z0-9]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /_vercel_share=/, /\bed25519:[1-9A-HJ-NP-Za-km-z]{80,}/];
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 32e6 });
  let files = ls.status === 0 ? ls.stdout.split('\0').filter(Boolean) : null;
  if (!files) { files = []; const walk = (d) => { for (const e of readdirSync(join(ROOT, d), { withFileTypes: true })) { const p = join(d, e.name);
    if (['.git', 'node_modules', '.line', 'target', 'dist-static', '.shots'].includes(e.name)) continue; e.isDirectory() ? walk(p) : files.push(p); } }; walk('.'); }
  const hits = [];
  for (const f of files) { const p = join(ROOT, f); if (!existsSync(p) || statSync(p).size > 4e6 || /\.(png|jpg|woff2|wasm|ico)$/.test(f)) continue;
    const text = readFileSync(p, 'utf8'); for (const re of shapes) if (re.test(text) && !/scripts\/judge\.mjs$|static-build\.mjs$|test\/support\/deny\.mjs$|\.test\.mjs$/.test(f)) hits.push(`${f} matches ${re}`); }
  hits.length ? fail('no secret-shaped text in the tracked files', hits.slice(0, 5).join('; ')) : ok('no secret-shaped text in the tracked files', `${files.length} files read`);
});

await check('on chain: the deployed contract is the committed wasm, and each recorded receipt is in a transaction the recorder signed', async () => {
  const title = 'on chain: deployed code hash, and each recorded receipt verified in its transaction';
  const chainFile = join(cfg.data, 'chain.json');
  if (!existsSync(chainFile)) return skip(title, 'the receipt contract is not deployed yet (no data/chain.json); receipts show "hash computed, not yet on chain"');
  // data/chain.json names the network, the contract account and the ONE recorder account whose signature gives a record its meaning
  const chain = json(chainFile); const rpcUrl = chain.rpc_url ?? rpcUrlFor(chain.network);
  const code = await compareCodeHash({ rpcUrl, accountId: chain.contract, wasmBytes: readFileSync(join(ROOT, 'contracts/receipts.wasm')) });
  if (code.offline) return skip(title, `the RPC could not be reached (${code.why})`);
  if (!code.ok || !code.match) return fail('on chain: the deployed contract is the committed wasm', code.why ?? `deployed ${code.deployed}, committed ${code.committed}`);
  const recorded = runs.filter((r) => existsSync(join(cfg.files.runs, r.ticket.id, 'onchain.json'))); const bad = []; let unread = 0;
  for (const r of recorded) {
    const on = json(join(cfg.files.runs, r.ticket.id, 'onchain.json')); const sha = receiptOf(cfg, r).receipt_sha256;
    if (on.receipt_sha256 !== sha) { bad.push(`${r.ticket.id}: the recorded hash is not this receipt's hash`); continue; }
    const v = await verifyOnChain({ network: chain.network, contract: chain.contract, signer: chain.recorder, txHash: on.tx_hash, hash: sha, rpcUrl });
    if (v.skipped) unread++; else if (!v.ok) bad.push(`${r.ticket.id}: ${v.why}`);
  }
  if (bad.length) return fail(title, bad.join('; '));
  if (unread) return skip(title, `${unread} of ${recorded.length} recorded transaction(s) could not be read from the node`);
  ok('on chain: the deployed contract is the committed wasm, and each recorded receipt is in a transaction the recorder signed',
    `${chain.contract} on ${chain.network}; ${recorded.length} receipt(s) verified, signed by ${chain.recorder}`);
});

await check('on chain: the stake position named in data/stake.json is there, with that amount', async () => {
  const title = 'on chain: the stake position read from the staking contract';
  const stake = json(join(cfg.data, 'stake.json')).stake ?? {};
  if (!stake.account || !stake.staked_with || stake.network !== 'mainnet') return skip(title, 'data/stake.json names no stake on mainnet');
  const chain = existsSync(join(cfg.data, 'chain.json')) ? json(join(cfg.data, 'chain.json')) : {};
  const v = await viewCall({ rpcUrl: chain.rpc_url ?? rpcUrlFor('mainnet'), contractId: stake.staked_with, method: 'get_farm_positions_for_account',
    args: { account_id: stake.account, from_index: 0, limit: 20 } });
  if (v.offline) return skip(title, `the RPC could not be reached (${v.why})`);
  if (!v.ok || !Array.isArray(v.value)) return fail(title, `the staking contract did not answer with positions (${v.why ?? 'not a list'})`);
  const yocto = BigInt(Math.round(Number(stake.amount_near))) * 10n ** 24n;
  const found = v.value.find((x) => x.account_id === stake.account && BigInt(x.staked_near_amount ?? 0) === yocto);
  if (!found) return fail(title, `${stake.staked_with} shows no position of ${stake.amount_near} NEAR for ${stake.account} (${v.value.length} position(s) read)`);
  if (found.status !== 'Active') return fail(title, `the position of ${stake.amount_near} NEAR is ${found.status}, not Active`);
  ok('on chain: the stake position named in data/stake.json is there, with that amount',
    `${stake.account} holds ${Number(stake.amount_near).toLocaleString('en-US')} NEAR in ${stake.staked_with}, status ${found.status}, validator ${found.validator_id}`);
});

await check('each council build carries at least 2 valid passkey signatures over its brief hash, by the keys enrolled on 13 Nov', () => {
  const title = 'council builds: at least 2 valid passkey signatures each, by the keys enrolled on 13 Nov';
  const built = baby.filter((r) => r.state !== 'refused');
  if (!built.length) return skip(title, 'no build of this line is recorded');
  const council = loadCouncil(cfg.files.council); const bad = []; const who = [];
  for (const r of built) {
    const v = checkCouncilBuild({ run: r, ticket: json(join(cfg.files.runs, r.ticket.id, 'ticket.json')), council });
    if (!v.ok) bad.push(`${r.ticket.id}: ${v.why}`); else who.push(`${r.ticket.id} by ${v.signers.join(' and ')}`);
  }
  if (bad.length) return fail(title, bad.join('; '));
  // where the history is at hand, read the keys from that commit too; an export without history has only the pin
  const old = spawnSync('git', ['-C', ROOT, 'show', `${FOUNDING_COUNCIL.commit}:data/council.json`], { encoding: 'utf8' });
  let history = 'no git history here, so the keys are checked against the pinned hash only';
  if (old.status === 0) {
    if (councilKeysHash(JSON.parse(old.stdout)) !== FOUNDING_COUNCIL.members_digest) return fail(title, `the keys at commit ${FOUNDING_COUNCIL.commit.slice(0, 7)} are not the pinned ones`);
    history = `the same keys are in data/council.json at commit ${FOUNDING_COUNCIL.commit.slice(0, 7)}`;
  }
  ok(title, `${who.join('; ')}; ${history}`);
});

rmSync(scratch, { recursive: true, force: true });
const count = (k) => results.filter((x) => x === k).length;
console.log(`\njudge: ${results.length} checks — ${count('ok')} ok, ${count('skip')} skipped, ${count('FAIL')} failed`);
console.log('not proven here: that a live model call cost what its receipt says (NEAR AI\'s usage figures are taken as reported); Intel TCB status, GPU evidence and');
console.log('image provenance of the TEE (online verifiers); the walls on a platform other than this one; anything about the private line beyond its imported records.');
process.exit(count('FAIL') ? 1 : 0);
