// Stake: what is recorded about the members' stake, as separate facts, each with its source.
// The page never says the stake paid for the builds: what each build cost is on its receipt.

import * as api from '../lib/api.js';
import { h, put, card, kv, usd, when, ext, count, capitalCards, creditSplit } from '../lib/ui.js';

export async function render(root) {
  const doc = await api.get('stake.json');
  const empty = doc.placeholder === true;
  const s = doc.stake || {};
  const rate = doc.credit_rate || {};
  const spend = doc.inference_spend || {};
  const credits = doc.credits || {};
  const est = doc.estimate || {};
  const tx = s.tx_url ? ext(s.tx_url, 'the transaction on a NEAR explorer') : null;
  const money = (n) => (typeof n === 'number' ? usd(n) : 'not yet recorded');

  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Stake'), h('h1.statement', {}, 'The stake and the spend, as separate facts.'),
      h('p.lede', {}, 'These are the recorded facts, one by one, each with where it comes from.'),
      empty ? h('p.banner', { role: 'status' }, 'Not yet recorded. Recording the stake transaction is next.') : null,
      doc.note ? h('p.note', {}, doc.note) : null),
    capitalCards(doc),
    empty ? null : card('div.pad', { tl: 'The stake', tr: s.network ? `NEAR ${s.network}` : null }, {},
      h('div.kvs', {},
        kv('Staked', typeof s.amount_near === 'number' ? `${count(s.amount_near)} NEAR` : 'not yet recorded'),
        kv('Account', s.account || 'not yet recorded'),
        s.staked_with ? kv('Staked with', s.staked_with) : null,
        kv('Transaction', s.tx ? h('span.raw', {}, s.tx) : 'not yet recorded'),
        s.recorded_at ? kv('Recorded', when(s.recorded_at)) : null),
      tx ? h('p.small', {}, tx) : null,
      est.text && est.as_of ? h('p.small.dim', {}, `${est.by || 'NEAR AI'}’s estimate: ${est.text}, as of ${est.as_of}. `
        + 'An estimate, not credits received.') : null),
    h('div.cb-card.cb-card2.formula', {},
      h('span.cap', {}, 'What NEAR AI publishes about credits'),
      rate.text ? h('span.rate', {}, rate.text) : h('p.plain', {}, 'Not yet recorded.'),
      h('p.small.dim', {}, 'This is NEAR AI’s statement, not a measurement of these builds. ',
        rate.source_url ? ext(rate.source_url, 'NEAR AI documentation') : null,
        rate.read_at ? ` · read ${rate.read_at}` : '',
        rate.calculator_url ? ' · ' : '', rate.calculator_url ? ext(rate.calculator_url, 'NEAR AI’s calculator') : null)),
    card('div.pad', { tl: 'Credits', tr: 'The account, not a build' }, {},
      h('div.split', {}, creditSplit(doc).map(([label, value]) => h('div', {},
        h('span.big', { class: value.startsWith('$') ? '' : 'is-none' }, value), h('span.cap', {}, label)))),
      h('p.small.dim', {}, 'Earned and bought are read from the NEAR AI account when they are recorded',
        credits.source ? ` (${credits.source}${credits.read_at ? `, read ${credits.read_at}` : ''}).` : '.',
        ' Spent is the sum of the receipts below. No receipt says which credits paid for it.')),
    card('div.pad', { tl: 'Compute', tr: 'From the receipts' }, {},
      h('div.kvs', {},
        kv('Model calls on Cambrian Mini', money(spend.mini_line_usd)),
        kv('Model calls on Cambrian’s private setup, imported builds', money(spend.private_line_usd)),
        typeof spend.runs === 'number' ? kv('Runs in this record', count(spend.runs)) : null,
        spend.source ? kv('Source', spend.source) : null)),
    card('div.pad', { tl: 'What this page does not claim' }, {},
      h('p', {}, 'These facts stand side by side. None of them says the stake paid for the builds. '
        + 'What each build cost is measured separately, call by call, and written on the run’s receipt.'),
      h('div.actions', {}, h('a.btn.ghost', { href: '#/receipts' }, 'See what each run cost'))));
}
