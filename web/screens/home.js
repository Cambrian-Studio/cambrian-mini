// Home: seven beats, top to bottom. The thesis, the collective, the capital, the decision, the machine,
// the proof and the door. Every figure is read from the record; one that is missing says so.

import * as api from '../lib/api.js';
import {
  h, put, card, dot, kv, usd, count, short, plural, stateChip, originChip, capitalCards, capitalCopy, quorumLabel,
} from '../lib/ui.js';
import { memberCard } from './approvals.js';
import { productCard } from './products.js';

const REPO = 'https://github.com/Cambrian-Studio/cambrian-line';
const STATIONS = [
  [{ tl: 'Brief', tr: '01' }, 'Cambrian turns the idea into a ticket with checks and a budget.'],
  [{ tl: 'Build', tr: '02', bl: 'Behind walls' },
    'Agents write the code inside a sandbox. Every model call goes through NEAR AI and is priced.'],
  [{ tl: 'Checks', tr: '03' }, 'Every check runs on a fresh clone. A red run stops the line and drafts a lesson.'],
  [{ tl: 'Preview', tr: '04' }, 'A green build is pushed to its own branch and deployed as a preview.'],
];

const beat = (eyebrow, title, body, ...kids) => h('section.beat', {},
  h('p.eyebrow', {}, eyebrow), h('h2.h2', {}, title), body ? h('p.body', {}, body) : null, kids);

// The decision: the newest brief with the council's seats. With no brief in the record, it says so.
function decision(tickets, council) {
  const members = council?.members || [];
  const entry = tickets[0] || null;
  const valid = entry?.release?.valid || [];
  const t = entry?.ticket || {};
  const applied = (entry?.lint?.applied || [])[0];
  const brief = entry
    ? card('a.pad.brief-mini', {
      tl: 'Brief', tr: entry.proposed_by?.member ? `From ${nameOf(members, entry.proposed_by.member)}` : null,
      bl: `${short(entry.ticket_sha256)}…`, br: stateChip(entry.status),
    }, { href: '#/approvals/' + encodeURIComponent(t.id) },
    h('span.title', {}, t.title || t.id), h('span.line', {}, t.goal || t.task || ''), h('span.spacer'),
    h('div.kvs', {}, kv('Checks', count((t.green || []).length)), kv('Budget', usd(t.budget?.usd)),
      applied ? kv('Lesson applied', applied.lesson || applied.id || String(applied)) : null))
    : card('div.pad.brief-mini', { tl: 'Brief', br: 'None in this record' }, {},
      h('span.line', {}, 'No brief has been signed in this record yet. The recorded Upread runs were approved on '
        + 'Cambrian’s private line; that signature is not in this record and cannot be checked here.'),
      h('span.spacer'), h('a.link', { href: '#/approvals' }, 'See the council'));
  const seats = members.map((m) => {
    const signed = valid.includes(m.id);
    return memberCard(m, { small: true, selected: signed, br: signed ? [dot(), 'Signed'] : (entry ? 'Waiting' : null) });
  });
  return h('div.decision', {}, brief, seats);
}

const nameOf = (members, id) => members.find((m) => m.id === id)?.name || id;

function receiptsCard(receipts) {
  const latest = [...receipts].sort((a, b) => String(b.finished).localeCompare(String(a.finished)));
  const total = receipts.reduce((sum, r) => sum + (Number(r.usd) || 0), 0);
  return card('div.pad.listcard', { tl: 'Receipts', tr: 'Every run', br: receipts.length ? `${usd(total)} total` : null }, {},
    latest.slice(0, 4).map((r) => h('a.item', { href: '#/receipts/' + encodeURIComponent(r.id) },
      h('span', {}, h('span', {}, r.title || r.id),
        h('span.cap', {}, stateChip(r.state), ` · ${plural(r.calls, 'call')}`), originChip(r)),
      h('span', {}, usd(r.usd)))),
    latest.length ? null : h('p.plain', {}, 'No run has finished yet.'),
    h('span.spacer'),
    latest.length ? h('a.btn.ghost', { href: '#/receipts/' + encodeURIComponent(latest[0].id) }, 'Verify a receipt') : null);
}

