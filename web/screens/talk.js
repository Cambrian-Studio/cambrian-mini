// Talk to Cambrian: one box, no modes. A member writes; Cambrian works out whether it is a new product, a revision
// of one on record or a question, and answers in one line, with a brief when there is one. In replay it plays
// recorded conversations.

import * as api from '../lib/api.js';
import { getAssertion, passkeysAvailable, sha256Hex } from '../lib/webauthn.mjs';
import { h, put, cap, card, usd, when, briefCard, lintChips, toast, arrow } from '../lib/ui.js';

const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const wait = (ms) => new Promise((r) => setTimeout(r, still() ? 0 : ms));

// Reachable from outside its machine, the app takes an idea only from an enrolled council member, signed
// with a passkey. `member_proposals` is set by a server that accepts such a signed idea.
const viaPasskey = (m) => m.mode === 'live' && m.exposed === true && m.member_proposals === true;

// Why the input is off, in the app's own words, or null when ideas can be sent.
function whyOff(m) {
  if (m.mode !== 'live') {
    return 'In the hosted replay nothing is sent to a model. Run it locally with a NEAR AI key to propose an idea.';
  }
  if (viaPasskey(m)) {
    if (m.can_sign !== true) {
      return 'Here only council members can propose an idea, with a passkey, and no member has enrolled one yet. '
        + 'Council members must enrol first, each with a one-time invite link.';
    }
    return passkeysAvailable() ? null
      : 'Here only council members can propose an idea, with a passkey, and this browser has no passkey support.';
  }
  if (m.guest_proposals === false) {
    return m.exposed
      ? 'Proposing an idea is switched off while this app is reachable from outside its build machine. '
        + 'Council members can still enrol and approve.'
      : 'Proposing an idea is switched off on this server.';
  }
  if (m.can_spend === false) return 'This server cannot spend on model calls right now.';
  return null;
}

