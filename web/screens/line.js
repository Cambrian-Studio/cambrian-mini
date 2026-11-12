// The line: per ticket, six stations lighting up in order, driven by the run record.

import * as api from '../lib/api.js';
import { h, put, plural, card, usd, when, short, seconds, stateChip, originChip, failure } from '../lib/ui.js';

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
    push('approved', 'on', [who ? `${at(s.approved)}approved by ${who}; signatures verified by the line`
      : `${at(s.approved)}${run.release?.note || 'approved'}`]);
  }
  const attempts = run.attempts || [];
  attempts.forEach((a, i) => {
    const last = i === attempts.length - 1;
    push('build', last && final.build === 'now' ? 'now' : 'on', [
      a.walls ? `attempt ${a.n}  walls: ${a.walls}${a.sandbox?.kind ? ` (${a.sandbox.kind})` : ''}` : null,
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
    if (who) return `Signed by ${who}. The line verified the signatures.`;
    const note = run.release?.note;
    return note ? `${note.charAt(0).toUpperCase()}${note.slice(1)}.` : 'Approved.';
  }
  if (name === 'build') {
    if (state === 'now') return 'The agent is building behind walls.';
    const walls = attempts.some((a) => a.walls);
    return `The agent ran${walls ? ' behind walls' : ''}. ${plural(attempts.length, 'attempt')}, ${run.cost?.calls ?? 0} model calls.`;
  }
  if (name === 'test') {
    if (state === 'now') return 'The checks are running.';
    if (state === 'red') return run.lessons?.drafted ? 'Red. Cambrian drafted a lesson.' : 'Red. The line stopped here.';
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
    h('div.feather', {}, h('ol.tl.stations', { 'aria-label': 'Stations' }, STATIONS.map((n) => lamps[n]))),
    h('div.actions', {},
      h('button.btn.ghost.small', { type: 'button', onclick: replay }, 'Replay'),
      h('button.textbtn', { type: 'button', onclick: () => { if (log.hidden) showLog(); else log.hidden = true; } }, 'Log'),
      h('a.textbtn', { href: '#/receipts/' + encodeURIComponent(id) }, 'Receipt')),
    log);
  settle();
  return { el, stop, update(next) { run = next; settle(); if (!log.hidden) showLog(); } };
}

export async function render(root) {
  const { runs = [] } = await api.get('runs.json');
  const list = h('div.runs');
  const rows = new Map();
  const live = api.isLive();

  put(root,
    h('header.head', {}, h('p.eyebrow', {}, 'The line'), h('h1.statement', {}, 'Every ticket runs the same six stations.'),
      h('p.lede', {}, 'Brief, council, build, checks, preview, receipt. A red run stops at the checks and still leaves '
        + 'its receipt. A brief without two valid signatures stops at the council and nothing runs.'),
      h('p.note', {}, live ? 'Live: stations update as the line works.'
        : 'Replay: press “Replay” on a run to watch its recorded stations, compressed to a few seconds.')),
    list);
  if (!runs.length) list.append(h('p.plain', {}, 'No run is recorded yet.'));

  const loaded = await Promise.allSettled(runs.map((r) => api.get(`runs/${encodeURIComponent(r.id)}.json`)));
  loaded.forEach((res, i) => {
    if (res.status === 'rejected') { list.append(failure(res.reason, runs[i].title || runs[i].id)); return; }
    const r = row(res.value);
    rows.set(runs[i].id, r);
    list.append(r.el);
  });

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
