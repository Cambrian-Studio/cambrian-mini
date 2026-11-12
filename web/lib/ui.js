// Small DOM helpers. Data only ever reaches the page as text nodes or checked attributes.

export function h(tag, attrs, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className += (el.className ? ' ' : '') + v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') el.setAttribute('href', safeUrl(v));
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

// Appends children, skipping null and false. Screens use this instead of Element.append.
export function put(el, ...kids) {
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
}

// Only in-app routes, relative files and http(s) links are ever written into an href.
export function safeUrl(url) {
  const s = String(url || '');
  if (s.startsWith('#') || /^https?:\/\//i.test(s)) return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '#/';
  return s;
}

export const ext = (url, text) => h('a.link', { href: url, target: '_blank', rel: 'noopener noreferrer' }, text || url);

// ---- formatting -------------------------------------------------------------------------------

export function usd(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '–';
  return '$' + (n !== 0 && Math.abs(n) < 0.01 ? n.toFixed(4) : n.toFixed(2));
}

export function seconds(s) {
  if (typeof s !== 'number' || !Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  return m ? `${m} min ${String(Math.round(s % 60)).padStart(2, '0')} s` : `${Math.round(s)} s`;
}

export function between(a, b) {
  const s = (Date.parse(b) - Date.parse(a)) / 1000;
  return Number.isFinite(s) ? s : null;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function when(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '–';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

export const short = (hash, n = 12) => (hash ? String(hash).slice(0, n) : '–');
export const count = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '–');
export const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;

// ---- shared pieces ----------------------------------------------------------------------------

export const MARK = 'assets/cambrian-mark-white.png';

// The one hue in the chrome: a small dot for a product that is live or a signature that was given.
export const dot = () => h('i.cb-dot', { 'aria-hidden': 'true' });

// Card1 with its four corner captions: tl the name, tr the origin, bl the kind, br the state.
export function card(tag, caps, attrs, ...kids) {
  const c = caps || {};
  const corner = (pos) => (c[pos] ? h('span.cb-cap.cb-cap-' + pos, {}, c[pos]) : null);
  const el = h(tag, attrs);
  el.classList.add('cb-card');
  if (c.tl || c.tr) el.classList.add('has-top');
  if (c.bl || c.br) el.classList.add('has-bottom');
  return put(el, corner('tl'), corner('tr'), kids, corner('bl'), corner('br'));
}

// A metric row: KEY: VALUE in mono capitals.
export const kv = (key, ...value) => h('p.kvrow', {}, h('b', {}, key + ': '), value);
export const raw = (text) => h('span.raw', {}, text);

// A run or brief state is a word with a circle beside it: filled when done, open when not. No colour.
const STATES = {
  'running': ['Running', 'now'], 'green-preview': ['Green', 'fill'], 'green-no-preview': ['Green, no preview', 'fill'],
  'red': ['Red', 'open'], 'refused': ['Refused', 'open'], 'blocked': ['Blocked', 'open'], 'error': ['Error', 'open'],
  'awaiting-approval': ['Waiting for the council', 'open'], 'approved': ['Signed', 'fill'],
  'released': ['Released to the line', 'dot'],
};
export function stateChip(state) {
  const [label, mark] = STATES[state] || [String(state || 'unknown'), 'open'];
  return h('span.state', {}, mark === 'dot' ? dot() : h('i.ring', { class: 'is-' + mark, 'aria-hidden': 'true' }), label);
}

export const IMPORTED = "earlier run on Cambrian's private line";
export const isImported = (x) => x?.origin === 'private-line';
export const originChip = (x) => (isImported(x) ? h('span.origin', {}, IMPORTED) : null);

export const cap = (text) => h('span.cap', {}, text);
export const plain = (text) => h('p.plain', {}, text);

export function failure(err, what) {
  return card('div.pad.fail', { tl: 'Could not load' }, { role: 'alert' },
    h('p', {}, `${what ? what + ': ' : ''}${err?.message || err}`));
}

// The product's icon: a glossy squircle with a white glyph. Upread carries its stand-in colour;
// a product without its own imagery gets the neutral one.
export function squircle(productId, big) {
  const mine = String(productId || '').toLowerCase() === 'upread';
  return h('span.squircle', { class: [mine ? 'is-upread' : '', big ? 'is-big' : ''].join(' ').trim(), 'aria-hidden': 'true' },
    mine ? glyph(['M5 7h14M5 12h6M5 17h10', 'M14 10.5v3']) : glyph(['M6 8h12M6 12h12M6 16h7']));
}
export const field = (productId) => (String(productId || '').toLowerCase() === 'upread'
  ? h('span.field', { 'aria-hidden': 'true' }) : null);

function glyph(paths) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of paths) {
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}
export const arrow = () => glyph(['M12 19V6', 'M6.5 11.5 12 6l5.5 5.5']);

// A check in words: its name when it has one, else a sentence from its kind.
export function checkWords(c) {
  if (typeof c === 'string') return c;
  if (c.name) return c.name;
  if (c.kind === 'file') return `the file ${c.path || c.id} exists`;
  if (c.kind === 'no_external_hosts') return 'the page loads nothing from another host';
  return `${c.run || c.cmd || c.id} exits 0`;
}

// What a lesson did to a brief, as metric rows. applied: [{lesson, what}], refused: [{lesson, why}].
export function lintChips(lint) {
  if (!lint) return null;
  const text = (x, more) => (typeof x === 'string' ? x : [x.lesson || x.id, more].filter(Boolean).join(': '));
  const rows = [
    ...(lint.applied || []).map((x) => kv('Lesson applied', text(x, x?.what))),
    ...(lint.refused || []).map((x) => kv('Refused by lesson', text(x, x?.why))),
  ];
  return rows.length ? h('div.kvs.chips', {}, rows) : null;
}

// Where a brief's text came from, in one line. `att` is the server's recorded check of the model's
// signature ({ kind, ok }). This page shows that result; it does not check the TEE quote again.
const modelSigned = (att) => att?.ok === true && att.kind === 'provider_tee';
export function provenance(drafted, att) {
  if (!drafted) return null;
  const signed = modelSigned(att);
  return h('p.mono.dim.small', { title: 'Checked by the server when the brief was written. Not checked again in this browser.' },
    `drafted by ${drafted.model}${signed ? ' inside a TEE · model-signed ✓ (checked by the server)' : ' · not verified here'}`
    + ` · response hash ${short(drafted.response_sha256)}…`);
}

// The brief card: what a ticket asks for, in words a member can check.
// `meta` names what the corners say: { from: the member who brought the idea, hash: the ticket hash }.
export function briefCard(brief, lint, extra, att, meta = {}) {
  const b = brief || {};
  const budget = b.budget || {};
  const checks = b.green || [];
  const d = b.drafted || null;
  return card('article.pad.brief', {
    tl: 'Brief', tr: meta.from ? `From ${meta.from}` : null,
    bl: meta.hash ? `${short(meta.hash)}…` : null, br: plural(checks.length, 'check'),
  }, {},
  h('h3', {}, b.title || b.id || 'Untitled brief'),
  b.product ? h('p.fragment', {}, String(b.product).toLowerCase()) : null,
  b.goal ? h('p.goal', {}, b.goal) : (b.task ? h('p.goal', {}, b.task) : null),
  checks.length ? h('div', {}, cap('done when'),
    h('ul.checks', {}, checks.map((c) => h('li', {}, checkWords(c))))) : null,
  (b.out_of_scope || []).length ? h('div', {}, cap('out of scope'),
    h('p.dim', {}, b.out_of_scope.join(' · '))) : null,
  h('div.kvs', {},
    kv('Budget', [usd(budget.usd), budget.calls ? `${budget.calls} calls` : null,
      budget.minutes ? `${budget.minutes} min` : null].filter(Boolean).join(' · ')),
    kv('Compute', 'NEAR AI, built behind walls'),
    d ? kv('Brief model', modelSigned(att) ? 'model-signed, ' : 'not verified here, ', raw(d.model)) : null),
  lintChips(lint), provenance(d, att), extra || null);
}

// What the capital beat says. While the stake is a placeholder it says nothing about staking; once a stake
// transaction is recorded it says how compute is paid for at the account level, never per build.
export const CAPITAL_RECORDED = 'Staked NEAR earns compute credits on NEAR AI. Builds draw on them, topped up with credits we bought.';
export function capitalCopy(doc) {
  if (!doc || doc.placeholder === true || !doc.stake?.tx) {
    return { title: 'What the builds cost, from the receipts.',
      body: 'The compute figure is the sum of the receipts in this record. The other figures are not yet recorded.' };
  }
  return { title: CAPITAL_RECORDED, body: null };
}

// The account-level split of credits: earned from the stake, bought, spent. A figure the record does not
// hold reads "not recorded yet": never a zero and never an estimate. Spent is the sum of the receipts.
export function creditSplit(doc) {
  const c = doc?.credits || {};
  const spend = doc?.inference_spend || {};
  const money = (n) => (typeof n === 'number' && Number.isFinite(n) ? usd(n) : 'not recorded yet');
  const known = typeof spend.baby_line_usd === 'number' || typeof spend.private_line_usd === 'number';
  const spent = known ? (Number(spend.baby_line_usd) || 0) + (Number(spend.private_line_usd) || 0) : null;
  return [['earned from the stake', money(c.earned_from_stake_usd)], ['bought', money(c.bought_usd)], ['spent', money(spent)]];
}

// The four capital cards: idle, staked, credits, compute. Each is its own fact; a figure that is
// not in the record reads "Not yet recorded" and none of them says the stake paid for a build.
export function capitalCards(doc) {
  const empty = doc?.placeholder === true;
  const s = doc?.stake || {};
  const spend = doc?.inference_spend || {};
  const amount = empty || !s.amount_near ? null
    : `${typeof s.amount_near === 'number' ? count(s.amount_near) : s.amount_near} NEAR`;
  const known = typeof spend.baby_line_usd === 'number' || typeof spend.private_line_usd === 'number';
  const total = (Number(spend.baby_line_usd) || 0) + (Number(spend.private_line_usd) || 0);
  const one = (caps, value, note) => card('div.pad.capcard', caps, {},
    h('span.big', { class: value ? '' : 'is-none' }, value || 'Not yet recorded'), h('span.sub', {}, note));
  return h('div.capital', {},
    one({ tl: 'Idle', tr: '01' }, null, 'NEAR before it is staked'),
    one({ tl: 'Staked', tr: '02', bl: !empty && s.tx ? `tx ${short(s.tx, 8)}…` : null }, amount, 'the stake transaction'),
    one({ tl: 'Credits', tr: '03' }, null, 'NEAR AI publishes a formula, not a fixed rate'),
    one({ tl: 'Compute', tr: '04' }, known ? usd(total) : null,
      typeof spend.runs === 'number' ? `model calls, ${plural(spend.runs, 'run')} in this record` : 'model calls in this record'));
}

// ---- toasts -----------------------------------------------------------------------------------

export function toast(text, tone = 'plain') {
  const root = document.getElementById('toasts');
  if (!root) return;
  const t = h('div.toast', { class: 'is-' + tone }, text);
  root.append(t);
  while (root.children.length > 3) root.firstChild.remove();
  setTimeout(() => t.remove(), 5200);
}

// ---- the sheet: a dialog that is a bottom sheet on a phone and a centred panel on a wide screen --

let closeCurrent = null;

export function openSheet({ label, body, onClose }) {
  closeSheet(true);
  const root = document.getElementById('sheet-root');
  const opener = document.activeElement;
  const panel = h('div.sheet', { role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' },
    h('div.sheet-head', {}, cap(label),
      h('button.textbtn', { type: 'button', onclick: () => close(false) }, 'Close')),
    h('div.sheet-body', {}, body));
  const wrap = h('div.sheet-wrap', {}, h('div.scrim', { onclick: () => close(false) }), panel);
  const onKey = (e) => {
    if (e.key === 'Escape') { close(false); return; }
    if (e.key !== 'Tab') return;
    const items = panel.querySelectorAll('a[href], button:not([disabled]), input, textarea, [tabindex="0"]');
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && (document.activeElement === first || document.activeElement === panel)) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault(); first.focus();
    }
  };
  function close(silent) {
    if (closeCurrent !== close) return;
    closeCurrent = null;
    document.removeEventListener('keydown', onKey);
    document.documentElement.classList.remove('locked');
    wrap.remove();
    if (opener?.isConnected) opener.focus();
    if (!silent) onClose?.();
  }
  closeCurrent = close;
  document.addEventListener('keydown', onKey);
  document.documentElement.classList.add('locked');
  root.append(wrap);
  panel.focus();
  return { close: () => close(true), panel };
}

export function closeSheet(silent = true) {
  closeCurrent?.(silent);
}

/** The small label under "the collective signs": the threshold, the size and the council's name, from the council file. */
export const quorumLabel = (council) => {
  const n = council?.members?.length; const m = council?.threshold;
  return n && m ? `${m} of ${n} · ${council.label || 'council'}` : 'council not loaded';
};
