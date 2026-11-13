// Approvals: briefs waiting for the council, and a sheet per brief with the three members,
// the hash they sign, and a way to verify every recorded signature in the browser.

import * as api from '../lib/api.js';
import { hashOfAsync } from '../lib/canonical.mjs';
import { verifyMemberSignature, ideaHash, approvalSubject, getAssertion, createPasskey, passkeysAvailable } from '../lib/webauthn.mjs';
import {
  h, put, cap, card, dot, usd, when, short, stateChip, briefCard, failure, toast, openSheet, squircle, field, MARK, quorumLabel,
} from '../lib/ui.js';

// Only council figures shipped with the app are ever drawn.
const FIGURE = /^assets\/members\/(clemens|jj|michael)\.png$/;
export const figure = (m) => (FIGURE.test(String(m.figure)) ? m.figure : null);
const reload = () => window.dispatchEvent(new HashChangeEvent('hashchange'));
const isWaiting = (e) => e.status === 'awaiting-approval';
const threshold = (e, council) => e.release?.threshold || council?.threshold || 2;
const NEXT = 'On-chain council: next';
const isEnrolled = (m) => m.enrolled === true || (m.credentials || []).length > 0;
const nameOf = (council, id) => (council?.members || []).find((m) => m.id === id)?.name || id;
const clock = (iso) => (when(iso).split(', ')[1] || '').replace(' UTC', '');
const NUMBER = ['No', 'One', 'Two', 'Three'];

// A council member as a card: the figure when one is published, else the mark as the key image.
// `small` is the seat used beside a brief; a seat whose member signed carries the selected ring.
export function memberCard(m, { tr = null, bl = null, br = null, selected = false, small = false, tag = 'div', attrs = {} } = {}) {
  const src = figure(m);
  const el = card(`${tag}.${small ? 'seat' : 'cb-member'}`, { tl: m.name || m.id, tr, bl, br }, attrs,
    h('div.cb-member-fig', {}, src ? h('img.figure', { src, alt: `${m.name || m.id}, council member`, loading: 'lazy' })
      : h('img.cb-key', { src: MARK, alt: '' })));
  if (selected) el.classList.add('is-selected');
  return el;
}

// One line, as a report: who brought the idea, who signed, and what is still needed.
function report(entry, council) {
  const valid = entry.release?.valid || [];
  const need = threshold(entry, council);
  const total = council?.members?.length || 3;
  const said = [];
  if (entry.proposed_by?.member) said.push(`${nameOf(council, entry.proposed_by.member)} brought the idea.`);
  if (!isWaiting(entry)) {
    said.push(`${NUMBER[valid.length] || valid.length} of ${String(NUMBER[total] || total).toLowerCase()} signed.`,
      entry.run_started ? 'The brief was released to be built.' : 'The brief is signed.');
    return said.join(' ');
  }
  if (valid.length) said.push(`${valid.map((id) => nameOf(council, id)).join(' and ')} signed.`);
  const left = need - valid.length;
  said.push(left === 1 ? 'One more signature releases it to be built.'
    : `${NUMBER[left] || left} more signatures release it to be built.`);
  return said.join(' ');
}

