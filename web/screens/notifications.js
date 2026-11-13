// Notifications: briefs waiting for the council, each signature given, and what the line reported, newest first.

import * as api from '../lib/api.js';
import { h, put, when, originChip } from '../lib/ui.js';

// What happened, as one plain sentence. The text the line sent at the time is kept under it, word for word.
function report(n, title) {
  const what = title || n.ticket || n.run || 'A run';
  if (n.kind === 'GREEN') return `${what} built cleanly.`;
  if (n.kind === 'RED') return `${what} went red.`;
  if (n.kind === 'WAITING') return `${what} waits for the council. ${n.signed} of ${n.threshold} signed.`;
  if (n.kind === 'SIGNED') return `${n.member} signed the brief “${what}”.`;
  return null;
}

export async function render(root) {
  const [{ notifications = [] }, tickets, runs, council] = await Promise.all([
    api.get('notifications.json'), api.get('tickets.json').catch(() => ({ tickets: [] })),
    api.get('runs.json').catch(() => ({ runs: [] })), api.get('council.json').catch(() => null),
  ]);
  const titles = new Map((runs.runs || []).map((r) => [r.id, r.title]));
  const name = (id) => (council?.members || []).find((m) => m.id === id)?.name || id;
  // A brief that still needs signatures is the one thing a council member has to act on.
  const waiting = (tickets.tickets || []).filter((t) => t.status === 'awaiting-approval').map((t) => ({
    ts: t.created, kind: 'WAITING', ticket: t.ticket?.id, title: t.ticket?.title,
    signed: (t.release?.valid || []).length, threshold: t.release?.threshold ?? 2,
  }));
  // Every valid signature on a brief, read from the tickets.
  const signed = (tickets.tickets || []).flatMap((t) => (t.approvals || [])
    .filter((a) => (t.release?.valid || []).includes(a.member))
    .map((a) => ({ ts: a.at, kind: 'SIGNED', ticket: t.ticket?.id, title: t.ticket?.title, member: name(a.member) })));
  const list = [...waiting, ...[...notifications, ...signed].sort((a, b) => String(b.ts).localeCompare(String(a.ts)))];
  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Notifications'), h('h1.statement', {}, 'What Cambrian told the council.'),
      h('p.lede', {}, 'A brief is waiting, a member signed, a run went green, a run went red.')),
    list.length ? h('ul.notes', {}, list.map((n) => {
      const href = n.run ? '#/receipts/' + encodeURIComponent(n.run)
        : (n.ticket ? '#/approvals/' + encodeURIComponent(n.ticket) : null);
      const said = report(n, n.title || titles.get(n.run));
      const body = [
        h('span.age', {}, when(n.ts)),
        h('span.note-text', {}, said || n.text || ''),
        said && n.text ? h('span.note-raw', {}, n.text) : null,
        originChip(n),
      ];
      return h('li.cb-card.cb-card2', {}, href ? h('a', { href }, body) : h('div', {}, body));
    })) : h('p.plain', {}, 'Nothing has been sent yet.'));
}
