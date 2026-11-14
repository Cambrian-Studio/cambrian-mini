// The home page and the build replay say only what the record holds: a capital card without a figure is left out,
// the compounding panel counts from the record, and the seven replay lines never borrow a signature, a model
// host or an on-chain record the runs do not carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capitalFigures, councilLine, stakeLine, creditsLine, checkExact } from '../../web/lib/ui.js';
import { compounding, STEPS, lessonsApplied } from '../../web/lib/mini.js';
import { story, playerStates, liveStates, STEP_MS, stationReport, setMembers } from '../../web/screens/line.js';

const at = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const json = (p) => JSON.parse(readFileSync(at(p), 'utf8'));
// these tests read the three imported builds; builds made here since are read by the tests further down
const allRuns = readdirSync(at('data/runs')).map((d) => json(`data/runs/${d}/run.json`));
const runs = allRuns.filter((r) => r.origin === 'private-line');
const product = json('data/products.json').products[0];
const lessons = json('lessons/lessons.json').lessons;

test('the public nav has four items, and Request access is in the header', () => {
  const html = readFileSync(at('web/index.html'), 'utf8');
  const nav = html.slice(html.indexOf('<nav'), html.indexOf('</nav>'));
  assert.deepEqual([...nav.matchAll(/class="cb-nav-btn nav-link"[^>]*>([^<]+)</g)].map((m) => m[1]),
    ['Home', 'Watch a build', 'Products', 'Verify']);
  assert.match(nav, /href="#\/talk"[^>]*aria-label="Talk to Cambrian"/, 'the mark opens Talk to Cambrian');
  const header = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
  assert.match(header, />Request access</);
  assert.match(header, /id="member-menu" hidden/, 'Approvals and notifications sit in the member menu, hidden by default');
  assert.match(readFileSync(at('web/app.js'), 'utf8'), /\n {2}verify: receipts,/, 'the nav says Verify, so #/verify opens that screen too');
});