function sheetBody(entry, council) {
  const t = entry.ticket || {};
  const approvals = entry.approvals || [];
  const valid = entry.release?.valid || [];
  const need = threshold(entry, council);
  const members = council?.members || [];
  const total = members.length || 3;
  const m = api.mode();
  const canSign = m.mode === 'live' && m.can_sign !== false && isWaiting(entry);
  const note = h('p.note', { hidden: true, role: 'status' });

  // The hash is recomputed here from the ticket as served, with the serializer file the server uses.
  const recomputed = h('span.small.dim', {}, 'recomputing…');
  hashOfAsync(t).then((hash) => {
    const match = hash === entry.ticket_sha256;
    recomputed.textContent = match ? 'Recomputed in your browser from the brief: the hash matches.'
      : 'Recomputed from the brief: the hash does not match.';
    recomputed.className = 'small ' + (match ? 'ok' : 'bad');
  }).catch(() => { recomputed.textContent = ''; });

  async function approve(member, btn) {
    btn.disabled = true;
    try {
      // the note is signed with the brief: the server derives the challenge from both
      const taste_note = taste.value.replace(/\s+/g, ' ').trim().slice(0, 200) || undefined;
      const options = await api.post('approve/options', { ticket_id: t.id, member: member.id, taste_note });
      const assertion = await getAssertion(options);
      const res = await api.post('approve', { ticket_id: t.id, member: member.id, taste_note, ...assertion });
      api.forgetAll();
      toast(res.released ? `${member.name} signed. “${t.title}” was released to be built.`
        : `${member.name} signed “${t.title}”. ${res.valid?.length ?? 1} of ${res.threshold ?? need} so far.`, 'green');
      reload();
    } catch (err) {
      btn.disabled = false;
      toast(`Not signed: ${err.message}`, 'red');
    }
  }

  // The seats. A member who has not signed and holds a passkey can say "this is me" by choosing their seat.
  const open = canSign && passkeysAvailable() ? members.filter((x) => isEnrolled(x) && !approvals.some((a) => a.member === x.id)) : [];
  let me = open.length === 1 ? open[0] : null;
  const sign = h('button.btn.tall', { type: 'button', disabled: !me, onclick: (e) => { if (me) approve(me, e.currentTarget); } },
    'Sign with passkey');
  const hint = h('p.small.dim', { role: 'status' });
  const taste = h('textarea.taste', { rows: '2', maxlength: '200', 'aria-label': 'Taste note, optional',
    placeholder: 'Taste note, optional: why you sign, or what to watch for. It is signed with the brief.' });
  const seats = h('div.council3');
  function drawSeats() {
    seats.replaceChildren(...members.map((member) => {
      const a = approvals.find((x) => x.member === member.id);
      const counted = valid.includes(member.id);
      if (a) return memberCard(member, { small: true, selected: counted, br: counted ? [dot(), 'Signed'] : 'Not valid' });
      if (!open.includes(member)) return memberCard(member, { small: true, br: isEnrolled(member) ? 'Waiting' : 'No passkey' });
      return memberCard(member, { small: true, tag: 'button', br: me === member ? 'You' : 'Waiting', attrs: {
        type: 'button', 'aria-pressed': me === member ? 'true' : 'false',
        'aria-label': `${member.name}: sign as this member`, onclick: () => { me = member; drawSeats(); },
      } });
    }));
    sign.disabled = !me;
    hint.textContent = me ? `Signing as ${me.name}.` : 'Choose your seat above, then sign.';
  }
  drawSeats();

  // Every recorded signature, with one button that checks them all in this browser.
  const results = new Map(approvals.map((a) => [a, h('span.result', { role: 'status' })]));
  const verifyAll = approvals.length ? h('button.btn.ghost', { type: 'button', onclick: async () => {
    verifyAll.disabled = true;
    for (const a of approvals) {
      const subjectHash = await approvalSubject(entry.ticket_sha256, a.taste_note);
      const r = await verifyMemberSignature({ purpose: 'approval', subjectHash, approval: a, council });
      const out = results.get(a);
      out.replaceChildren(r.ok ? dot() : null, r.ok ? ' Valid ES256 signature over this brief’s hash.' : `Not valid: ${r.why}`);
    }
    verifyAll.disabled = false;
  } }, 'Verify signatures') : null;
  const sigRows = h('div.sigs', {}, members.map((member) => {
    const a = approvals.find((x) => x.member === member.id);
    const counted = valid.includes(member.id);
    return h('div.sig', { class: counted ? 'is-signed' : '' }, h('i', { 'aria-hidden': 'true' }),
      h('span', {}, member.name || member.id, a && !counted ? ' · signature not valid' : ''),
      cap(a ? when(a.at) : (isEnrolled(member) ? 'Waiting' : 'No passkey enrolled yet')),
      a?.taste_note ? h('span.taste-note', {}, `“${a.taste_note}”`) : null,
      a ? results.get(a) : null);
  }));

  // Where the text came from: the model call named in the ticket, and what the server recorded about its signature.
  const d = t.drafted || null;
  const att = entry.brief?.attestation || null;
  const signed = att?.ok === true && att.kind === 'provider_tee';
  const origin = d ? card('div.pad.cb-card2', { tl: 'Where the text came from' }, {},
    h('p.small', {}, signed
      ? `The server recorded a ${att.signing_algo} signature by ${short(att.signing_address, 14)}… over this exact model response, `
        + 'and its checks of that signature and of the TEE quote behind the signing key passed.'
      : 'No verified model signature is recorded for this brief'
        + (entry.brief?.attestation_note ? ` (${entry.brief.attestation_note}).` : '.')),
    h('p.small.dim', {}, 'This is the server\'s recorded result. This page does not check the TEE quote again; the kept response, '
      + 'request and report are beside the brief in the record, and the judge script re-checks them offline.')) : null;

  // Who proposed it: a council member's passkey signature over the idea's text. It is not an approval.
  const proposer = entry.proposed_by || null;
  const proposerResult = h('span.small', { role: 'status' });
  const proposerCheck = proposer ? h('button.textbtn', { type: 'button', onclick: async () => {
    // a brief that came from a conversation is sent with a signature over the conversation's hash, which the brief names
    const subjectHash = entry.ticket?.conversation?.sha256 || await ideaHash(entry.idea);
    const r = await verifyMemberSignature({ purpose: 'idea', subjectHash, approval: proposer.approval, council });
    proposerResult.replaceChildren(r.ok ? dot() : null, r.ok ? ' Valid ES256 signature over this idea.' : `Not valid: ${r.why}`);
  } }, 'Verify signature') : null;

  const explain = h('button.btn.tall', { type: 'button', onclick: () => {
    note.hidden = false;
    note.textContent = `This asks a council member's device for a passkey signature over the brief’s hash `
      + `${short(entry.ticket_sha256)}…. Recorded signatures are shown above and can be verified.`;
  } }, 'Sign with passkey');

  return h('div.stack', {},
    h('div.vote-head', {},
      h('div.row', {}, h('span.cap', {}, `proposed ${when(entry.created)}`), stateChip(entry.status)),
      h('h2.statement', {}, 'Machines build. The collective decides.'),
      h('p.lede', {}, report(entry, council))),
    entry.idea ? h('div.stack', {}, cap('the idea, as the member wrote it'), h('p', {}, entry.idea),
      proposer ? h('p.small.dim', {}, `Proposed by ${nameOf(council, proposer.member)} with a passkey. `
        + 'This does not count as a signature on the brief.') : null,
      proposer ? h('div.actions', {}, proposerCheck, proposerResult) : null) : null,
    briefCard(t, entry.lint, null, att, { from: proposer ? nameOf(council, proposer.member) : null, hash: entry.ticket_sha256 }),
    h('div.stack', {},
      h('div.row', {}, cap('the council'), h('span.cap', {}, `${valid.length} of ${total} · ${need} to build`)),
      council ? seats : h('p.plain', {}, 'The council record could not be read.'),
      council ? sigRows : null,
      verifyAll ? h('div.actions', {}, verifyAll) : null,
      approvals.length && entry.release?.why ? h('p.small.dim', {}, entry.release.why) : null),
    entry.run_started ? h('div.cb-card.cb-card2.released', {}, dot(),
      h('div', {}, h('span', {}, `${t.title || t.id} went to be built at ${clock(entry.run_started)} UTC.`),
        h('span', {}, 'The preview is on its record when it builds. ', h('a.link', { href: '#/line' }, 'Watch the build')))) : null,
    canSign && open.length ? h('div.actions.col', {}, taste, sign, hint) : null,
    !canSign && isWaiting(entry) ? h('div.actions.col', {}, explain, note) : null,
    h('p.cap.footcap', {}, 'Passkeys kept with the brief · on-chain next'),
    origin,
    card('div.pad', { tl: 'Hash being signed' }, {},
      h('p.hash', {}, entry.ticket_sha256 || '–'), recomputed,
      h('p.small.dim', {}, 'sha256 of the brief in a fixed form. Change one word of the brief and every signature above stops matching.'),
      d ? h('p.small.dim', {}, `The hash being signed covers the model response hash ${short(d.response_sha256)}…: it is a field of `
        + 'the brief. The signed form is derived from that response by code (the budget is clamped, a lesson may add a line); '
        + 'it is not the response byte for byte.') : null),
    steps(entry, council));
}

