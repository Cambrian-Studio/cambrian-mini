// The preview step, against a stub of Vercel's REST API. No real call is made and no real token exists here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deployPreview, outputFiles, projectName } from '../../line/vercel.mjs';
import { loadConfig } from '../../line/config.mjs';
import { scratch } from './helpers.mjs';

const TOKEN = 'stub-token-not-real';
const json = (status, body) => ({ status, ok: status < 400, json: async () => body });

/** A stub fetch that plays Vercel. `over` changes single answers. It records every request. */
function vercelStub(over = {}) {
  const seen = [];
  let looks = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const auth = init.headers?.authorization ?? null;
    const body = init.body ? JSON.parse(init.body) : null;
    seen.push({ method: init.method ?? 'GET', host: u.host, path: u.pathname, query: u.search, auth, body });
    if (u.host === 'facts-abc123.vercel.app') {
      const seq = over.anonymousSeq;   // e.g. [404, 404, 200]: a fresh deployment's address spreading
      return { status: seq ? (seq.length > 1 ? seq.shift() : seq[0]) : (over.anonymous ?? 200), ok: true, json: async () => ({}) };
    }
    if (u.pathname === '/v11/projects') return json(over.create ?? 409, { error: { message: 'exists' } });
    if (u.pathname.startsWith('/v9/projects/')) {
      return json(over.patch ?? 200, over.patchBody ?? { name: 'cambrian-facts-page', ssoProtection: null, passwordProtection: null });
    }
    if (u.pathname === '/v13/deployments') {
      return json(over.deploy ?? 200, over.deployBody ?? { id: 'dpl_1', url: 'facts-abc123.vercel.app', readyState: 'QUEUED' });
    }
    if (u.pathname === '/v13/deployments/dpl_1') {
      looks++;
      return json(200, { id: 'dpl_1', readyState: over.final && looks >= 2 ? over.final : looks >= 2 ? 'READY' : 'BUILDING' });
    }
    return json(404, {});
  };
  return { fetchImpl, seen };
}
function bed(s, over = {}) {
  const tokenFile = join(s.dir, 'vercel.token');
  writeFileSync(tokenFile, TOKEN + '\n', { mode: 0o600 });
  const dist = join(s.dir, 'clone', 'dist');
  mkdirSync(join(dist, 'assets'), { recursive: true });
  writeFileSync(join(dist, 'index.html'), '<p>hi</p>');
  writeFileSync(join(dist, 'assets', 'a.css'), 'p{}');
  const cfg = loadConfig({
    home: join(s.dir, 'home'),
    vercel_api: 'https://api.vercel.test',
    vercel_token_file: tokenFile,
    vercel_team: 'example-team',
    preview_poll_seconds: 0,
    ...over,
  });
  return { cfg, files: outputFiles(join(s.dir, 'clone')).files };
}
const deploy = (b, stub) =>
  deployPreview(b.cfg, { product: 'facts-page', files: b.files, ticket: 'facts-page-1', commit: 'a'.repeat(40) }, {
    fetchImpl: stub.fetchImpl,
    sleep: async () => {},
  });

test('the happy path: project, protection off, deploy, READY, then an anonymous 200 — only then is it a public preview', async () => {
  const s = scratch('vercel-ok');
  try {
    const b = bed(s);
    const stub = vercelStub();
    const r = await deploy(b, stub);
    assert.deepEqual(r, { state: 'success', url: 'https://facts-abc123.vercel.app', deployment_id: 'dpl_1', public: true });
    assert.deepEqual(stub.seen.map((q) => `${q.method} ${q.path}`), [
      'POST /v11/projects',
      'PATCH /v9/projects/cambrian-facts-page',
      'POST /v13/deployments',
      'GET /v13/deployments/dpl_1',
      'GET /v13/deployments/dpl_1',
      'GET /',
    ]);
    assert.equal(projectName('facts-page'), 'cambrian-facts-page');
    assert.deepEqual(
      stub.seen[1].body,
      { ssoProtection: null, passwordProtection: null },
      'deployment protection is switched off for the project',
    );
    const sent = stub.seen[2].body;
    assert.equal(sent.name, 'cambrian-facts-page');
    assert.deepEqual(sent.projectSettings, { framework: null });
    assert.deepEqual(sent.files, [{ file: 'assets/a.css', data: Buffer.from('p{}').toString('base64'), encoding: 'base64' }, {
      file: 'index.html',
      data: Buffer.from('<p>hi</p>').toString('base64'),
      encoding: 'base64',
    }]);
    // the token goes to the API host as a bearer header, with the team; the proof read carries no credential at all
    for (const q of stub.seen.slice(0, 5)) {
      assert.equal(q.host, 'api.vercel.test');
      assert.equal(q.auth, `Bearer ${TOKEN}`);
      assert.match(q.query, /slug=example-team/);
    }
    assert.deepEqual([stub.seen[5].host, stub.seen[5].auth], ['facts-abc123.vercel.app', null]);
    assert.ok(!stub.seen.some((q) => (q.path + q.query + JSON.stringify(q.body)).includes(TOKEN)), 'the token is never in a URL or a body');
  } finally {
    s.cleanup();
  }
});

