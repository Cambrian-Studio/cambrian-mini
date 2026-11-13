// `npm run solo`: one person deciding alone is its own labelled case (solo: true, one member, threshold 1).
// It is never read as the collective's council, and a build's kept page is served back only on a machine
// that is not reachable from outside.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCouncil } from '../../approvals/council.mjs';
import { verifyRelease } from '../../approvals/release.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { parseTicket } from '../../tickets/ticket.mjs';
import { appConfig } from '../../app/config.mjs';
import { localPreview } from '../../app/store.mjs';
import { safeFile } from '../../app/server.mjs';

const root = appConfig().root;
const ticket = parseTicket(readFileSync(join(root, 'test/line/fixtures/tickets/facts-page-1.json')));

test('solo: a council of one releases at one signature only when it says it is solo; nothing else below 2 is a council', () => {
  const tc = makeTestCouncil({ members: ['you'], threshold: 1 });
  const one = [tc.sign('you', ticket)];
  assert.equal(verifyRelease(ticket, one, tc.council).ok, false, 'a threshold of 1 without the solo label is refused');
  const solo = { ...tc.council, solo: true };
  assert.equal(verifyRelease(ticket, one, solo).ok, true);
  assert.equal(verifyRelease(ticket, [], solo).ok, false, 'still nothing without the signature');
  assert.equal(verifyRelease({ ...ticket, title: 'Another title' }, one, solo).ok, false, 'and nothing for an altered brief');
  const three = makeTestCouncil();
  assert.equal(verifyRelease(ticket, [three.sign('jj', ticket)], { ...three.council, solo: true, threshold: 1 }).ok, false,
    'a council of three cannot call itself solo');
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-solo-test-'));
  try {
    const f = join(dir, 'council.json');
    writeFileSync(f, JSON.stringify({ ...solo, v: 1, rp: { id: 'localhost', name: 'x', origins: ['http://localhost:8787'] } }));
    assert.equal(loadCouncil(f).threshold, 1);
    writeFileSync(f, JSON.stringify({ ...tc.council, v: 1, rp: { id: 'localhost', name: 'x', origins: ['http://localhost:8787'] } }));
    assert.throws(() => loadCouncil(f), /threshold must be 2 or more/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('solo: a passing build\'s kept page is its local preview, and only on a machine that is not reachable from outside', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cambrian-mini-preview-test-'));
  try {
    const runs = join(dir, 'runs'); mkdirSync(join(runs, 'tides-1', 'output'), { recursive: true }); mkdirSync(join(runs, 'kelp-1', 'output', 'dist'), { recursive: true });
    writeFileSync(join(runs, 'tides-1', 'output', 'index.html'), '<h1>tides</h1>'); writeFileSync(join(runs, 'kelp-1', 'output', 'dist', 'index.html'), '<h1>kelp</h1>');
    const cfg = { mode: 'live', exposed: false, files: { runs } };
    const run = (id, state = 'green-no-preview') => ({ state, ticket: { id } });
    assert.equal(localPreview(cfg, run('tides-1')), 'preview/tides-1/');
    assert.equal(localPreview(cfg, run('kelp-1')), 'preview/kelp-1/dist/', 'a build with a static root of its own');
    assert.equal(localPreview(cfg, run('tides-1', 'red')), null, 'a failed build has no preview');
    assert.equal(localPreview(cfg, run('none-1')), null);
    assert.equal(localPreview({ ...cfg, exposed: true }, run('tides-1')), null, 'never when the app is reachable from outside');
    assert.equal(localPreview({ ...cfg, mode: 'replay' }, run('tides-1')), null);
    assert.equal(safeFile(join(runs, 'tides-1', 'output'), '/../../kelp-1/output/dist/index.html'), null, 'a preview path cannot leave its build');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
