// Home: one scrolling page. The thesis, how an idea goes live, why it compounds, the capital, the collective,
// how to check it, and the door. Every figure is read from the record; a figure the record does not hold is
// left out, never estimated.

import * as api from '../lib/api.js';
import { h, put, card, dot, capitalCards, councilLine, ACCESS, REPO } from '../lib/ui.js';
import { STEPS, compounding } from '../lib/mini.js';
import { memberCard } from './approvals.js';

const COMPOUNDS = [
  ['What we build.', 'Every failure becomes a rule the collective signs. Every later brief is checked against it.', null],
  ['How it looks.', 'Every product ships in the collective’s own design language, not generic AI defaults.', null],
  ['How it sells.', 'Which channels worked, which campaigns paid back, what users kept. Each launch teaches the next one.', 'Next'],
];

const section = (name, title, body, ...kids) => h('section.beat', { 'data-section': name },
  h('h2.h2', {}, title), body ? h('p.body', {}, body) : null, kids);

export async function render(root) {
  const names = ['runs.json', 'products.json', 'stake.json', 'council.json', 'lessons.json'];
  const read = await Promise.allSettled(names.map((n) => api.get(n)));
  const doc = (i) => (read[i].status === 'fulfilled' ? read[i].value : {});
  const runs = doc(0).runs || [];
  const products = doc(1).products || [];
  const stake = doc(2);
  const council = read[3].status === 'fulfilled' ? doc(3) : null;
  const lessons = doc(4).lessons || [];
  const out = { target: '_blank', rel: 'noopener noreferrer' };

  put(root,
    h('section.beat.hero', { 'data-section': 'hero' },
      h('p.eyebrow', {}, 'CAMBRIAN MINI · NEAR HACKATHON'),
      h('h1', {}, 'Machines build. The collective decides.'),
      h('p.lede', {}, 'Cambrian is a product studio run by one intelligence and owned by its members. '
        + 'Members bring ideas, taste and capital. Cambrian turns them into products, and gets better with every one it ships.'),
      h('div.actions', {},
        h('a.btn.tall', { href: '#/line' }, 'Watch an idea become a product'),
        h('a.btn.ghost.tall', { href: ACCESS, ...out }, 'Request access')),
      h('p.sub.fine', {}, 'Cambrian Mini is the part of Cambrian we opened for the NEAR hackathon: '
        + 'the path from an idea to a live product, with every step on the record.')),

    section('steps', 'From an idea to a live product, in seven steps.', null,
      h('ol.steps', {}, STEPS.map(([title, line], i) => h('li', {},
        h('a', { href: `#/line/${i + 1}`, 'aria-label': `Step ${i + 1}: ${title} Open the recorded example.` },
          h('span.num', {}, String(i + 1).padStart(2, '0')),
          h('b', {}, title), h('span', {}, line),
          i === 2 ? h('span.cap', {}, councilLine(council)) : null))))),

    section('compounds', 'Every product makes the next one better.', null,
      h('div.trio', {}, COMPOUNDS.map(([title, line, next]) => card('div.pad.say', { br: next }, {},
        h('b', {}, title), h('span', {}, line)))),
      card('div.pad.cb-card2.panel', {}, {}, compounding({ products, lessons, runs }).map(([label, value, note]) =>
        h('div.stat', {}, h('span.cap', {}, label),
          h('span.big', { class: value ? '' : 'is-none' }, value || 'Not recorded'), h('span.sub', {}, note))))),

    section('capital', 'Idle capital, put to work.',
      'Most capital in this ecosystem sits still, in treasuries, staked tokens and funds waiting to deploy. '
      + 'NEAR AI lets you stake NEAR and receive AI compute credits in return. The NEAR stays staked and stays yours. '
      + 'Cambrian puts the credits to work, and the collective decides what they build.',
      capitalCards(stake),
      h('p.sub', {}, h('a.link', { href: '#/stake' }, 'See the figures'))),

    section('collective', 'A collective, not a crowd.',
      'Cambrian Collective is invitation-only. Builders, designers, engineers and backers shape what gets made, '
      + 'with their work or their capital. Three founding members today. Built for a hundred.',
      h('div.cb-members.flush.four', {},
        (council?.members || []).map((m) => memberCard(m, { bl: m.role || 'Council', br: [dot(), 'Team'] })),
        card('a.cb-member.invite', { br: 'By invitation' }, { href: ACCESS, ...out, 'aria-label': 'By invitation. Request access.' }))),

    section('check', 'Don’t take our word for it.',
      'Every signature, every model call and every record of what a build cost can be checked without trusting our servers.',
      h('div.actions', {},
        h('a.btn.tall', { href: '#/receipts' }, 'Verify a build'),
        h('a.btn.ghost.tall', { href: REPO, ...out }, 'Run it yourself'))),

    h('section.beat.door', { 'data-section': 'close' },
      h('h2.h2', {}, 'The Cambrian explosion has started. Join the collective driving it.'),
      h('a.btn.tall', { href: ACCESS, ...out }, 'Request access')));
}