function lessonsCard(lessons, runs) {
  const title = (id) => runs.find((r) => r.id === id)?.title || id;
  return card('div.pad.listcard', {
    tl: 'Lessons', tr: lessons.length ? plural(lessons.length, 'rule') : null, bl: 'Checked on every new brief',
  }, {},
  lessons.slice(0, 3).map((l) => h('div.item', {}, h('span', {}, h('span.clamp', {}, l.rule || l.id),
    h('span.sub', {}, l.from_run ? `From the run “${title(l.from_run)}”.` : 'Not tied to one run.')))),
  lessons.length ? null : h('p.plain', {}, 'No rule is recorded yet.'),
  h('span.spacer'), h('a.btn.ghost', { href: '#/lessons' }, 'Read the lessons'));
}

export async function render(root) {
  const names = ['runs.json', 'products.json', 'receipts.json', 'stake.json', 'tickets.json', 'council.json', 'lessons.json'];
  const read = await Promise.allSettled(names.map((n) => api.get(n)));
  const doc = (i) => (read[i].status === 'fulfilled' ? read[i].value : {});
  const runs = doc(0).runs || [];
  const products = doc(1).products || [];
  const receipts = doc(2).receipts || [];
  const stake = doc(3);
  const tickets = doc(4).tickets || [];
  const council = read[5].status === 'fulfilled' ? doc(5) : null;
  const lessons = doc(6).lessons || [];
  const live = api.isLive();
  // the latest live product, else the latest one recorded
  const index = Math.max(products.findLastIndex((p) => p.live_url), products.length - 1);
  const product = products[index] || null;
  const capital = capitalCopy(stake);

  put(root,
    h('section.beat.hero', {},
      h('p.eyebrow', {}, 'NEAR HACKATHON'),
      h('h1', {}, 'Machines build. The collective decides.'),
      h('p.lede', {}, 'The design: pool the ecosystem’s idle capital and talent into productive use. '
        + 'Members bring the ideas and the taste. Cambrian builds. The council decides what gets built.'),
      h('div.actions', {},
        h('a.btn.tall', { href: '#/line' }, live ? 'Watch the line' : 'Watch a build, replayed'),
        h('a.btn.ghost.tall', { href: REPO, target: '_blank', rel: 'noopener noreferrer' }, 'Read the repo'))),

    beat('The collective', 'Builders, thinkers and doers with one shared context.',
      'Cambrian is the intelligence that serves them. It knows the work, proposes and builds. People decide.',
      council ? h('div.cb-members.flush', {}, council.members.map((m) => memberCard(m, {
        bl: m.role || 'Council', br: [dot(), 'Team'], attrs: { tabindex: '0' },
      }))) : h('p.plain', {}, 'The council record could not be read.')),

    beat('The capital', capital.title, capital.body,
      capitalCards(stake),
      h('p.sub', {}, 'Pooling the collective’s capital is next. ', h('a.link', { href: '#/stake' }, 'See the figures'))),

    beat('The decision', 'Nothing is built until the collective signs.',
      'A member brings an idea. Cambrian writes the brief: what it is, the checks it must pass, the budget. '
      + `The collective signs with passkeys, and the line refuses anything below the threshold. Today: ${quorumLabel(council)}.`,
      decision(tickets, council)),

    beat('The machine', 'Agents build behind walls, with NEAR AI.', null,
      h('div.machine', {}, STATIONS.map(([caps, text]) => card('div.pad.cb-card2', caps, {}, h('span', {}, text))))),

    beat('The proof', 'Every run left a receipt.',
      'Every failure becomes a lesson: a red run drafts one, a council member accepts it, '
      + 'and the next brief is checked against it.',
      h('div.proof', {},
        product ? productCard(product, index) : card('div.pad', { tl: 'Product' }, {}, h('p.plain', {}, 'No product is recorded yet.')),
        receiptsCard(receipts), lessonsCard(lessons, runs))),

    h('section.beat.door', {},
      h('h2.h2', {}, 'The Cambrian explosion has started. Join the collective driving it.'),
      h('a.btn.tall', { href: 'https://cambriancollective.xyz', target: '_blank', rel: 'noopener' }, 'Request access')));
}