export async function render(root) {
  const m = api.mode();
  let off = whyOff(m);
  const passkey = viaPasskey(m) && !off;
  let members = [];
  if (passkey) {
    try {
      members = ((await api.get('council.json')).members || []).filter((x) => x.enrolled === true);
    } catch { /* handled below: with no member to choose, the box stays off */ }
    if (!members.length) off = 'The council record could not be read, so nobody can be chosen as the proposer.';
  }
  const who = passkey ? h('select', { id: 'proposer' }, members.map((x) => h('option', { value: x.id }, x.name || x.id))) : null;
  let alive = true;
  let busy = false;
  let next = 0;

  const log = h('div.chat', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const say = (who, ...kids) => {
    const b = h('div.msg', { class: who === 'member' ? 'is-member' : 'is-cambrian' },
      cap(who === 'member' ? 'member' : 'Cambrian'), kids);
    log.append(b);
    b.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
    return b;
  };
  const dots = () => say('cambrian', h('p.typing', { 'aria-label': 'Cambrian is writing' }, h('i'), h('i'), h('i')));

  // One answer from Cambrian: a brief card, or the reason no brief was written.
  function reply({ text, brief, lint, model, cost, att, from, hash }) {
    const meta = [model, typeof cost === 'number' ? usd(cost) : null].filter(Boolean).join(' · ');
    say('cambrian',
      text ? h('p', {}, text) : null,
      brief
        ? briefCard(brief, lint, h('a.btn.ghost', { href: '#/approvals/' + encodeURIComponent(brief.id || '') },
          'It waits for the council'), att, { from, hash })
        : card('div.pad.brief', { tl: 'No brief written' }, {}, lintChips(lint)),
      (lint?.notes || []).length ? h('p.dim.small', {}, lint.notes.join(' · ')) : null,
      meta ? h('p.mono.dim.small', {}, meta) : null);
  }

  async function play(conversations) {
    if (busy || !conversations.length) return;
    busy = true;
    const c = conversations[next++ % conversations.length];
    log.querySelector('.plain')?.remove();
    log.append(h('p.divider', {}, `recorded idea · ${when(c.at)}${c.proposed_by ? ` · proposed by ${c.proposed_by}` : ''}`));
    for (const msg of c.messages || []) {
      if (!alive) return;
      if (msg.role === 'member') {
        say('member', h('p', {}, msg.text));
      } else {
        const d = dots();
        await wait(1100);
        d.remove();
        if (alive) {
          reply({ text: msg.text, brief: msg.brief, lint: msg.lint, model: c.model, cost: c.usd, att: c.attestation,
            from: c.proposed_by });
        }
      }
      await wait(700);
    }
    busy = false;
  }

  // Images go with the message as base64, named in the signature by their sha256. Members only.
  async function attached() {
    const files = [...(pick?.files || [])];
    if (files.length > 3) throw new Error('At most 3 images.');
    const out = [];
    for (const f of files) {
      if (!/^image\/(png|jpeg)$/.test(f.type)) throw new Error(`${f.name} is not a PNG or a JPEG.`);
      if (f.size >= 5 * 1024 * 1024) throw new Error(`${f.name} is 5 MB or more.`);
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({ data: btoa(bin), sha256: await sha256Hex(bytes) });
    }
    return out;
  }

  async function send(text) {
    busy = true;
    say('member', h('p', {}, text), pick?.files?.length ? h('p.dim.small', {}, `${pick.files.length} image(s) attached`) : null);
    const d = dots();
    try {
      let body = { idea: text };
      if (passkey) {
        // the member's passkey signs the idea's exact text; the server checks it before any model call
        const member = who.value;
        const images = await attached();
        const options = await api.post('ideas/options', { idea: text, member, attachment_sha256: images.map((x) => x.sha256) });
        body = { idea: text, member, ...await getAssertion(options),
          ...(images.length ? { attachments: images.map((x) => ({ data: x.data })) } : {}) };
        if (pick) pick.value = '';
      }
      const res = await api.post('ideas', body);
      d.remove();
      api.forget('tickets.json', 'talk.json');
      if (res.brief) {
        reply({ brief: res.brief, lint: res.lint, cost: res.usd, model: res.model, att: res.attestation,
          from: res.proposed_by, hash: res.ticket_sha256, text: res.reply || 'I drafted a brief.' });
        toast('The brief waits for the council.', 'green');
      } else {
        // a question answered, or one short question back: no brief, nothing to sign
        say('cambrian', h('p', {}, res.reply));
      }
    } catch (err) {
      d.remove();
      // The server answers "no brief" with its reason and the lessons that refused it.
      if (err.body?.error === 'no brief') reply({ text: err.message, brief: null, lint: err.body.lint, cost: err.body.usd });
      else {
        say('cambrian', h('p', {}, `That did not go through: ${err.message}`));
        if (!input.value) input.value = text;
      }
    }
    busy = false;
  }

  const input = h('textarea', {
    id: 'idea', rows: '1', maxlength: '600', disabled: Boolean(off), 'aria-label': 'Your idea',
    placeholder: off ? 'Nothing is sent to a model here' : 'An idea, a change to a product, or a question.',
  });
  const label = passkey ? 'Send with passkey' : 'Send';
  const pick = passkey ? h('input', { type: 'file', id: 'images', accept: 'image/png,image/jpeg', multiple: true,
    'aria-label': 'Attach up to 3 images, PNG or JPEG, under 5 MB each' }) : null;
  const form = h('form.composer', {
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (off || busy || !text) return;
      input.value = '';
      send(text);
    },
  },
  input,
  h('button.btn.send', { type: 'submit', disabled: Boolean(off), 'aria-label': label, title: label }, arrow(), h('span', {}, label)));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });

  // On this screen the bottom bar is the input: mark, divider, the idea. The glyphs follow it.
  const slot = document.getElementById('nav-input');
  const bar = slot?.closest('.nav');
  const dock = () => {
    if (!alive || !slot) return;
    slot.replaceChildren(form);
    slot.hidden = false;
    bar?.classList.add('has-input');
  };
  const undock = () => {
    if (!slot || !slot.contains(form)) return;
    slot.replaceChildren();
    slot.hidden = true;
    bar?.classList.remove('has-input');
  };
  root.addEventListener('shown', dock);

  let recorded = [];
  let fault = null;
  try {
    recorded = (await api.get('talk.json')).conversations || [];
  } catch (err) {
    fault = err;
  }

  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Talk to Cambrian'), h('h1.statement', {}, 'Bring an idea. Cambrian writes the brief.'),
      h('p.lede', {}, 'A new product, a change to one that exists, or a question. Cambrian works out which. '
        + 'A brief says the goal, the checks that decide when it is done, and a budget in dollars. The council decides if it gets built.')),
    log,
    h('div.talk-foot', {},
      who && !off ? h('div.row.start', {}, h('label.cap', { for: 'proposer' }, 'who is writing'), who,
        h('label.cap', { for: 'images' }, 'images'), pick) : null,
      off ? h('p.note', {}, off)
        : h('p.dim.small', {}, `A brief costs a few cents of model calls, inside today's cap of ${usd(m.daily_cap_usd)}`
          + (typeof m.spent_today_usd === 'number' ? ` (${usd(m.spent_today_usd)} spent today).` : '.')
          + (passkey ? ' Your passkey signs the exact text and any images. That signature sends the message; it is not an approval. '
            + 'Images are kept with the brief and are not sent to a model.' : '')),
      recorded.length ? h('div.row.start', {},
        h('button.btn.ghost', { type: 'button', onclick: () => play(recorded) }, 'Play a recorded idea'),
        h('span.dim.small', {}, `${recorded.length} recorded`)) : null));

  if (fault) log.append(h('p.plain', {}, `The recorded ideas could not be read: ${fault.message}`));
  else if (!recorded.length) log.append(h('p.plain', {}, 'No recorded idea yet. The first live build records one.'));
  else if (off) log.append(h('p.plain', {}, 'Press “Play a recorded idea” to watch an idea become a brief.'));
  return () => { alive = false; undock(); };
}
