// Lessons: every rule, the failure it came from, where it later fired, and drafts waiting for the council.

import * as api from '../lib/api.js';
import { verifyMemberSignature, getAssertion, passkeysAvailable } from '../lib/webauthn.mjs';
import { h, put, cap, card, dot, kv, raw, usd, when, short, toast, stateChip, isImported, EARLIER } from '../lib/ui.js';

const FIX = { refuse: 'a brief that breaks it is refused', replace: 'the brief is corrected', append: 'a line is added to the task',
  say: 'the rule is told to the builder' };

function acceptBlock(d, council) {
  const m = api.mode();
  const canSign = m.mode === 'live' && m.can_sign !== false;
  const note = h('p.note', { hidden: true, role: 'status' });
  if (!canSign) {
    return h('div.stack', {},
      h('button.btn.ghost.small', { type: 'button', onclick: () => {
        note.hidden = false;
        note.textContent = `This asks a council member's device for a passkey signature over the lesson hash `
          + `${short(d.sha256)}…. Once accepted, the rule is applied to every new brief.`;
      } }, 'Accept with passkey'), note);
  }
  const members = (council?.members || []).filter((x) => (x.credentials || []).length);
  if (!members.length || !passkeysAvailable()) return h('p.note', {}, 'No council passkey is available in this browser.');
  return h('div.stack', {}, cap('accept with passkey, as'),
    h('div.row.start', {}, members.map((member) => h('button.btn.small', { type: 'button', onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const options = await api.post('lessons/options', { lesson_id: d.id, member: member.id });
        const assertion = await getAssertion(options);
        await api.post('lessons/accept', { lesson_id: d.id, member: member.id, ...assertion });
        api.forgetAll();
        toast(`${member.name} accepted the lesson.`, 'green');
        window.dispatchEvent(new HashChangeEvent('hashchange'));
      } catch (err) {
        btn.disabled = false;
        toast(`Not accepted: ${err.message}`, 'red');
      }
    } }, member.name))));
}

// Who accepted a lesson. A lesson accepted with a passkey carries the signature, which can be checked here.
function acceptedBy(l, council) {
  const a = l.acceptance?.approval;
  if (!l.accepted_by) return null;
  const result = h('span.small', { role: 'status' });
  return h('div', {}, cap('accepted by'),
    h('div.row', {},
      h('span', {}, h('b', {}, l.accepted_by), h('span.dim', {}, `  ${when(l.acceptance?.at)}`)),
      a && council ? h('button.textbtn', { type: 'button', onclick: async () => {
        const r = await verifyMemberSignature({ purpose: 'lesson', subjectHash: a.lesson_sha256, approval: a, council });
        result.replaceChildren(r.ok ? dot() : null, r.ok ? ' Valid signature over the lesson hash.' : `Not valid: ${r.why}`);
      } }, 'Verify signature') : null),
    result);
}

function firedRow(f) {
  const href = f.run ? '#/receipts/' + encodeURIComponent(f.run) : (f.brief ? '#/approvals/' + encodeURIComponent(f.brief) : null);
  const where = f.run ? `run ${f.run}` : (f.brief ? `brief ${f.brief}` : null);
  const body = [h('span', {}, f.what || 'applied'),
    h('span.mono.small.dim', {}, [where, when(f.at)].filter(Boolean).join(' · '))];
  return h('li', {}, href ? h('a', { href }, body) : h('div.row', {}, body));
}

