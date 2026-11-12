// The three imported Upread records in data/runs/ are clean and have the run-record fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { faults } from '../support/deny.mjs';

const scanText = (text) => text.split('\n').flatMap((line) => faults(line));
const scanDir = (dir) => readdirSync(dir).flatMap((n) => scanText(readFileSync(join(dir, n), 'utf8')).map((f) => `${n}: ${f}`));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNS = join(ROOT, 'data', 'runs');
const IDS = ['upread-v1-one-word-at-a-time-reader-for', 'upread-v1-open-pdf', 'upread-v1-reader-shell'];
const load = (id, f = 'run.json') => JSON.parse(readFileSync(join(RUNS, id, f), 'utf8'));
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA = /^[0-9a-f]{40}$/;

test('the three Upread runs are there and pass the deny-list', () => {
  assert.deepEqual(readdirSync(RUNS).filter((n) => n.startsWith('upread-')).sort(), IDS);
  for (const id of IDS) {
    assert.deepEqual(readdirSync(join(RUNS, id)).sort(), ['run.json', 'ticket.json'], id);
    assert.deepEqual(scanDir(join(RUNS, id)), [], id);
  }
  assert.deepEqual(scanText(readFileSync(join(ROOT, 'data', 'products.json'), 'utf8')), []);
});

test('each record has the run-record fields', () => {
  const top = ['v', 'origin', 'mode', 'ticket', 'ticket_sha256', 'approvals', 'release', 'state', 'waiting_on', 'started', 'finished',
    'stations', 'budget', 'attempts', 'main', 'push', 'preview', 'cost', 'lessons', 'notifications', 'receipt_sha256'];
  for (const id of IDS) {
    const r = load(id);
    for (const k of top) assert.ok(k in r, `${id}: ${k}`);
    assert.equal(r.v, 1);
    assert.equal(r.origin, 'private-line');
    assert.equal(r.ticket.id, id);
    assert.deepEqual(Object.keys(r.ticket), ['id', 'title', 'product', 'branch', 'budget', 'checks']);
    assert.ok(['red', 'green-preview'].includes(r.state));
    assert.match(r.started, ISO);
    assert.match(r.finished, ISO);
    assert.deepEqual(Object.keys(r.stations), ['brief', 'approved', 'build', 'test', 'preview', 'receipt']);
    assert.match(r.stations.approved.at, ISO);
    assert.ok(r.stations.approved.at <= r.stations.build.at && r.stations.build.at <= r.stations.build.done);
    assert.ok(r.stations.test.at <= r.stations.test.done && r.stations.test.done <= r.stations.receipt.at);
    assert.deepEqual(r.approvals, []);
    assert.equal(r.release.ok, null);
    assert.equal(r.imported.from, "Cambrian's private line");
    assert.equal(r.imported.scrubbed, true);
    assert.match(r.attestation_note, /did not capture attestations/);
    assert.ok(r.attempts.length >= 1);
    for (const a of r.attempts) {
      const need = ['n', 'started', 'finished', 'walls', 'sandbox', 'agent', 'bridge', 'calls', 'commit', 'green', 'failing', 'checks'];
      for (const k of need) {
        assert.ok(k in a, `${id} a${a.n}: ${k}`);
      }
      assert.match(a.commit, SHA);
      assert.ok(a.calls.length > 0);
      for (const c of a.calls) {
        assert.deepEqual(Object.keys(c), ['seq', 'at', 'model', 'prompt_tokens', 'cached_tokens', 'cache_write_tokens',
          'completion_tokens', 'usd', 'ms', 'status', 'finish', 'chat_id', 'attestation']);
        assert.equal(c.attestation, null);
        assert.match(c.at, ISO);
      }
      // the priced calls in the trace add up to what the run's meter recorded for the attempt
      const sum = a.calls.reduce((s, c) => s + (c.usd ?? 0), 0);
      assert.ok(Math.abs(sum - a.bridge.computed_usd) < 1e-6, `${id} a${a.n}: ${sum} vs ${a.bridge.computed_usd}`);
      for (const c of a.checks) assert.deepEqual(Object.keys(c).slice(0, 4), ['id', 'name', 'kind', 'pass']);
      assert.deepEqual(a.failing, a.checks.filter((c) => !c.pass).map((c) => c.id));
    }
    for (const n of r.notifications) {
      assert.deepEqual(Object.keys(n), ['ts', 'kind', 'text']);
      assert.doesNotMatch(n.text, /<[a-z]|https?:\/\//i);
    }
    const t = load(id, 'ticket.json');
    assert.deepEqual(Object.keys(t), ['kind', 'v', 'id', 'product', 'title', 'task', 'green', 'budget', 'base', 'branch']);
    assert.equal(t.title, r.ticket.title);
    assert.deepEqual(t.budget, r.ticket.budget);
    assert.deepEqual(t.green.map((c) => c.id), r.ticket.checks);
  }
});

test('the evidence: one RED and two GREEN, with the figures the lessons quote', () => {
  const red = load(IDS[0]);
  assert.equal(red.state, 'red');
  assert.equal(red.attempts.length, 1);
  assert.deepEqual(red.attempts[0].agent, { kind: 'OpenCode', exit: 142, seconds: 2701, model: 'anthropic/claude-opus-5-5' });
  assert.deepEqual(red.attempts[0].failing, ['build', 'test', 'manifest', 'extract-fn', 'no-external']);
  assert.equal(red.cost.usd, 3.977314);
  assert.equal(red.cost.run_meter.usd, 3.910366);
  assert.equal(red.cost.figures_differ, true);
  assert.equal(red.cost.calls, 22);
  assert.equal(red.attempts[0].calls.length, 21);
  assert.match(red.attempts[0].calls_note, /21 finished calls.*22 forwarded/);
  assert.deepEqual(red.push, { pushed: false });
  assert.equal(red.preview, null);
  assert.deepEqual(red.lessons.learned,
    ['one-feature-per-ticket', 'write-files-early', 'no-dependency-auditing', 'checks-must-be-passable']);

  const pdf = load(IDS[1]);
  assert.equal(pdf.state, 'green-preview');
  assert.deepEqual(pdf.attempts.map((a) => [a.n, a.green, a.agent.seconds, a.calls.length]), [[1, false, 321, 27], [2, true, 42, 7]]);
  assert.equal(pdf.cost.usd, 0.761548);
  assert.equal(pdf.cost.calls, 34);
  assert.equal(pdf.cost.figures_differ, false);
  assert.equal(pdf.main.untouched, true);
  assert.equal(pdf.push.commit, 'ac48164bea91adfc64cef6a87d534e5551ef9564');
  assert.equal(pdf.preview.url, null);
  assert.match(pdf.preview.why, /behind sign-in/);

  const shell = load(IDS[2]);
  assert.equal(shell.state, 'green-preview');
  assert.deepEqual(shell.attempts.map((a) => [a.n, a.green, a.agent.seconds, a.calls.length]), [[1, true, 455, 17]]);
  assert.equal(shell.cost.usd, 0.624346);
  assert.equal(shell.cost.calls, 17);
  assert.deepEqual(shell.lessons.learned, ['after-red-a-smaller-ticket']);

  const product = JSON.parse(readFileSync(join(ROOT, 'data', 'products.json'), 'utf8')).products[0];
  assert.equal(product.id, 'upread');
  assert.deepEqual([...product.runs].sort(), IDS);
  assert.equal(product.cost_usd, Number((red.cost.usd + pdf.cost.usd + shell.cost.usd).toFixed(6)));
  assert.equal(product.live_url, null);
  assert.ok(product.live_url_note.length > 20);
});
