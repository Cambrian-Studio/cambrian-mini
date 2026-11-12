// Watch a build: one recorded product told in seven steps, then every recorded build with its six steps
// lighting up in order. All of it is driven by the run records.

import * as api from '../lib/api.js';
import { h, put, plural, card, usd, when, short, seconds, stateChip, originChip, failure, isImported } from '../lib/ui.js';
import { STEPS } from '../lib/mini.js';

const STATIONS = ['brief', 'approved', 'build', 'test', 'preview', 'receipt'];
const still = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// The state of each station as the record stands: off | on | now | red.
// The line is sequential, so a station without its own time is lit when a later one was reached.
// A red run lights brief, approved, build, test (red) and its receipt; the preview stays unlit.
// A refused run stops at approved.
export function stationStates(run) {
  const s = run.stations || {};
  const out = {};
  for (const name of STATIONS) out[name] = s[name]?.at ? 'on' : 'off';
  if (run.state === 'refused') {
    for (const name of STATIONS.slice(2)) out[name] = 'off';
    out.brief = 'on';
    out.approved = 'red';
    return out;
  }
  for (let i = 3; i >= 0; i--) {
    if (out[STATIONS[i]] === 'off' && out[STATIONS[i + 1]] !== 'off') out[STATIONS[i]] = 'on';
  }
  if (s.build?.at && !s.build.done) out.build = 'now';
  if (s.test?.at) out.test = !s.test.done ? 'now' : (s.test.green === false ? 'red' : 'on');
  if (run.state === 'red') {
    if (out.test !== 'off') out.test = 'red';
    out.preview = 'off';
  }
  return out;
}

// The steps a replay walks through: each lights one station and adds its log lines.
export function replaySteps(run) {
  const s = run.stations || {};
  const final = stationStates(run);
  const steps = [];
  const push = (station, state, lines) => steps.push({ station, state, lines: lines.filter(Boolean) });
  const at = (x) => (x?.at ? when(x.at) + '  ' : '');
  if (final.brief !== 'off') push('brief', 'on', [`${at(s.brief)}brief: ${run.ticket?.title || run.ticket?.id}`]);
  if (final.approved === 'red') {
    push('approved', 'red', [`refused: ${run.release?.why || run.waiting_on || 'the approvals did not verify'}; nothing ran`]);
    return steps;
  }
  if (final.approved !== 'off') {
    const who = (run.release?.valid || []).join(', ');
    push('approved', 'on', [who ? `${at(s.approved)}approved by ${who}; signatures verified before the build`
      : `${at(s.approved)}${isImported(run) ? 'signed on Cambrian’s private setup; the signature is not in this record'
        : (run.release?.note || 'approved')}`]);
  }
  const attempts = run.attempts || [];
  attempts.forEach((a, i) => {
    const last = i === attempts.length - 1;
    push('build', last && final.build === 'now' ? 'now' : 'on', [
      a.walls ? `attempt ${a.n}  sealed workspace: ${a.walls}${a.sandbox?.kind ? ` (${a.sandbox.kind})` : ''}` : null,
      a.agent ? `attempt ${a.n}  agent ran ${seconds(a.agent.seconds)}`
        + `${a.agent.model ? ' on ' + a.agent.model : ''}, ${(a.calls || []).length} model calls` : null,
    ]);
    const checks = a.checks || [];
    if (!checks.length) return;
    push('test', a.green ? 'on' : (last ? final.test : 'red'), checks.map((c) =>
      `${c.pass ? '✓' : '✗'} ${c.name || c.id}${c.detail ? '  ' + c.detail : ''}`));
  });
  if (!attempts.length && final.build !== 'off') push('build', final.build, ['the agent is building']);
  if (final.preview !== 'off') {
    push('preview', 'on', [s.preview?.url ? `preview up: ${s.preview.url}` : `preview: ${run.preview?.why || 'no address recorded'}`]);
  }
  if (final.receipt !== 'off') {
    const sha = s.receipt?.sha256 || run.receipt_sha256;
    const cost = `${usd(run.cost?.usd)}, ${run.cost?.calls ?? '–'} calls`;
    push('receipt', 'on', [`receipt written${sha ? ' ' + short(sha, 16) + '…' : ''}  ${cost}`]);
  }
  if (run.state === 'red' && run.waiting_on) steps[steps.length - 1].lines.push(`✗ ${run.waiting_on}`);
  return steps;
}