// The three steps of a decision, as a timeline. The on-chain vote is drawn as a step that is not built.
function steps(entry, council) {
  const m = api.mode();
  const need = entry ? threshold(entry, council) : (council?.threshold || 2);
  const total = council?.members?.length || 3;
  const item = (cls, step, text, more) => h('li', { class: cls, 'aria-disabled': cls === 'is-off' ? 'true' : null },
    h('i', { 'aria-hidden': 'true' }), h('div', {}, h('span.step', {}, step), h('span.said', {}, text), more || null));
  return h('ol.tl.steps', {},
    item(entry?.release?.ok ? 'is-done' : (entry ? 'is-now' : ''), 'Council',
      `Council approval: ${need} of ${total} passkey signatures`),
    item(entry?.run_started ? 'is-done' : '', 'Release',
      entry?.run_started ? `Released to be built · ${when(entry.run_started)}` : 'Release to be built'),
    item('is-off', 'Next', m.dao?.label || NEXT, m.dao?.detail ? h('span.small.dim', {}, m.dao.detail) : null));
}

// One idea before the council: its brief in short, a row per signature, and the way in.
function listCard(entry, council) {
  const t = entry.ticket || {};
  const valid = entry.release?.valid || [];
  const total = council?.members?.length || 3;
  const state = entry.status === 'released' ? [dot(), 'Released']
    : (isWaiting(entry) ? (valid.length ? `${valid.length} of ${total}` : 'New') : `Signed, ${valid.length} of ${total}`);
  return card('a.pad.idea', {
    tl: t.product || 'Brief', tr: entry.proposed_by?.member ? `From ${nameOf(council, entry.proposed_by.member)}` : null,
    bl: `Budget ${usd(t.budget?.usd)}`, br: state,
  }, { href: '#/approvals/' + encodeURIComponent(t.id) },
  entry.status === 'released' ? field(t.product) : null,
  squircle(t.product),
  h('span.title', {}, t.title || t.id),
  h('span.line.clamp', {}, t.goal || t.task || ''),
  h('span.spacer'),
  h('div.sigs', {}, (council?.members || []).map((member) => {
    const a = (entry.approvals || []).find((x) => x.member === member.id);
    const signed = valid.includes(member.id);
    return h('div.sig', { class: signed ? 'is-signed' : '' }, h('i', { 'aria-hidden': 'true' }),
      h('span', {}, member.name || member.id), cap(signed && a ? clock(a.at) : 'Waiting'));
  })),
  h('span.btn.ghost', {}, 'Read the brief'));
}