test('a preview that still asks for a sign-in is NOT reported as a preview', async () => {
  const s = scratch('vercel-private');
  try {
    const b = bed(s);
    const behind = await deploy(b, vercelStub({ anonymous: 401 }));
    assert.deepEqual([behind.state, behind.public, behind.deployment_id], ['failed', false, 'dpl_1']);
    assert.match(behind.why, /answers 401 without a sign-in/);
    const stillOn = vercelStub({ patchBody: { ssoProtection: { deploymentType: 'preview' } } });
    const r = await deploy(b, stillOn);
    assert.equal(r.state, 'failed');
    assert.match(r.why, /still has deployment protection on/);
    assert.ok(!stillOn.seen.some((q) => q.path === '/v13/deployments'), 'nothing is deployed behind a wall it could not open');
  } finally {
    s.cleanup();
  }
});

test('a fresh deployment that answers 404 at first is asked again; a 404 that stays is not a preview', async () => {
  const s = scratch('vercel-404');
  try {
    const b = bed(s);
    const soon = await deploy(b, vercelStub({ anonymousSeq: [404, 404, 200] }));
    assert.deepEqual([soon.state, soon.public], ['success', true]);
    const never = await deploy(b, vercelStub({ anonymousSeq: [404] }));
    assert.deepEqual([never.state, never.public], ['failed', false]);
    assert.match(never.why, /answers 404 without a sign-in/);
  } finally {
    s.cleanup();
  }
});

test('every other failure is {state:"failed", why} — never an exception, never the token in the reason', async () => {
  const s = scratch('vercel-fail');
  try {
    const b = bed(s);
    const cases = [
      [vercelStub({ create: 403 }), /did not make the project/],
      [vercelStub({ patch: 403 }), /protection could not be turned off/],
      [
        vercelStub({ deploy: 400, deployBody: { error: { message: `bad request for ${TOKEN}` } } }),
        /did not accept the deployment: bad request for \[token\]/,
      ],
      [vercelStub({ deployBody: { id: 'dpl_1', url: 'evil.example.com', readyState: 'READY' } }), /not a vercel\.app address/],
      [vercelStub({ final: 'ERROR' }), /the deployment ended ERROR/],
      [{
        fetchImpl: async () => {
          throw new Error(`socket hang up ${TOKEN}`);
        },
        seen: [],
      }, /did not make the project/],
    ];
    for (const [stub, why] of cases) {
      const r = await deploy(b, stub);
      assert.equal(r.state, 'failed');
      assert.equal(r.public, false);
      assert.match(r.why, why);
      assert.ok(!JSON.stringify(r).includes(TOKEN));
    }
    const slow = await deployPreview({ ...b.cfg, preview_wait_seconds: 0 }, { product: 'facts-page', files: b.files }, {
      fetchImpl: vercelStub().fetchImpl,
      sleep: async () => {},
    });
    assert.match(slow.why, /still QUEUED after 0s/);
    assert.match((await deploy({ ...b, files: [] }, vercelStub())).why, /no static file to deploy/);
    const noToken = await deploy({ cfg: { ...b.cfg, vercel_token_file: join(s.dir, 'absent') }, files: b.files }, vercelStub());
    assert.match(noToken.why, /no usable Vercel token/);
  } finally {
    s.cleanup();
  }
});

test('what is deployed: dist/ when there is one, else the root — never dotfiles, node_modules or links', () => {
  const s = scratch('vercel-files');
  try {
    const repo = join(s.dir, 'repo');
    mkdirSync(join(repo, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(repo, 'sub'));
    for (const f of ['index.html', '.env', 'sub/page.html', 'sub/.hidden', 'node_modules/x/index.js']) writeFileSync(join(repo, f), f);
    symlinkSync('/etc/hosts', join(repo, 'hosts-link'));
    const root = outputFiles(repo);
    assert.equal(root.root, '.');
    assert.deepEqual(root.files.map((f) => f.rel), ['index.html', 'sub/page.html']);
    mkdirSync(join(repo, 'dist'));
    writeFileSync(join(repo, 'dist', 'built.html'), 'x');
    const dist = outputFiles(repo);
    assert.equal(dist.root, 'dist');
    assert.deepEqual(dist.files.map((f) => f.rel), ['built.html']);
    assert.equal(dist.bytes, 1);
  } finally {
    s.cleanup();
  }
});