// The name each station carries on the timeline.
const STEP = { brief: 'Brief', approved: 'Council', build: 'Build', test: 'Checks', preview: 'Preview', receipt: 'Receipt' };

// One line per station, as a plain report of what the record says happened there.
export function stationReport(run, name, state) {
  const s = run.stations || {};
  const attempts = run.attempts || [];
  if (state === 'off') return name === 'preview' && run.finished ? 'No preview.' : 'Not reached.';
  if (name === 'brief') return 'The brief was written.';
  if (name === 'approved') {
    if (state === 'red') return `Refused: ${run.release?.why || run.waiting_on || 'the signatures did not verify'}. Nothing ran.`;
    const who = (run.release?.valid || []).join(', ');
    if (who) return `Signed by ${who}. Cambrian verified the signatures.`;
    const note = run.release?.note;
    if (isImported(run)) return 'Signed by one council member on Cambrian’s private setup. That signature is not in this record.';
    return note ? `${note.charAt(0).toUpperCase()}${note.slice(1)}.` : 'Approved.';
  }
  if (name === 'build') {
    if (state === 'now') return 'The agent is building in a sealed workspace.';
    const walls = attempts.some((a) => a.walls);
    return `The agent ran${walls ? ' in a sealed workspace' : ''}. ${plural(attempts.length, 'attempt')}, `
      + `${run.cost?.calls ?? 0} model calls.`;
  }
  if (name === 'test') {
    if (state === 'now') return 'The checks are running.';
    if (state === 'red') {
      return run.lessons?.drafted ? 'A check failed. Cambrian drafted a lesson.' : 'A check failed. The build stopped here.';
    }
    return 'The checks passed.';
  }
  if (name === 'preview') return s.preview?.url ? 'The preview was deployed.' : `Preview: ${run.preview?.why || 'no address recorded'}.`;
  return `The receipt was written. ${usd(run.cost?.usd)}, ${run.cost?.calls ?? '–'} calls.`;
}

function row(run) {
  const id = run.ticket?.id || run.id;
  const said = Object.fromEntries(STATIONS.map((name) => [name, h('span.said')]));
  const lamps = Object.fromEntries(STATIONS.map((name) => [name, h('li', { 'data-state': 'off' }, h('i', { 'aria-hidden': 'true' }),
    h('div', {}, h('span.step', {}, STEP[name]), said[name]))]));
  const log = h('ol.log.cb-card.cb-card2', { 'aria-label': 'Attempt log', hidden: true });
  const chipSlot = h('span');
  const facts = h('span');
  let timer = null;

  // While a replay plays, a station that has not been reached yet says nothing.
  const paint = (states, playing) => {
    for (const name of STATIONS) {
      lamps[name].dataset.state = states[name];
      said[name].textContent = playing && states[name] === 'off' ? '' : stationReport(run, name, states[name]);
    }
  };
  const stop = () => { clearTimeout(timer); timer = null; };

  function settle() {
    stop();
    paint(stationStates(run));
    chipSlot.replaceChildren(stateChip(run.state));
    const took = run.finished && run.started ? seconds((Date.parse(run.finished) - Date.parse(run.started)) / 1000) : 'running';
    const tries = plural((run.attempts || []).length, 'attempt');
    facts.textContent = `${tries} · ${run.cost?.calls ?? 0} calls · ${usd(run.cost?.usd)} · ${took}`;
  }

  function showLog() {
    log.hidden = false;
    log.replaceChildren(...replaySteps(run).flatMap((st) => st.lines.map((l) =>
      h('li', { class: l.startsWith('✗') || l.startsWith('refused') ? 'bad' : '' }, l))));
  }

  // Lights the stations one by one from the recorded order, compressed to a few seconds.
  function replay() {
    stop();
    const steps = replaySteps(run);
    if (still()) { settle(); showLog(); return; }
    const states = Object.fromEntries(STATIONS.map((n) => [n, 'off']));
    paint(states, true);
    log.hidden = false;
    log.replaceChildren();
    const pace = Math.max(450, Math.min(900, 6000 / Math.max(steps.length, 1)));
    let i = 0;
    const tick = () => {
      if (i > 0) {
        const prev = steps[i - 1];
        states[prev.station] = prev.state;
      }
      if (i >= steps.length) { settle(); return; }
      const st = steps[i++];
      states[st.station] = 'now';
      paint(states, true);
      for (const l of st.lines) log.append(h('li', { class: l.startsWith('✗') || l.startsWith('refused') ? 'bad' : '' }, l));
      timer = setTimeout(tick, pace);
    };
    tick();
  }

  const el = card('article.pad.run', { tl: run.ticket?.product || 'run', tr: chipSlot, bl: facts }, { 'data-run': id },
    h('h3', {}, run.ticket?.title || id),
    originChip(run),
    h('div.feather', {}, h('ol.tl.stations', { 'aria-label': 'Steps' }, STATIONS.map((n) => lamps[n]))),
    h('div.actions', {},
      h('button.btn.ghost.small', { type: 'button', onclick: replay }, 'Replay'),
      h('button.textbtn', { type: 'button', onclick: () => { if (log.hidden) showLog(); else log.hidden = true; } }, 'Log'),
      h('a.textbtn', { href: '#/receipts/' + encodeURIComponent(id) }, 'Receipt')),
    log);
  settle();
  return { el, stop, update(next) { run = next; settle(); if (!log.hidden) showLog(); } };
}