// What waits on the council, as the to-do card: briefs to sign are urgent, released ones are done.
function todoCard(tickets, total) {
  const row = (e, text, done) => h('div.cb-todo-row', { class: done ? 'is-done' : '' }, h('i.cb-todo-c'),
    h('span.cb-todo-t', {}, done ? text : h('a', { href: '#/approvals/' + encodeURIComponent(e.ticket.id) }, text)));
  const none = () => h('div.cb-todo-row.is-empty', {}, h('i.cb-todo-c'), h('span.cb-todo-t', {}, 'Nothing waits here.'));
  const urgent = tickets.filter(isWaiting).map((e) => row(e, `Sign “${e.ticket.title || e.ticket.id}”.`));
  const rest = tickets.filter((e) => !isWaiting(e));
  const open = [
    ...rest.filter((e) => !e.run_started).map((e) => row(e, `“${e.ticket.title || e.ticket.id}” is signed and waits to be built.`)),
    ...rest.filter((e) => e.run_started).map((e) => row(e, `“${e.ticket.title || e.ticket.id}” released, `
      + `${(e.release?.valid || []).length} of ${total}.`, true)),
  ];
  return h('div.cb-card.cb-card2.cb-todo', {},
    h('div.cb-todo-head', {}, h('span.cb-todo-title', {}, 'Waiting on the council'), h('img', { src: MARK, alt: '' })),
    h('div.cb-todo-body', {},
      h('div.cb-todo-sec', {}, h('span.cb-todo-label', {}, 'Urgent'), urgent.length ? urgent : none()),
      h('div.cb-todo-sec', {}, h('span.cb-todo-label', {}, 'Open'), open.length ? open : none())));
}

