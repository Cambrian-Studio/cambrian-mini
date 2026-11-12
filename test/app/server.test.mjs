// The app in REPLAY: it serves the record, never a file outside web/, and every spending or signing route says no.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appConfig } from '../../app/config.mjs';
import { makeServer, safeFile } from '../../app/server.mjs';
import { buildStatic } from '../../app/static-build.mjs';
import { snapshot } from '../../app/store.mjs';

const replayCfg = () => ({ ...appConfig(), mode: 'replay', reasons: ['test'], port: 0 });
async function withServer(fn) {
  const { server } = await makeServer(replayCfg());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

test('path escape: nothing outside web/ is ever served', async () => {
  const web = join(appConfig().root, 'web');
  assert.ok(safeFile(web, '/index.html'));
  for (const p of ['/../package.json', '/..%2Fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/assets/../../data/council.json', '/\0x', '/%zz'])
    assert.equal(safeFile(web, p), null, p);
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    for (const p of ['/..%2Fpackage.json', '/%2e%2e/%2e%2e/package.json', '/.%2e/data/council.json']) assert.equal((await fetch(`${base}${p}`)).status, 404, p);
  });
});
test('REPLAY serves the record and the shared canonical file', async () => {
  await withServer(async (base) => {
    const mode = await (await fetch(`${base}/api/mode.json`)).json();
    assert.equal(mode.mode, 'replay'); assert.equal(mode.can_spend, false); assert.equal(mode.can_sign, false); assert.equal(mode.dao.available, false);
    const runs = await (await fetch(`${base}/api/runs.json`)).json(); assert.ok(Array.isArray(runs.runs));
    for (const r of runs.runs.filter((x) => x.finished)) {
      const rc = await (await fetch(`${base}/api/receipts/${r.id}.json`)).json(); assert.match(rc.receipt_sha256, /^[0-9a-f]{64}$/);
    }
    const lib = await fetch(`${base}/lib/canonical.mjs`); assert.equal(lib.status, 200);
    assert.equal(await lib.text(), readFileSync(join(appConfig().root, 'receipts/canonical.mjs'), 'utf8'));
    assert.equal((await fetch(`${base}/api/nope.json`)).status, 404);
  });
});
test('REPLAY: every route that would spend or sign answers 409 and says why', async () => {
  await withServer(async (base) => {
    for (const p of ['/api/ideas', '/api/approve', '/api/enrol', '/api/lessons/accept']) {
      const r = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 409, p); assert.match((await r.json()).why, /REPLAY/);
    }
    assert.equal((await fetch(`${base}/api/events`)).status, 409);
    assert.equal((await fetch(`${base}/`, { method: 'DELETE' })).status, 405);
  });
});
test('the static build is the same record, in replay mode, with no fixtures and no private state', () => {
  const out = mkdtempSync(join(tmpdir(), 'baby-cambrian-static-test-'));
  try {
    const cfg = replayCfg(); const r = buildStatic({ out, cfg });
    assert.ok(r.files > 5);
    const mode = JSON.parse(readFileSync(join(out, 'api/mode.json'), 'utf8')); assert.equal(mode.mode, 'replay'); assert.equal(mode.can_spend, false);
    const snap = snapshot(cfg);
    for (const k of Object.keys(snap).filter((x) => x !== 'api/mode.json')) assert.deepEqual(JSON.parse(readFileSync(join(out, k), 'utf8')), JSON.parse(JSON.stringify(snap[k])), k);
    assert.equal(existsSync(join(out, 'fixtures')), false); assert.ok(existsSync(join(out, 'lib/canonical.mjs'))); assert.ok(existsSync(join(out, 'index.html')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('with a key file present the server boots in LIVE mode (and still listens on loopback only)', async () => {
  const { spawn } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'baby-cambrian-liveboot-test-'));
  writeFileSync(join(dir, 'key'), 'not-a-real-key', { mode: 0o600 });
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, [join(appConfig().root, 'app/server.mjs')], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NEARAI_KEY_FILE: join(dir, 'key'), CAMBRIAN_PORT: String(port), CAMBRIAN_STATE: join(dir, 'state'), CAMBRIAN_MODE: '' } });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  try {
    for (let i = 0; i < 50 && !/open http/.test(out) && child.exitCode === null; i++) await new Promise((r) => setTimeout(r, 100));
    assert.match(out, /LIVE mode/, out);
    const mode = await (await fetch(`http://127.0.0.1:${port}/api/mode.json`)).json();
    assert.equal(mode.mode, 'live'); assert.equal(mode.can_spend, true);
    const cross = await fetch(`http://127.0.0.1:${port}/api/ideas`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403, 'a page on another site cannot drive the LIVE routes');
  } finally { child.kill(); rmSync(dir, { recursive: true, force: true }); }
});