const NUM = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const word = (n) => NUM[n] || String(n);
const listed = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

// One product, start to finish, as seven plain past-tense lines. Every name, count and cost is read from the
// run records; a step the record does not hold says so instead of borrowing a line from somewhere else.
export function story(product, runs, { council = null, lessons = [], onChain = [] } = {}) {
  const seq = [...runs].sort((x, y) => String(x.started).localeCompare(String(y.started)));
  const first = seq[0];
  if (!first) return [];
  const name = (id) => council?.members?.find((m) => m.id === id)?.name || id;
  const imported = seq.some(isImported);
  const checksOf = (r) => (r.ticket?.green || []).length || (r.attempts?.[0]?.checks || []).length;
  const green = (r) => /^green/.test(String(r.state));
  const lines = [];

  const by = first.proposed_by?.member || product?.proposed_by || null;
  lines.push(`${by ? name(by) : 'A member'} described the idea: ${product?.name || first.ticket?.product || 'a product'}.`
    + (product?.tagline ? ` ${product.tagline}` : ''));

  lines.push(`${first.ticket?.drafted ? 'Cambrian wrote the brief' : 'The brief was written'}, with `
    + `${plural(checksOf(first), 'check')} and a ${usd(first.ticket?.budget?.usd)} budget.`);

  const valid = first.release?.valid || [];
  lines.push(valid.length ? `${listed(valid.map(name))} signed.`
    : imported ? 'One council member signed with a passkey on Cambrian’s private setup. '
      + 'That signature is not in this record and cannot be checked here.'
      : 'No signature is recorded.');

  const sealed = (first.attempts || []).some((x) => x.walls);
  lines.push(`Agents built it${sealed ? ' in a sealed workspace' : ''}${imported ? '' : ' on NEAR AI'}. `
    + `${plural(first.cost?.calls ?? 0, 'model call')}, ${usd(first.cost?.usd)}.`);

  const red = seq.find((r) => r.state === 'red');
  if (red) {
    const checks = red.attempts?.at(-1)?.checks || [];
    const failed = checks.filter((c) => !c.pass).length;
    const learned = red.lessons?.learned || [];
    const signed = lessons.filter((l) => learned.includes(l.id) && l.accepted_by).length;
    const after = seq.slice(seq.indexOf(red) + 1).filter(green);
    const next = after[0];
    lines.push([
      `${word(failed)} of ${word(checks.length).toLowerCase()} checks failed and the build stopped.`,
      red.lessons?.drafted ? 'Cambrian drafted a lesson.'
        : learned.length ? `${word(learned.length)} lesson${learned.length === 1 ? ' was' : 's were'} written from it.` : null,
      learned.length || red.lessons?.drafted
        ? (signed ? `The members signed ${signed === learned.length ? (signed === 1 ? 'it' : 'them') : word(signed).toLowerCase()}.`
          : 'No member’s signature on them is in this record.') : null,
      next ? `The next build passed${(next.attempts || []).length === 1 ? ' on the first try' : ''}, for ${usd(next.cost?.usd)}.`
        : 'No later build is recorded.',
      after.length > 1 ? `${word(after.length - 1)} more passed after it.` : null,
    ].filter(Boolean).join(' '));
  } else {
    lines.push(seq.every(green) ? 'Every check passed.' : 'The checks have not finished.');
  }

  const url = product?.live_url || seq.map((r) => r.stations?.preview?.url || r.preview?.url).find(Boolean) || null;
  const previews = seq.filter((r) => r.preview || r.stations?.preview?.at).length;
  lines.push(url ? 'A preview link went up, and the product is live.'
    : previews ? `${word(previews)} preview${previews === 1 ? '' : 's'} went up behind a sign-in. There is no public link yet.`
      : 'No preview went up.');

  lines.push(onChain.length === seq.length ? 'Recorded on NEAR.'
    : onChain.length ? `${word(onChain.length)} of ${word(seq.length).toLowerCase()} builds recorded on NEAR.`
      : 'Not recorded on NEAR yet. The record of each build is hashed, and anyone can recompute the hash on Verify.');

  const links = [null, null, null, null, ['#/lessons', 'Read the lessons'], url ? [url, 'Open it'] : null,
    ['#/receipts/' + encodeURIComponent(seq.at(-1).ticket?.id || ''), 'Verify it']];
  return lines.map((line, i) => ({ n: i + 1, title: STEPS[i][0], line, link: links[i] }));
}