function councilCards(council) {
  const members = council?.members || [];
  if (!members.length) return null;
  const enrolled = members.filter(isEnrolled).length;
  return h('div.stack', {},
    h('h2', {}, `The council · ${council.threshold} of ${members.length} release a brief`),
    h('div.council3', {}, members.map((member) => memberCard(member, {
      small: true, br: isEnrolled(member) ? 'Passkey enrolled' : 'No passkey yet',
    }))),
    enrolled === 0 ? h('p.small.dim', {}, 'No council member has enrolled a passkey in this record yet, '
      + 'so nothing can be signed here. A member enrols once, with a one-time invite link.') : null);
}

export async function render(root, arg) {
  const [ticketsR, councilR] = await Promise.allSettled([api.get('tickets.json'), api.get('council.json')]);
  if (ticketsR.status === 'rejected') throw ticketsR.reason;
  const tickets = ticketsR.value.tickets || [];
  const council = councilR.status === 'fulfilled' ? councilR.value : null;
  const waiting = tickets.filter(isWaiting);
  const done = tickets.filter((e) => !isWaiting(e));

  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Council'),
      h('h1.statement', {}, 'A member brings the idea. The collective decides what gets the compute.'),
      h('p.lede', {}, 'Nothing is built until the collective signs. '
        + 'Cambrian checks those signatures itself before a build starts, and again before the code is pushed.'),
      h('p.cap', {}, quorumLabel(council))),
    h('h2', {}, `Waiting for the council (${waiting.length})`),
    h('div.queue.has-todo', {},
      waiting.length ? h('div.ideas', {}, waiting.map((e) => listCard(e, council)))
        : h('p.plain', {}, 'No brief is waiting for the council.'),
      todoCard(tickets, council?.members?.length || 3)),
    h('h2', {}, `Signed and released (${done.length})`),
    done.length ? h('div.ideas', {}, done.map((e) => listCard(e, council)))
      : h('p.plain', {}, 'No brief has been approved in this record yet. Builds imported from Cambrian’s private setup were '
        + 'approved there; their receipts say so and carry no signature that could be checked here.'),
    councilR.status === 'rejected' ? failure(councilR.reason, 'The council') : councilCards(council),
    h('h2', {}, 'How a brief is decided'),
    steps(null, council),
    h('p.cap.footcap', {}, 'Each signature is a passkey, kept with the brief · on-chain council next'));

  if (arg) {
    const entry = tickets.find((e) => e.ticket?.id === arg);
    openSheet({
      label: 'Council',
      body: entry ? sheetBody(entry, council) : h('p.plain', {}, `There is no brief called “${arg}” waiting here.`),
      onClose: () => { location.hash = '#/approvals'; },
    });
  }
}

// Enrolment: a council member opens a one-time invite link and creates an ES256 passkey.
export const enrol = {
  async render(root, token) {
    const status = h('p.note', { role: 'status', hidden: true });
    const tell = (text) => { status.hidden = false; status.textContent = text; };
    const live = api.isLive();
    const btn = h('button.btn', { type: 'button', disabled: !live || !token || !passkeysAvailable(), onclick: async () => {
      btn.disabled = true;
      try {
        const options = await api.post('enrol/options', { token });
        tell(`Creating a passkey for ${options.name || options.member}…`);
        const made = await createPasskey(options);
        await api.post('enrol', { token, ...made });
        api.forgetAll();
        tell(`Passkey enrolled for ${options.name || options.member}. It can now sign briefs.`);
        toast('Passkey enrolled.', 'green');
      } catch (err) {
        btn.disabled = false;
        tell(`Not enrolled: ${err.message}`);
      }
    } }, 'Create a passkey');
    put(root,
      h('header.head', {}, h('p.eyebrow', {}, 'Council'), h('h1.statement', {}, 'Enrol a passkey'),
        h('p.lede', {}, 'A council member enrols once, with a one-time invite link. The passkey stays on the '
          + 'device; only its public key is stored in the council record.')),
      card('div.pad.stack', { tl: 'Invite' }, {},
        h('p.hash', {}, token ? `${short(token, 8)}…` : 'no invite token in this link'),
        h('div.actions', {}, btn), status,
        live ? (passkeysAvailable() ? null : h('p.note', {}, 'This browser has no passkey support.'))
          : h('p.note', {}, 'This is a replay: no passkey is created here. On the live line this button asks '
            + 'your device to create an ES256 passkey and sends its public key to the council record.')),
      h('div.actions', {}, h('a.btn.ghost', { href: '#/approvals' }, 'Back to the council')));
  },
};
