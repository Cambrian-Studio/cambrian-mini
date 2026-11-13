// Talk to Cambrian: a conversation first. Cambrian thinks the idea through with the member, streamed; nothing is a
// brief until the member says it is ready or presses "Draft the brief". Each further instruction makes a new draft
// version with its changes listed, and "Send to council" puts that exact brief in Approvals. In replay it plays
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
    if (!members.length) off = 'The council record could not be read, so nobody can be chosen as the speaker.';
  }
  const who = passkey ? h('select', { id: 'proposer' }, members.map((x) => h('option', { value: x.id }, x.name || x.id))) : null;
  let alive = true;
  let busy = false;
  let next = 0;
  let conversation = null;   // the id of the conversation on the server, once it has one
  let drafted = false;       // a draft exists: what is typed next is an instruction for a new version

  const log = h('div.chat', { role: 'log', 'aria-live': 'polite', 'aria-label': 'Conversation' });
  const say = (speaker, ...kids) => {
    const b = h('div.msg', { class: speaker === 'member' ? 'is-member' : 'is-cambrian' },
      cap(speaker === 'member' ? 'member' : 'Cambrian'), kids);
    log.append(b);
    b.scrollIntoView({ block: 'nearest', behavior: still() ? 'auto' : 'smooth' });
    return b;
  };
  const dots = () => say('cambrian', h('p.typing', { 'aria-label': 'Cambrian is writing' }, h('i'), h('i'), h('i')));

  // The member opens a conversation once with a passkey; the session lasts two hours in this tab.
  const KEY = 'cambrian.talk.session';
  const stored = () => { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch { return null; } };
  const forget = () => { try { sessionStorage.removeItem(KEY); } catch { /* nothing kept */ } };
  async function session() {
    if (!passkey) return undefined;
    const have = stored();
    if (have?.member === who.value && have.until > Date.now()) return have.token;
    const options = await api.post('talk/open/options', { member: who.value });
    const res = await api.post('talk/open', { member: who.value, ...await getAssertion(options) });
    try {
      const until = Date.now() + (res.minutes - 5) * 60000;
      sessionStorage.setItem(KEY, JSON.stringify({ token: res.session, member: res.member, until }));
    } catch { /* the session then lasts for this message only */ }
    return res.session;
  }

  // Images go with a draft as base64, named in the brief by their sha256. Members only.
  async function attached() {
    const files = [...(pick?.files || [])];
    if (files.length > 3) throw new Error('At most 3 images.');
    const out = [];
    for (const f of files) {
      if (!/^image\/(png|jpeg)$/.test(f.type)) throw new Error(f.name + ' is not a PNG or a JPEG.');
      if (f.size >= 5 * 1024 * 1024) throw new Error(f.name + ' is 5 MB or more.');
      const bytes = new Uint8Array(await f.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      out.push({ data: btoa(bin) });
    }
    return out;
  }

  // One recorded answer, for the replay: a line, a brief card, or the reason no brief was written.
  function reply({ text, brief, lint, model, cost, att, from, hash }) {
    const meta = [model, typeof cost === 'number' ? usd(cost) : null].filter(Boolean).join(' · ');
    say('cambrian',
      text ? h('p', {}, text) : null,
      brief ? briefCard(brief, lint, h('a.btn.ghost', { href: '#/approvals/' + encodeURIComponent(brief.id || '') },
        'It waits for the council'), att, { from, hash }) : null,
      (lint?.notes || []).length ? h('p.dim.small', {}, lint.notes.join(' · ')) : null,
      meta ? h('p.mono.dim.small', {}, meta) : null);
  }

  async function play(conversations) {
    if (busy || !conversations.length) return;
    busy = true;
    const c = conversations[next++ % conversations.length];
    log.querySelector('.plain')?.remove();
    log.append(h('p.divider', {}, 'recorded conversation · ' + when(c.at) + (c.proposed_by ? ' · ' + c.proposed_by : '')));
    for (const msg of c.messages || []) {
      if (!alive) return;
      if (msg.role === 'member') {
        say('member', h('p', {}, msg.text));
      } else {
        const d = dots();
        await wait(900);
        d.remove();
        if (alive) {
          reply({ text: msg.text, brief: msg.brief, lint: msg.lint, model: msg.brief ? c.model : null, cost: msg.brief ? c.usd : null,
            att: msg.brief ? c.attestation : null, from: c.proposed_by });
        }
      }
      await wait(600);
    }
    busy = false;
  }

  // "Send to council": the member's passkey signs the hash of the conversation, and that exact brief goes to Approvals.
  async function toCouncil(btn) {
    btn.disabled = true;
    try {
      let body = { conversation_id: conversation };
      if (passkey) {
        const options = await api.post('talk/send/options', { conversation_id: conversation, member: who.value });
        body = { ...body, member: who.value, ...await getAssertion(options) };
      }
      const res = await api.post('talk/send', body);
      api.forget('tickets.json', 'talk.json');
      say('cambrian', h('p', {}, 'The brief went to the council. Nothing is built until the collective signs.'),
        (res.relinted || []).length ? h('p.small', {}, 'A lesson accepted since the draft changed it before it went: '
          + res.relinted.map((x) => `${x.lesson} (${x.what})`).join('; ') + '. The council sees the brief as it is now.') : null,
        h('a.btn.ghost', { href: '#/approvals/' + encodeURIComponent(res.ticket_id) }, 'Open it in Approvals'));
      toast('The brief waits for the council.', 'green');
      conversation = null;
      drafted = false;
      draw();
    } catch (err) {
      btn.disabled = false;
      toast('Not sent: ' + err.message, 'red');
    }
  }

  // A draft: a version of the brief with what changed, or the rule it broke. Nothing here is in Approvals yet.
  async function draft(text) {
    const d = dots();
    try {
      const images = passkey ? await attached() : [];
      const res = await api.post('talk/draft', { session: await session(), conversation_id: conversation || undefined, text,
        ...(images.length ? { attachments: images } : {}) });
      d.remove();
      conversation = res.conversation_id || conversation;
      if (res.blocked) {
        say('cambrian', h('p', {}, 'That draft broke a rule from an earlier build, so it cannot go to the council yet.'),
          card('div.pad.brief', { tl: 'No brief written' }, {}, h('p.small', {}, res.why), lintChips(res.lint)));
      } else if (!res.brief) {
        say('cambrian', h('p', {}, res.reply));
      } else {
        drafted = true;
        if (pick) pick.value = '';
        const send = h('button.btn', { type: 'button', onclick: (e) => toCouncil(e.currentTarget) }, 'Send to council');
        say('cambrian', h('p', {}, res.reply),
          h('p.cap', {}, 'Draft ' + res.version),
          res.version > 1 ? h('ul.changes', {}, (res.changes || []).map((c) => h('li', {}, c))) : null,
          briefCard(res.brief, res.lint, send, res.attestation, { hash: res.ticket_sha256 }),
          (res.lint?.notes || []).length ? h('p.dim.small', {}, res.lint.notes.join(' · ')) : null,
          h('p.mono.dim.small', {}, [res.model, usd(res.usd)].filter(Boolean).join(' · ')));
      }
    } catch (err) {
      d.remove();
      if (err.body?.error === 'passkey required') forget();
      say('cambrian', h('p', {}, 'That did not go through: ' + err.message));
    }
    draw();
  }

  // A thinking turn: the answer is streamed and appears as it is written.
  async function think(text) {
    const d = dots();
    let res;
    try {
      res = await fetch('api/talk/turn', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session: await session(), conversation_id: conversation || undefined, text }) });
    } catch (err) {
      d.remove();
      say('cambrian', h('p', {}, 'That did not go through: ' + (err.message || 'the server did not answer') + '.'));
      return;
    }
    if (!(res.headers.get('content-type') || '').startsWith('text/event-stream')) {
      const json = await res.json().catch(() => ({}));
      d.remove();
      if (json.draft) { conversation = json.conversation_id || conversation; await draft(text); return; }
      if (json.error === 'passkey required') forget();
      say('cambrian', h('p', {}, 'That did not go through: ' + (json.why || json.error || res.status)));
      if (!input.value) input.value = text;
      return;
    }
    const line = h('p');
    let box = null;
    let buf = '';
    const take = (event) => {
      if (event.conversation_id) conversation = event.conversation_id;
      if (event.t) {
        if (!box) { d.remove(); box = say('cambrian', line); }
        line.textContent += event.t;
        box.scrollIntoView({ block: 'nearest' });
      }
      if (event.error) { d.remove(); say('cambrian', h('p', {}, event.error)); }
      if (event.done && box) box.append(h('p.mono.dim.small', {}, [event.model, usd(event.usd)].filter(Boolean).join(' · ')));
    };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (chunk.startsWith('data: ')) { try { take(JSON.parse(chunk.slice(6))); } catch { /* a broken event is skipped */ } }
      }
    }
    d.remove();
  }

  async function send(text, wantDraft) {
    busy = true;
    draw();
    log.querySelector('.plain')?.remove();
    if (text) say('member', h('p', {}, text), pick?.files?.length ? h('p.dim.small', {}, pick.files.length + ' image(s) attached') : null);
    try {
      if (wantDraft || drafted) await draft(text);
      else await think(text);
    } catch (err) {
      say('cambrian', h('p', {}, 'That did not go through: ' + err.message));
    }
    busy = false;
    draw();
  }

  const input = h('textarea', {
    id: 'idea', rows: '1', maxlength: '1500', disabled: Boolean(off), 'aria-label': 'Your message',
    placeholder: off ? 'Nothing is sent to a model here' : 'An idea, a change to a product, or a question.',
  });
  const pick = passkey ? h('input', { type: 'file', id: 'images', accept: 'image/png,image/jpeg', multiple: true,
    'aria-label': 'Attach up to 3 images, PNG or JPEG, under 5 MB each' }) : null;
  const draftBtn = h('button.btn.ghost', { type: 'button', disabled: true, onclick: () => {
    const text = input.value.trim();
    if (off || busy) return;
    input.value = '';
    send(text, true);
  } }, 'Draft the brief');
  const sendBtn = h('button.btn.send', { type: 'submit', disabled: Boolean(off), 'aria-label': 'Send', title: 'Send' },
    arrow(), h('span', {}, 'Send'));
  function draw() {
    input.disabled = Boolean(off) || busy;
    sendBtn.disabled = Boolean(off) || busy;
    draftBtn.disabled = Boolean(off) || busy || (!conversation && !input.value.trim());
    draftBtn.textContent = drafted ? 'Draft again' : 'Draft the brief';
    input.placeholder = off ? 'Nothing is sent to a model here'
      : (drafted ? 'What should change? Each instruction makes a new draft.' : 'An idea, a change to a product, or a question.');
  }
  const form = h('form.composer', {
    onsubmit: (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (off || busy || !text) return;
      input.value = '';
      send(text, false);
    },
  }, input, sendBtn);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
  });
  input.addEventListener('input', draw);

  // On this screen the bottom bar is the input: mark, divider, the message. The glyphs follow it.
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
    h('header.head', {}, h('p.eyebrow', {}, 'Talk to Cambrian'), h('h1.statement', {}, 'Talk it through. Then Cambrian writes the brief.'),
      h('p.lede', {}, 'Cambrian discusses the idea with you, pushes back and proposes what to cut. Nothing is a brief until you say '
        + 'it is ready. Then it drafts one from the conversation, and you send it to the council.')),
    log,
    h('div.talk-foot', {},
      off ? null : h('div.row.start', {}, draftBtn,
        who ? [h('label.cap', { for: 'proposer' }, 'who is writing'), who, h('label.cap', { for: 'images' }, 'images'), pick] : null),
      off ? h('p.note', {}, off)
        : h('p.dim.small', {}, 'A conversation costs a few cents of model calls, inside today\'s cap of ' + usd(m.daily_cap_usd)
          + (typeof m.spent_today_usd === 'number' ? ' (' + usd(m.spent_today_usd) + ' spent today).' : '.')
          + (passkey ? ' Your passkey opens the conversation, and signs it again when you send the brief to the council. '
            + 'That signature is not an approval. Images are kept with the brief and are not sent to a model.' : '')),
      recorded.length ? h('div.row.start', {},
        h('button.btn.ghost', { type: 'button', onclick: () => play(recorded) }, 'Play a recorded conversation'),
        h('span.dim.small', {}, recorded.length + ' recorded')) : null));

  if (fault) log.append(h('p.plain', {}, 'The recorded conversations could not be read: ' + fault.message));
  else if (!recorded.length) log.append(h('p.plain', {}, 'No recorded conversation yet. The first live build records one.'));
  else if (off) log.append(h('p.plain', {}, 'Press “Play a recorded conversation” to watch an idea become a brief.'));
  draw();
  return () => { alive = false; undock(); };
}