export async function render(root, arg) {
  const { runs = [] } = await api.get('runs.json');
  const list = h('div.runs');
  const rows = new Map();
  const live = api.isLive();
  const told = h('ol.tl.story', { 'aria-label': 'One build, in seven steps' });
  const which = h('p.lede');

  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'Watch a build'),
      h('h1.statement', {}, 'From an idea to a live product, in seven steps.'), which),
    told,
    h('header.head.second', {}, h('h2.h2', {}, 'Every recorded build.'),
      h('p.lede', {}, 'Brief, signatures, build, checks, preview, record. A failed build stops at the checks and still '
        + 'leaves its record. A brief without enough valid signatures stops before anything is built.'),
      h('p.note', {}, live ? 'Live: the steps update as a build runs.'
        : 'Replay: press “Replay” on a build to watch its recorded steps, compressed to a few seconds.')),
    list);
  if (!runs.length) list.append(h('p.plain', {}, 'No build is recorded yet.'));

  const loaded = await Promise.allSettled(runs.map((r) => api.get(`runs/${encodeURIComponent(r.id)}.json`)));
  loaded.forEach((res, i) => {
    if (res.status === 'rejected') { list.append(failure(res.reason, runs[i].title || runs[i].id)); return; }
    const r = row(res.value);
    rows.set(runs[i].id, r);
    list.append(r.el);
  });

  const full = loaded.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const [productsR, councilR, lessonsR] = await Promise.allSettled(
    ['products.json', 'council.json', 'lessons.json'].map((n) => api.get(n)));
  const products = productsR.status === 'fulfilled' ? productsR.value.products || [] : [];
  const product = products.find((p) => full.some((r) => r.ticket?.product === p.id)) || null;
  const mine = product ? full.filter((r) => r.ticket?.product === product.id) : full.slice(0, 1);
  const receipts = await Promise.allSettled(mine.map((r) => api.get(`receipts/${encodeURIComponent(r.ticket?.id)}.json`)));
  const steps = story(product, mine, {
    council: councilR.status === 'fulfilled' ? councilR.value : null,
    lessons: lessonsR.status === 'fulfilled' ? lessonsR.value.lessons || [] : [],
    onChain: receipts.filter((r) => r.status === 'fulfilled' && r.value?.on_chain),
  });
  which.textContent = steps.length ? `${product?.name || 'One product'}, start to finish, from the record.` : 'No build is recorded yet.';
  told.replaceChildren(...steps.map((st) => h('li', { id: `step-${st.n}`, 'data-state': 'on' }, h('i', { 'aria-hidden': 'true' }),
    h('div', {}, h('span.step', {}, `${String(st.n).padStart(2, '0')} · ${st.title.replace(/\.$/, '')}`), h('span.said', {}, st.line),
      st.link ? h('a.link', { href: st.link[0] }, st.link[1]) : null))));
  const toStep = () => document.getElementById(`step-${arg}`)?.scrollIntoView({ block: 'center' });
  if (arg) root.addEventListener('shown', toStep, { once: true });

  const onRun = (e) => {
    const run = e.detail;
    const id = run.ticket?.id;
    if (!id) return;
    if (rows.has(id)) { rows.get(id).update(run); return; }
    const r = row(run);
    rows.set(id, r);
    list.querySelector('.plain')?.remove();
    list.prepend(r.el);
  };
  window.addEventListener('run-update', onRun);
  return () => {
    window.removeEventListener('run-update', onRun);
    for (const r of rows.values()) r.stop();
  };
}
