// The shell: reads the mode, draws the header, and routes the hash to one screen at a time.

import * as api from './lib/api.js';
import { h, failure, closeSheet, toast } from './lib/ui.js';
import * as home from './screens/home.js';
import * as talk from './screens/talk.js';
import * as approvals from './screens/approvals.js';
import * as line from './screens/line.js';
import * as products from './screens/products.js';
import * as receipts from './screens/receipts.js';
import * as lessons from './screens/lessons.js';
import * as stake from './screens/stake.js';
import * as notifications from './screens/notifications.js';

const screens = {
  '': home, talk, approvals, enrol: approvals.enrol, line, products, receipts, lessons, stake, notifications,
};
const titles = {
  '': 'Cambrian', talk: 'Talk to Cambrian', approvals: 'Approvals', enrol: 'Enrol a passkey', line: 'The line',
  products: 'Products', receipts: 'Receipts', lessons: 'Lessons', stake: 'Stake', notifications: 'Notifications',
};

const main = document.getElementById('main');
let cleanup = null;
let turn = 0;

function parse() {
  const [name = '', ...rest] = location.hash.replace(/^#\/?/, '').split('/');
  return { name, arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
}

async function route() {
  const { name, arg } = parse();
  const screen = screens[name];
  const mine = ++turn;
  closeSheet(true);
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;

  for (const a of document.querySelectorAll('.nav a')) {
    if (a.dataset.route === name) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = name ? `${titles[name] || 'Not found'} · Cambrian` : 'Cambrian: a collective that ships products';

  const root = h('div.screen', { 'data-screen': name || 'home' });
  main.replaceChildren(root);
  if (!screen) {
    root.append(h('p.plain', {}, 'There is no such screen. '), h('a.link', { href: '#/' }, 'Back to the start'));
    return;
  }
  root.append(h('p.plain', {}, 'Loading…'));
  try {
    const fresh = h('div.screen', { 'data-screen': name || 'home' });
    const done = await screen.render(fresh, arg);
    if (mine !== turn) { if (typeof done === 'function') done(); return; }
    main.replaceChildren(fresh);
    cleanup = done;
    fresh.dispatchEvent(new CustomEvent('shown'));
  } catch (err) {
    if (mine !== turn) return;
    root.replaceChildren(failure(err, titles[name]));
  }
  // A sheet opens over its list, so the list keeps its place; every other screen starts at the top.
  if (!(arg && (name === 'approvals' || name === 'products'))) window.scrollTo(0, 0);
}

function drawMode(info) {
  const live = info.mode === 'live';
  document.documentElement.dataset.mode = live ? 'live' : 'replay';
  document.getElementById('mode-name').textContent = live ? 'LIVE' : 'REPLAY';
  document.getElementById('mode-line').textContent = live
    ? 'Ideas reach a model. Signing needs a passkey.'
    : 'Recorded runs, nothing spends or signs.';
  document.getElementById('mode-badge').title = (info.reasons || []).join(' · ');
}

async function drawBell() {
  try {
    const { tickets = [] } = await api.get('tickets.json');
    const waiting = tickets.filter((t) => t.status === 'awaiting-approval').length;
    const badge = document.getElementById('bell-count');
    badge.hidden = waiting === 0;
    badge.textContent = waiting || '';
    document.getElementById('bell').setAttribute('aria-label',
      waiting ? `Notifications, ${waiting} waiting for the council` : 'Notifications');
  } catch { /* the bell still opens the list, which says what failed */ }
}

// In live mode the server says when something moved; the screens re-read what they show.
function onEvent(msg) {
  if (msg.type === 'hello') return;
  api.forgetAll();
  if (msg.type === 'run' && msg.run) {
    const run = msg.run;
    window.dispatchEvent(new CustomEvent('run-update', { detail: run }));
    const title = run.ticket?.title || run.ticket?.id || 'a run';
    if (run.state === 'green-preview') toast(`${title} built cleanly. Preview ready.`, 'green');
    else if (String(run.state).startsWith('green')) toast(`${title} built cleanly.`, 'green');
    else if (run.state === 'red') toast(`${title} went red.`, 'red');
    else if (run.state === 'refused') toast(`${title} was refused. Nothing ran.`, 'red');
  } else if (msg.type === 'ticket') {
    toast('A brief changed. See Approvals.');
  } else if (msg.type === 'lesson-draft') {
    toast('Cambrian drafted a lesson from a red run. See Lessons.');
  } else if (msg.type === 'lesson') {
    toast('A council member accepted a lesson.', 'green');
  } else if (msg.type === 'error') {
    toast(msg.why || 'The line reported an error.', 'red');
  }
  drawBell();
}

async function start() {
  let info;
  try {
    info = await api.init();
  } catch (err) {
    document.getElementById('mode-name').textContent = 'OFFLINE';
    document.getElementById('mode-line').textContent = 'The record could not be read.';
    main.replaceChildren(failure(err, 'The record'));
    return;
  }
  drawMode(info);
  drawBell();
  api.events(onEvent);
  window.addEventListener('hashchange', route);
  route();
}

start().catch((err) => main.replaceChildren(failure(err, 'Cambrian')));
