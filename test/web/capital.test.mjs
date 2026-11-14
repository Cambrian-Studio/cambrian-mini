// What the screens say about the stake depends on the record: while data/stake.json is a placeholder nothing
// is said about staking; once a stake is recorded one sentence is, and it never ties the stake to a build.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { capitalCopy, creditSplit, CAPITAL_RECORDED } from '../../web/lib/ui.js';

const committed = JSON.parse(readFileSync(fileURLToPath(new URL('../../data/stake.json', import.meta.url)), 'utf8'));
const words = (c) => [c.title, c.body].filter(Boolean).join(' ');

test('the capital beat: no stake line while the stake is a placeholder, the ruled sentence once it is recorded', () => {
  for (const doc of [{ placeholder: true }, {}, null, undefined, committed.placeholder === true ? committed : { placeholder: true }]) {
    assert.doesNotMatch(words(capitalCopy(doc)), /stak|credit|earn/i, 'a placeholder says nothing about staking');
  }
  const recorded = capitalCopy({ placeholder: false, stake: { amount_near: 100, tx: 'abc' } });
  assert.equal(recorded.title, 'Staked NEAR earns compute credits on NEAR AI.', 'and nothing about what paid for a build');
  assert.equal(recorded.title, CAPITAL_RECORDED);
  assert.equal(recorded.body, null);
  for (const doc of [{ placeholder: true }, { placeholder: false }]) {
    assert.doesNotMatch(words(capitalCopy(doc)), /paid for|pays for|paid by/i, 'never that the stake paid for a build');
  }
});

test('the credit split: a figure that is not in the record reads "not recorded yet", never 0 and never a guess', () => {
  const none = creditSplit({ credits: { earned_from_stake_usd: null, bought_usd: null }, inference_spend: {} });
  assert.deepEqual(none, [['earned from the stake', 'not recorded yet'], ['bought', 'not recorded yet'], ['spent', 'not recorded yet']]);
  assert.deepEqual(creditSplit({}).map((r) => r[1]), ['not recorded yet', 'not recorded yet', 'not recorded yet']);
  const some = creditSplit({ credits: { earned_from_stake_usd: 1.5, bought_usd: 0 },
    inference_spend: { mini_line_usd: 0.25, private_line_usd: 5.11 } });
  assert.deepEqual(some, [['earned from the stake', '$1.50'], ['bought', '$0.00'], ['spent', '$5.36']]);
  assert.deepEqual(creditSplit({ credits: { earned_from_stake_usd: '3', bought_usd: NaN } }).map((r) => r[1]).slice(0, 2),
    ['not recorded yet', 'not recorded yet'], 'only a recorded number is shown');
  assert.equal(committed.credits.earned_from_stake_usd, 1.85943039, 'as NEAR AI\'s dashboard showed it on 14 Nov');
  assert.equal(committed.credits.bought_usd, null);
});
