// The home page and the build replay say only what the record holds: a capital card without a figure is left out,
// the compounding panel counts from the record, and the seven replay lines never borrow a signature, a model
// host or an on-chain record the runs do not carry.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capitalFigures, councilLine } from '../../web/lib/ui.js';
import { compounding, STEPS } from '../../web/lib/mini.js';
import { story } from '../../web/screens/line.js';

const at = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const json = (p) => JSON.parse(readFileSync(at(p), 'utf8'));
const runs = readdirSync(at('data/runs')).map((d) => json(`data/runs/${d}/run.json`));
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
});

test('capital cards: a figure the record does not hold leaves its card out', () => {
  const placeholder = { ...json('data/stake.json'), inference_spend: { mini_line_usd: 0, private_line_usd: 5.363208 } };
  assert.deepEqual(capitalFigures(placeholder).map((f) => [f.label, f.value]), [['Spent on products', '$5.36']]);
  assert.deepEqual(capitalFigures({ placeholder: true }), []);
  assert.deepEqual(capitalFigures(null), []);
  const recorded = capitalFigures({ placeholder: false, stake: { amount_near: 100, tx: 'abc', tx_url: 'https://example.org/tx/abc' },
    credits: { earned_from_stake_usd: 1.5 }, inference_spend: { mini_line_usd: 0.25, private_line_usd: 0 } });
  assert.deepEqual(recorded.map((f) => f.label), ['Staked', 'Credits received', 'Spent on products']);
  assert.equal(recorded[0].value, '100 NEAR');
  assert.equal(recorded[0].href, 'https://example.org/tx/abc');
  assert.deepEqual(capitalFigures({ placeholder: false, stake: { amount_near: 100, tx: null }, credits: { earned_from_stake_usd: '3' } }), [],
    'a stake without its transaction, or a credit figure that is not a number, is not shown');
});

test('the compounding panel counts from the record', () => {
  const summary = runs.map((r) => ({ state: r.state, finished: r.finished, attempts: r.attempts.length, usd: r.cost.usd }));
  const panel = Object.fromEntries(compounding({ products: [product], lessons, runs: summary }).map(([k, v, note]) => [k, [v, note]]));
  assert.deepEqual(Object.keys(panel), ['Products shipped', 'Lessons signed', 'First-try pass rate', 'Cost per working build']);
  assert.equal(panel['Products shipped'][0], '0', 'no product in the record has a public link');
  assert.equal(panel['Lessons signed'][0], String(lessons.filter((l) => l.accepted_by).length));
  assert.equal(panel['First-try pass rate'][0], '33%');
  assert.match(panel['First-try pass rate'][1], /^1 of 3 /);
  assert.equal(panel['Cost per working build'][0], '$2.68');
  const empty = compounding({});
  assert.equal(empty[2][2], '0 of 0 recorded builds');
  assert.equal(empty[2][1], null, 'no rate without a build');
  assert.equal(empty[3][1], null, 'no cost without a working build');
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