// One lesson: the rule, the run it came from, the failure behind it, and where it fired since.
// A draft is not a rule yet: it carries the open ring until a council member signs it.
function lessonCard(l, council, draft, runs) {
  const fired = l.fired || [];
  const title = runs.find((r) => r.id === l.from_run)?.title || l.from_run;
  return card('article.pad.lesson', {
    tl: draft ? 'Draft' : 'Rule', tr: draft ? `hash ${short(l.sha256)}…` : `learned ${l.learned || 'date not recorded'}`,
    bl: l.check ? ['checked by ', raw(l.check)] : 'text only, no machine check',
  }, { id: 'lesson-' + l.id },
  h('p.rule', {}, l.rule || l.id),
  l.from_run ? h('p.from', {}, 'From the run ',
    h('a.link', { href: '#/receipts/' + encodeURIComponent(l.from_run) }, `“${title}”`), '.')
    : h('p.from', {}, 'Not tied to one run.'),
  draft ? h('div.cb-todo-row', {}, h('i.cb-todo-c'), h('span.cb-todo-t', {}, 'Waiting for a council signature')) : null,
  h('div.stack', {}, cap('the failure it came from'), h('p.failure', {}, l.failure || 'No description is recorded.')),
  h('div.kvs', {},
    (l.applies_to || []).length ? kv('Applies to', l.applies_to.join(', ')) : null,
    l.fix && FIX[l.fix] ? kv('When it fires', FIX[l.fix]) : null),
  draft ? null : h('div', {}, cap(`where it fired since (${fired.length})`),
    fired.length ? h('ul.rows', {}, fired.map(firedRow)) : h('p.from', {}, 'It has not fired on a brief in this record yet.')),
  draft ? (l.drafted_by ? h('p.small.dim', {}, `drafted by ${l.drafted_by}`) : null) : acceptedBy(l, council),
  draft ? acceptBlock(l, council) : null);
}

// The builds the carried-over lessons came from. They were made on Cambrian's private system before this repository existed;
// their records were imported unchanged and each record's hash is logged on NEAR.
async function earlier(runs) {
  const mine = runs.filter(isImported).sort((a, b) => String(a.finished).localeCompare(String(b.finished)));
  if (!mine.length) return null;
  const onChain = (r) => api.get(`receipts/${encodeURIComponent(r.id)}.json`).then((x) => x.on_chain || null).catch(() => null);
  const chain = await Promise.all(mine.map(onChain));
  const out = { target: '_blank', rel: 'noopener noreferrer' };
  return h('section', { id: 'earlier' },
    h('h2', {}, EARLIER),
    h('p.lede', {}, 'These three builds of Upread were made on Cambrian’s private system on 9 November 2026, before this repository '
      + 'existed. They were not built here. Their records were imported with their numbers unchanged, and the lessons above were '
      + 'written from what happened in them.'),
    h('ul.rows', {}, mine.map((r, i) => h('li', {},
      h('a', { href: '#/receipts/' + encodeURIComponent(r.id) },
        h('span', {}, r.title || r.id),
        h('span.row.start', {}, stateChip(r.state), h('span.mono.small', {}, usd(r.usd)))),
      h('span.small.dim', {}, when(r.finished), ' · built on Cambrian’s private system · ',
        chain[i]?.tx_hash ? h('a.link', { href: `https://nearblocks.io/txns/${chain[i].tx_hash}`, ...out }, 'its record’s hash on NEAR')
          : 'no on-chain record')))),
    h('p.small.dim', {}, 'On NEAR each of these is labelled as imported and recorded on 13 November. One member approved them there; '
      + 'that signature is not in this repository.'));
}

export async function render(root, arg) {
  const [doc, council, runsDoc] = await Promise.all([api.get('lessons.json'), api.get('council.json').catch(() => null),
    api.get('runs.json').catch(() => ({}))]);
  const rules = doc.lessons || [];
  const drafts = doc.drafts || [];
  const runs = runsDoc.runs || [];
  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Lessons'), h('h1.statement', {}, 'What Cambrian learned from its own builds.'),
      h('p.lede', {}, 'A red run drafts a lesson, a council member accepts it '
        + 'with a passkey, and from then on it is applied to every new brief.'),
      doc._meta?.how_it_grows ? h('p.note', {}, doc._meta.how_it_grows) : null),
    h('h2', {}, `Drafted, waiting for the council (${drafts.length})`),
    drafts.length ? h('div.lessons', {}, drafts.map((d) => lessonCard(d, council, true, runs)))
      : h('p.plain', {}, 'No draft is waiting. The next red run on this line drafts one.'),
    h('h2', {}, `Rules in force (${rules.length})`),
    rules.length ? h('div.lessons', {}, rules.map((l) => lessonCard(l, council, false, runs)))
      : h('p.plain', {}, 'No rule is recorded yet.'),
    await earlier(runs));
  if (arg === 'earlier') root.addEventListener('shown', () => document.getElementById('earlier')?.scrollIntoView(), { once: true });
}
