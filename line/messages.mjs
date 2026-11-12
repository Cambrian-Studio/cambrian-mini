// messages.mjs — the line's three messages: GREEN, RED, WAITING. Each says what happened first, in
// plain words; then at most one labelled link; then the next action; then one short line of details.
// PURE: (run facts) → {text, html}. Every interpolated value is escaped here; `text` is the same
// message with the markup removed and a link written as "label: address".
export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const link = (href, label) => `<a href="${esc(href)}">${esc(label)}</a>`;
const cut = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
};
const both = (lines) => {
  const html = lines.join('\n');
  return { html, text: unesc(html.replace(/<a href="([^"]*)">([^<]*)<\/a>/g, '$2: $1').replace(/<[^>]+>/g, '')) };
};

export const productName = (ticket) => String(ticket?.product ?? '') || 'the product';

const spendOf = (rec) => {
  const sum = (f) => (rec?.attempts ?? []).reduce((a, x) => a + (f(x) ?? 0), 0);
  const usd = rec?.cost?.usd ?? sum((x) => x.bridge?.computed_usd);
  const calls = rec?.cost?.calls ?? sum((x) => x.bridge?.forwarded);
  return { usd: Number(usd) || 0, calls: Number(calls) || 0 };
};
const money = (rec) => {
  const s = spendOf(rec);
  return `$${s.usd.toFixed(2)} · ${s.calls} call${s.calls === 1 ? '' : 's'}`;
};
const mainWords = (rec) => (rec?.main?.untouched === true ? 'untouched' : 'NOT confirmed untouched');

/** Which of the ticket's limits ended the attempts, read off the record: time, calls or spend; null when none was reached. */
export function limitHit(rec) {
  const b = rec?.ticket?.budget ?? {};
  const last = rec?.attempts?.at(-1);
  const s = spendOf(rec);
  if (last?.agent?.exit === 142 || (b.minutes && Number(last?.agent?.seconds) >= b.minutes * 60 - 120)) {
    return { what: 'time', words: `${b.minutes} minutes` };
  }
  if (b.calls && s.calls >= b.calls - 1) return { what: 'calls', words: `${b.calls} calls` };
  if (b.usd && s.usd >= b.usd - 0.05) return { what: 'spend', words: `$${b.usd} budget` };
  return null;
}

/** GREEN. preview: {state:'success', url} or {state, why}. With no preview the message says why instead of linking. */
export function greenMessage({ rec, ticket, preview, commit }) {
  const P = productName(ticket);
  const n = rec?.attempts?.length ?? 1;
  const when = n === 1 ? 'on the first attempt' : `on attempt ${n}`;
  const lead = `${esc(P)} built cleanly: “${esc(ticket.title)}” passed all checks ${when}.`;
  const open = preview?.state === 'success' && preview.url
    ? `${link(preview.url, 'Open the preview')} (public, no sign-in needed)`
    : `No preview was published: ${esc(cut(preview?.why ?? 'not attempted', 140))}.`;
  const det = `${ticket.branch} @ ${String(commit ?? '').slice(0, 7)} · main ${mainWords(rec)} · ${money(rec)}`;
  return both([lead, '', open, '', 'Next: open the receipt in the app.', '', `Details: ${esc(cut(det))}`]);
}

/** RED: the checks failed, or the push was refused. No link. */
export function redMessage({ rec, ticket, waiting }) {
  const P = productName(ticket);
  const a = rec?.attempts ?? [];
  const failing = a.at(-1)?.failing ?? [];
  const lim = limitHit(rec);
  let lead, det;
  if (/push was refused/i.test(String(waiting))) {
    lead = `${esc(P)}: “${esc(ticket.title)}” passed its checks, but the push was refused. ` +
      `Nothing was pushed; main is ${mainWords(rec)}.`;
    det = String(waiting).replace(/^RED — /, '');
  } else {
    const twice = a.length >= 2;
    const same = twice && a[0].failing?.join() === a[1].failing?.join();
    const every = failing.length === (rec?.ticket?.checks?.length ?? -1);
    const how = twice ? `failed twice, ${same ? 'the same way' : 'differently'}` : `failed ${every ? 'every check' : 'some checks'}`;
    const ranOut = !twice && lim ? `, and the ticket’s ${esc(lim.words)} ran out` : '';
    lead = `${esc(P)} did not build: “${esc(ticket.title)}” ${how}${ranOut}. Nothing was pushed; main is untouched.`;
    const tries = `${a.length} attempt${a.length === 1 ? '' : 's'}`;
    det = `failing ${failing.join(', ') || '?'} · ${tries}${lim ? ` · ${lim.what} limit` : ''} · ${money(rec)}`;
  }
  return both([lead, '', 'Next: accept or reject the drafted lesson on the Lessons screen.', '', `Details: ${esc(cut(det))}`]);
}

/** WAITING: the run stopped before the agent, after it, or on an error, and a person has to look. */
export function waitingMessage({ rec, ticket, state, waiting }) {
  const P = productName(ticket);
  const T = `“${esc(ticket?.title ?? ticket?.id)}”`;
  const w = String(waiting ?? '');
  let lead;
  let next = 'Next: open the run in the app to see what it is waiting on.';
  if (state === 'refused') {
    lead = `The ${esc(P)} build ticket ${T} was not started: the council has not released it. Nothing ran and nothing was pushed.`;
    next = 'Next: two council members approve the ticket in the app; then start it again.';
  } else if (state === 'error') lead = `The ${esc(P)} build ${T} stopped on an error partway through.`;
  else if (/could not commit/.test(w)) {
    lead = `The ${esc(P)} build ${T} stopped after the agent worked: its files could not be committed. Nothing was pushed.`;
  } else if ((rec?.attempts?.length ?? 0) > 0) lead = `The ${esc(P)} build ${T} stopped partway. Nothing was pushed.`;
  else lead = `The ${esc(P)} build ${T} stopped before the agent started. Nothing ran and nothing was spent.`;
  const det = w.replace(/\s*(Nothing ran|No model call was made)\.\s*$/, '');
  return both([lead, '', next, '', `Details: ${esc(cut(det))}`]);
}