test('capital cards: a figure the record does not hold leaves its card out', () => {
  const placeholder = { placeholder: true, stake: { amount_near: null, tx: null }, estimate: { usd_per_month: 60, as_of: '2026-11-13' },
    inference_spend: { mini_line_usd: 1.092438, private_line_usd: 5.363208 } };
  assert.deepEqual(capitalFigures(placeholder).map((f) => [f.label, f.value, f.note]), [['Spent on products', '$1.09', 'the builds made here']],
    'only the builds made here are counted; the imported builds are not');
  assert.deepEqual(capitalFigures({ placeholder: true, inference_spend: { mini_line_usd: 0, private_line_usd: 5.363208 } }), []);
  assert.deepEqual(capitalFigures({ placeholder: true }), []);
  assert.deepEqual(capitalFigures(null), []);
  const recorded = capitalFigures({ placeholder: false, stake: { amount_near: 100, tx: 'abc', tx_url: 'https://example.org/tx/abc' },
    credits: { earned_from_stake_usd: 1.5, as_of: '2026-11-14' }, inference_spend: { mini_line_usd: 0.25, private_line_usd: 0 } });
  assert.deepEqual(recorded.map((f) => f.label), ['Staked', 'Credits earned', 'Spent on products']);
  assert.equal(recorded[0].value, '100 NEAR');
  assert.equal(recorded[0].href, 'https://example.org/tx/abc');
  const committed = capitalFigures({ ...json('data/stake.json'), inference_spend: { mini_line_usd: 1.092438, private_line_usd: 5.363208 } });
  assert.deepEqual(committed.map((f) => [f.label, f.value, f.note]), [['Staked', '3,045 NEAR', 'about €10,000 when staked · see the transaction'],
    ['Credits earned', '$1.86', 'NEAR AI reports $60.90 a month'], ['Spent on products', '$1.09', 'the builds made here']],
    'the NEAR amount and its transaction first; credits as NEAR AI reported them, with the day; the earlier estimate gives way to the reported rate');
  const before = json('data/stake.json'); before.credits = { earned_from_stake_usd: null };
  assert.deepEqual(capitalFigures(before).map((f) => [f.label, f.value, f.note])[1], ['NEAR AI’s estimate', '~$60/month in credits', '13 Nov 2026'],
    'with no credits recorded, the estimate is shown as an estimate, with its date');
  assert.match(committed[0].href, /^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.deepEqual(capitalFigures({ placeholder: false, stake: { amount_near: 100, tx: null }, credits: { earned_from_stake_usd: '3' } }), [],
    'a stake without its transaction, or a credit figure that is not a number, is not shown');
});

test('the home page figures count only builds made here, and each says where to check it', () => {
  const summary = allRuns.map((r) => ({ id: r.ticket.id, origin: r.origin ?? 'mini', state: r.state, finished: r.finished,
    attempts: r.attempts.length, usd: r.cost.usd }));
  const rows = compounding({ lessons, runs: summary });
  assert.deepEqual(rows.map((r) => r[0]), ['Lessons in force', 'Lessons that changed a brief', 'First-try passes', 'Cost per working build']);
  assert.deepEqual(rows.map((r) => r[3]), ['#/lessons', '#/line', '#/receipts', '#/receipts'], 'each figure links to the screen that shows its source');
  const here = summary.filter((r) => r.origin !== 'private-line');
  assert.equal(rows[0][1], String(lessons.length));
  assert.equal(rows[1][1], '2', 'write-files-early and no-dependency-auditing changed the briefs built here');
  assert.equal(rows[2][1], `${here.filter((r) => /^green/.test(r.state) && r.attempts === 1).length} of ${here.length}`);
  assert.equal(here.length >= 2, true);
  const spent = here.reduce((s, r) => s + r.usd, 0);
  assert.equal(rows[3][1], `$${(spent / here.filter((r) => /^green/.test(r.state)).length).toFixed(2)}`);
  // the three earlier builds change none of the figures
  assert.deepEqual(compounding({ lessons, runs: here }), rows);
  const empty = compounding({});
  assert.deepEqual(empty.map((r) => r[1]), ['0', null, null, null], 'no build made here: no rate and no cost are shown');
});

test('Watch a build shows the lessons that changed the brief, the earlier build each came from, and the line that cut the idea down', () => {
  const brief = json('data/tickets/upread-mini-086cdf.json');
  const loop = lessonsApplied(brief, lessons);
  assert.deepEqual(loop.rows.map((r) => r.lesson), ['write-files-early', 'no-dependency-auditing']);
  for (const r of loop.rows) {
    assert.match(r.what, /Write files early; do not audit dependency source/);
    assert.match(r.from_run, /^upread-v1-/);
  }
  assert.match(loop.said, /Upread v1 tried all of it at once and timed out/, 'the idea was cut down by pointing at the earlier build that ran out of time');
  assert.equal(loop.said_by, 'member', 'and the record says who wrote that: here the member, not Cambrian');
  assert.deepEqual(lessonsApplied(null, lessons), { rows: [], said: null, said_by: null });
});

test('the replay tells the recorded product in seven lines and claims nothing the runs do not carry', () => {
  const told = story(product, runs, { council: json('data/council.json'), lessons, onChain: [] });
  assert.equal(told.length, 7);
  assert.deepEqual(told.map((s) => s.title), STEPS.map((s) => s[0]));
  const [idea, brief, signed, build, checks, live, record] = told.map((s) => s.line);
  assert.match(idea, /^A member described the idea: Upread\./, 'the record does not say who brought it');
  assert.equal(brief, 'The brief was written, with 7 checks and a $15.00 budget.');
  assert.match(signed, /not in this record/);
  assert.doesNotMatch(signed, /Clemens|JJ|Michael/);
  assert.equal(build, 'Agents built it in a sealed workspace. 22 model calls, $3.98.');
  assert.match(checks, /^Five of seven checks failed and the build stopped\. Four lessons were written from it\./);
  assert.match(checks, /The next build passed on the first try, for \$0\.62\. One more passed after it\.$/);
  assert.match(live, /behind a sign-in\. There is no public link yet\.$/);
  assert.match(record, /^Not recorded on NEAR yet\./);
  assert.equal(story(product, runs, { onChain: runs }).at(-1).line, 'Recorded on NEAR.');
  assert.deepEqual(story(product, []), []);
});

test('the label under "The collective decides" comes from the council file', () => {
  assert.equal(councilLine(json('data/council.json')), 'Founding council: 2 of 3 signatures. The threshold grows with the collective.');
  assert.equal(councilLine(null), 'The threshold grows with the collective.');
});

test('Watch a build plays from the start: one step at a time, and a build running now shows where it stands', () => {
  assert.deepEqual(playerStates(0, 7), ['now', 'off', 'off', 'off', 'off', 'off', 'off'], 'it opens on the first step, not on a finished build');
  assert.deepEqual(playerStates(3, 7), ['on', 'on', 'on', 'now', 'off', 'off', 'off']);
  assert.deepEqual(playerStates(7, 7), Array(7).fill('on'), 'skip to end, and reduced motion, show the finished build');
  assert.ok(STEP_MS >= 2000 && STEP_MS <= 3000, 'two to three seconds a step');
  const running = { state: 'running', stations: { brief: { at: 'a' }, approved: { at: 'b' }, build: { at: 'c' } } };
  assert.deepEqual(liveStates(running), ['on', 'on', 'on', 'now', 'off', 'off', 'off'], 'a live build is building: step four is happening');
  const red = runs.find((r) => r.state === 'red');
  assert.equal(liveStates(red)[4], 'red', 'a failed build shows its checks as failed');
});

test('Watch a build tells a real build from its record and its brief: who sent it, who signed, what it cost, where it is recorded', () => {
  const mine = allRuns.filter((r) => r.ticket.product === 'upread-mini');
  assert.equal(mine.length >= 1, true, 'a build of Upread Mini is on record');
  const brief = json(`data/tickets/${mine[0].ticket.id}.json`);
  const told = story(json('data/products.json').products.find((p) => p.id === 'upread-mini'), mine,
    { council: json('data/council.json'), lessons, onChain: mine.map((r) => ({ value: { on_chain: json(`data/runs/${r.ticket.id}/onchain.json`) } })), brief });
  const [idea, wrote, signed, build, checks, live, record] = told.map((s) => s.line);
  assert.match(idea, /^Clemens described the idea: Upread Mini\./);
  assert.equal(wrote, 'Cambrian wrote the brief, with 4 checks and a $1.00 budget.');
  assert.equal(signed, 'Clemens and Michael signed.');
  assert.equal(build, 'Agents built it in a sealed workspace, with every model call going through NEAR AI. 9 model calls, $0.43.');
  assert.equal(checks, 'Every check passed.');
  assert.match(live, /^A preview link went up/);
  assert.equal(record, 'Recorded on NEAR.');
});

test('a build card names its signers as the council file does', () => {
  const run = allRuns.find((r) => r.ticket.id === 'upread-mini-086cdf');
  setMembers(json('data/council.json'));
  assert.equal(stationReport(run, 'approved', 'on'), 'Signed by Clemens and Michael. Cambrian verified the signatures.');
  setMembers(null);
  assert.equal(stationReport(run, 'approved', 'on'), 'Signed by clemens and michael. Cambrian verified the signatures.', 'without the council file the ids are shown as they are');
});

test('the stake line and the credits line say only what the record holds', () => {
  const stake = json('data/stake.json');
  assert.equal(stakeLine(stake), 'We staked our own capital first: 3,045 NEAR, about €10,000 when staked on 13 Nov, with NEAR AI.');
  assert.equal(stakeLine({ placeholder: true }), null);
  assert.equal(stakeLine({ placeholder: false, stake: { amount_near: 100, tx: 'x', recorded_at: '2026-11-13T14:13:24Z' } }), 'We staked our own capital first: 100 NEAR, with NEAR AI.');
  const shot = 'assets/evidence/nearai-farmed-20261114.png';
  const line = creditsLine(stake);
  assert.deepEqual([line.text, line.reported, line.day, line.evidence], ['Credits earned $1.86 · NEAR AI reports $60.90 a month', 'as reported by NEAR AI', '14 Nov', shot]);
  assert.match(line.tx, /^https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]{43,44}$/, 'the statement of it is logged on NEAR');
  assert.equal(stake.credits.source, 'NEAR AI dashboard, screenshot 14 Nov');
  assert.equal(stake.credits.bought_usd, null, 'what was bought is not in the record');
  assert.ok(existsSync(at(`web/${shot}`)), 'the cropped screenshot is in the repository');
  assert.equal(creditsLine({ ...stake, credits: { earned_from_stake_usd: 1.7 } }), null, 'no figure without the day it was reported');
  assert.equal(creditsLine({ ...stake, credits: { earned_from_stake_usd: 1.7, as_of: '2026-11-14' } }).text, 'Credits earned $1.70', 'no rate, no rate shown');
  const card = capitalFigures(stake).find((f) => f.label === 'Credits earned');
  assert.deepEqual([card.value, card.note, card.href], ['$1.86', 'NEAR AI reports $60.90 a month', shot]);
  for (const f of ['web/screens/home.js', 'web/lib/ui.js', 'web/index.html']) {
    assert.doesNotMatch(readFileSync(at(f), 'utf8'), /<img[^>]*evidence|h\('img[^)]*evidence/, 'the screenshot is linked, never shown on a page');
  }
  const figures = capitalFigures({ ...stake, inference_spend: { mini_line_usd: 1.09, private_line_usd: 5.36 } });
  assert.equal(figures[0].note, 'about €10,000 when staked · see the transaction');
  assert.equal(creditsLine({ ...stake, credits: { ...stake.credits, earned_from_stake_usd: null } }), null, 'nothing is shown while no credits are recorded');
});

test('the signing screen shows what a signature covers: the task in full and each check exactly as it runs', () => {
  const brief = json('data/tickets/postmark-6ee0a5.json').ticket;
  const ui = readFileSync(at('web/lib/ui.js'), 'utf8');
  assert.match(ui, /cap\('what the builder is told, in full'\), h\('p\.task', \{\}, b\.task\)/, 'the task is rendered whole, beside the goal');
  assert.equal(checkExact(brief.green[0]), 'run: node test.mjs  (no network)');
  assert.match(checkExact(brief.green[3]), /^file: app\.js; matches none of \/\[Dd\]ebug\|\[Bb\]ypass/);
  assert.equal(checkExact({ kind: 'run', run: 'npm ci && npm test', network: 'registry' }), 'run: npm ci && npm test  (package registry reachable)');
  const page = readFileSync(at('web/screens/approvals.js'), 'utf8');
  assert.match(page, /const expected = await approvalChallenge\(await approvalSubject\(await hashOfAsync\(t\), taste_note\)\);/);
  assert.match(page, /if \(options\.challenge !== expected\) throw new Error/, 'the page refuses a challenge it did not work out itself');
});

test('every file the browser loads parses', async () => {
  // a screen that no test imports can still be broken: each file is parsed here the way a browser would refuse it
  const { execFileSync } = await import('node:child_process');
  const files = ['web/app.js', ...['screens', 'lib'].flatMap((d) => readdirSync(at(`web/${d}`)).filter((n) => /\.m?js$/.test(n)).map((n) => `web/${d}/${n}`))];
  assert.ok(files.length >= 12, String(files.length));
  for (const f of files) assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', at(f)], { stdio: 'pipe' }), f);
});
