// Products: a card per product and a sheet with its cost and the runs that built it.

import * as api from '../lib/api.js';
import { revisionLine } from '../lib/mini.js';
import {
  h, put, cap, card, dot, kv, raw, usd, count, when, ext, stateChip, isImported, IMPORTED, openSheet, squircle, field,
} from '../lib/ui.js';

const isRed = (r) => r.state === 'red';
const WORDS = ['none', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

// "3, one red": how many runs built it, and how many of them ended red.
function builds(p) {
  const runs = p.runs || [];
  const reds = runs.filter(isRed).length;
  return `${count(runs.length)}${reds ? `, ${WORDS[reds] || reds} red` : ''}`;
}

// One product, as a card: its name, who brought it, which product it is, and LIVE only when it is.
export function productCard(p, i) {
  const live = Boolean(p.live_url);
  return card('a.pad.product', {
    tl: p.name || p.id, tr: p.proposed_by ? `From ${p.proposed_by}` : null,
    bl: `Product ${i + 1}`, br: live ? [dot(), 'Live'] : 'No public link yet',
  }, { href: '#/products/' + encodeURIComponent(p.id) },
  field(p.id), squircle(p.id, true),
  h('span.product-name', {}, p.name || p.id), h('span.product-sub', {}, p.tagline || ''),
  h('span.spacer'),
  h('div.product-foot', {}, h('div.kvs', {}, kv('Builds', builds(p)), kv('Compute', usd(p.cost_usd)))));
}

// Who signed the briefs behind this product, read from the tickets in the record.
function signedBy(p, tickets, council) {
  const name = (id) => (council?.members || []).find((m) => m.id === id)?.name || id;
  const mine = tickets.filter((e) => e.ticket?.product === p.id);
  const who = [...new Set(mine.flatMap((e) => e.release?.valid || []))].map(name);
  if (who.length) return who.join(', ');
  if ((p.runs || []).some(isImported)) return 'on Cambrian’s private setup, not verifiable here';
  return 'no signature recorded';
}

// "Design pass by JJ · v1 → v2", with both previews linked when the record holds them.
export function revisionNote(run, runs, council) {
  const rev = revisionLine(run, runs, council);
  if (!rev) return null;
  const out = { target: '_blank', rel: 'noopener noreferrer' };
  return h('span.small.revision', {}, [rev.text, rev.versions].filter(Boolean).join(' · '),
    rev.previews[0] ? [' · ', h('a.link', { href: rev.previews[0], ...out }, 'preview before')] : null,
    rev.previews[1] ? [' · ', h('a.link', { href: rev.previews[1], ...out }, 'preview after')] : null);
}

function sheet(p, { lessons, tickets, council }) {
  const runs = p.runs || [];
  const ids = new Set(runs.map((r) => r.id));
  const learned = lessons.filter((l) => l.from_product === p.id || ids.has(l.from_run)).length;
  return h('div.stack', {},
    h('div.product-top', {}, squircle(p.id, true),
      h('div', {}, h('h2.product-name', {}, p.name || p.id), h('p', {}, p.tagline || ''))),
    h('div.kvs', {},
      kv('Builds', builds(p)), kv('Compute', usd(p.cost_usd)), kv('Lessons', count(learned)), kv('Signed', signedBy(p, tickets, council))),
    h('a.link', { href: '#/lessons' }, 'Read the lessons'),
    p.cost_note ? h('p.small.dim', {}, p.cost_note) : null,
    h('div.kvs', {},
      p.status ? kv('Status', p.status) : null,
      p.built_on ? kv('Built on', p.built_on) : null,
      p.repo ? kv('Repository', raw(p.repo)) : null),
    h('div', {}, cap('runs and their receipts'),
      runs.length ? h('ul.rows', {}, runs.map((r) => h('li', {},
        h('a', { href: '#/receipts/' + encodeURIComponent(r.id) },
          h('span', {}, r.title || r.id),
          h('span.row.start', {}, stateChip(r.state), h('span.mono.small', {}, usd(r.usd)))),
        h('span.small.dim', {}, [when(r.finished), isImported(r) ? IMPORTED : null].filter(Boolean).join(' · ')),
        revisionNote(r, runs, council))))
        : h('p.plain', {}, 'No build of this product is recorded yet.')),
    (p.history || []).length ? h('div', {}, cap('history: earlier builds, not built here'),
      p.history_note ? h('p.small.dim', {}, p.history_note) : null,
      h('ul.rows', {}, p.history.map((r) => h('li', {},
        h('a', { href: '#/receipts/' + encodeURIComponent(r.id) },
          h('span', {}, r.title || r.id),
          h('span.row.start', {}, stateChip(r.state), h('span.mono.small', {}, usd(r.usd)))),
        h('span.small.dim', {}, [when(r.finished), IMPORTED].filter(Boolean).join(' · ')))))) : null,
    p.live_url
      ? h('p', {}, h('a.btn', { href: p.live_url, target: '_blank', rel: 'noopener noreferrer' }, `Try ${p.name || 'it'}`))
      : card('div.pad.cb-card2', { tl: 'Live link' }, {}, h('p', {}, 'No public link yet.'),
        p.live_url_note ? h('p.small.dim', {}, p.live_url_note) : null),
    p.live_url ? h('p.small.dim.mono', {}, ext(p.live_url)) : null);
}

export async function render(root, arg) {
  const { products = [] } = await api.get('products.json');
  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Products'), h('h1.statement', {}, 'What Cambrian has built.'),
      h('p.lede', {}, 'Each product links to every run that built it, red ones included.')),
    products.length ? h('div.products', {}, products.map(productCard))
      : h('p.plain', {}, 'No product is recorded yet.'));
  if (arg) {
    const p = products.find((x) => x.id === arg);
    const [lessons, tickets, council] = await Promise.all(['lessons.json', 'tickets.json', 'council.json']
      .map((n) => api.get(n).catch(() => ({}))));
    openSheet({
      label: 'Product',
      body: p ? sheet(p, { lessons: lessons.lessons || [], tickets: tickets.tickets || [], council })
        : h('p.plain', {}, `There is no product called “${arg}”.`),
      onClose: () => { location.hash = '#/products'; },
    });
  }
}
