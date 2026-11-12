// Two things an earlier test claimed without proving, found by an independent audit that broke the code and
// watched the old tests still pass: the path check on raw request targets, and the loopback-only bind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { appConfig } from '../../app/config.mjs';
import { makeServer, safeFile } from '../../app/server.mjs';

const replayCfg = () => ({ ...appConfig(), mode: 'replay', reasons: ['test'] });

/** Send one request line exactly as written (no client-side URL clean-up) and return the raw response. */
function raw(port, target) {
  return new Promise((resolve, reject) => {
    let out = '';
    const s = connect(port, '127.0.0.1', () => s.write(`GET ${target} HTTP/1.1\r\nHost: h\r\nConnection: close\r\n\r\n`));
    s.on('data', (d) => { out += d; });
    s.on('end', () => resolve(out));
    s.on('error', reject);
  });
}

test('path escape, on the wire: targets a browser would never send are still held inside web/', async () => {
  const cfg = replayCfg();
  const { server } = await makeServer(cfg);
  await new Promise((r) => server.listen(0, cfg.host, r));
  const port = server.address().port;
  const secretOfTheRepo = readFileSync(join(cfg.root, 'package.json'), 'utf8').slice(0, 40);
  try {
    const targets = ['/../../../package.json', 'http://h/../../../package.json', '../package.json', '/..\\..\\package.json',
      '//etc/passwd', '/assets/../../data/council.json', 'http://h/../data/council.json', '/%2e%2e/%2e%2e/package.json'];
    for (const t of targets) {
      const res = await raw(port, t);
      assert.doesNotMatch(res, /^HTTP\/1\.1 200/, `${t} must not be served`);
      assert.ok(!res.includes(secretOfTheRepo), `${t} leaked a file from outside web/`);
      assert.ok(!res.includes('"threshold"'), `${t} leaked the council file`);
    }
    assert.match(await raw(port, '/index.html'), /^HTTP\/1\.1 200/, 'the control: a real file is served');
  } finally { await new Promise((r) => server.close(r)); }
});

test('safeFile itself refuses every target that resolves outside its root', () => {
  const web = join(appConfig().root, 'web');
  for (const t of ['http://h/../../../package.json', '../package.json', '/../package.json', '..']) assert.equal(safeFile(web, t), null, t);
  assert.ok(safeFile(web, '/index.html'));
});

test('the app binds loopback only, whatever the environment says', async () => {
  const before = { ...process.env };
  try {
    for (const k of ['CAMBRIAN_HOST', 'HOST', 'BIND', 'CAMBRIAN_EXPOSED']) process.env[k] = k === 'CAMBRIAN_EXPOSED' ? '1' : '0.0.0.0';
    const cfg = { ...appConfig(), mode: 'replay', reasons: ['test'] };
    assert.equal(cfg.host, '127.0.0.1');
    const { server } = await makeServer(cfg);
    await new Promise((r) => server.listen(0, cfg.host, r));
    try { assert.equal(server.address().address, '127.0.0.1', 'the listening socket is on loopback'); }
    finally { await new Promise((r) => server.close(r)); }
  } finally { for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k]; Object.assign(process.env, before); }
});

test('the entry point listens on the configured loopback host and nowhere else', () => {
  // the one place the server starts listening must pass cfg.host, so a bind to every interface cannot slip in
  const src = readFileSync(join(appConfig().root, 'app', 'server.mjs'), 'utf8');
  const listens = src.match(/server\.listen\([^)]*\)/g) ?? [];
  assert.equal(listens.length, 1);
  assert.match(listens[0], /server\.listen\(cfg\.port, cfg\.host,/);
  assert.match(readFileSync(join(appConfig().root, 'app', 'config.mjs'), 'utf8'), /host: '127\.0\.0\.1',/);
});
