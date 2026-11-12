// The wall: which one is picked, what its command line is, and what the probe proves from inside it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { needsSockets, nodePrefix, sandboxAvailable, SOCK_MOUNT, wallCommand } from '../../line/kit/sandbox.mjs';
import { inSandbox, wallEnv } from '../../line/checks.mjs';
import { startRun } from '../../line/dispatch.mjs';
import { fixtureTicket, KIT, needsWall, offlineConfig, release, scratch, wall } from './helpers.mjs';

const paths = {
  wt: '/work/run/wt',
  tools: '/line/tools',
  gitdir: '/work/run/repo/.git',
  kit: '/line/kit',
  prefix: '/opt/node',
  bridgePort: 4001,
  proxyPort: 4002,
};
const pairs = (args, flag) => args.flatMap((a, i) => (a === flag ? [args.slice(i + 1, i + 3).join(' ')] : []));

test('which wall: macOS → sandbox-exec; Linux → bubblewrap, else a container; nothing → {ok:false, why}', () => {
  const pick = (platform, bins, working = bins) =>
    sandboxAvailable({ force: null, platform, has: (b) => bins.includes(b), works: (b) => working.includes(b) });
  assert.equal(pick('linux', ['bwrap', 'docker']).kind, 'bwrap');
  assert.equal(pick('linux', ['bwrap', 'docker'], ['docker']).kind, 'docker', 'bubblewrap that cannot make a namespace is not used');
  assert.equal(pick('linux', ['podman']).kind, 'podman');
  const none = pick('linux', []);
  assert.deepEqual([none.ok, none.kind], [false, 'none']);
  assert.match(none.why, /bwrap is not installed.*replay only/);
  assert.equal(pick('win32', ['docker']).ok, false);
  assert.equal(sandboxAvailable({ force: 'none' }).ok, false);
  assert.equal(sandboxAvailable({ force: 'bwrap', platform: 'darwin' }).ok, false);
  assert.equal(needsSockets('sandbox-exec'), false);
  assert.equal(needsSockets('bwrap'), true);
  assert.equal(needsSockets('docker'), true);
});

test('the bubblewrap command line: no network at all, the worktree the only writable bind', () => {
  const w = wallCommand({ kind: 'bwrap', ...paths, sockDir: '/tmp/cl-x', env: { A: '1' }, cmd: ['/bin/sh', '-c', 'true'] });
  assert.equal(w.bin, 'bwrap');
  assert.ok(w.args.includes('--unshare-all'));
  assert.ok(!w.args.some((a) => /share-net/.test(a)), 'the network namespace is never shared');
  assert.deepEqual(pairs(w.args, '--bind'), ['/work/run/wt /work/run/wt'], 'exactly one read-write bind: the worktree');
  const ro = pairs(w.args, '--ro-bind');
  for (
    const p of [
      '/usr /usr',
      '/line/tools /line/tools',
      '/line/kit /line/kit',
      '/work/run/repo/.git /work/run/repo/.git',
      '/opt/node /opt/node',
      `/tmp/cl-x ${SOCK_MOUNT}`,
    ]
  ) assert.ok(ro.includes(p), p);
  assert.ok(w.args.indexOf('--remount-ro') > w.args.indexOf('--bind'), 'the bare root is made read-only after the binds');
  assert.ok(
    !w.args.includes('--tmpfs') && !ro.some((p) => p.startsWith('/home') || p.startsWith('/root') || p.startsWith('/ ')),
    'no home, no whole root, no writable tmpfs',
  );
  const inner = w.args.slice(w.args.indexOf('--') + 1);
  assert.deepEqual(inner, ['node', '/line/kit/sandbox-forward.mjs', SOCK_MOUNT, '4001', '4002', '--', '/bin/sh', '-c', 'true']);
  assert.throws(() => wallCommand({ kind: 'bwrap', ...paths, cmd: ['true'] }), /needs the bridge's socket directory/);
  assert.throws(() => wallCommand({ kind: 'bwrap', ...paths, sockDir: '/s', cmd: [] }), /no command/);
});

test('the container command line: --network none, read-only root, the same binds', () => {
  const w = wallCommand({
    kind: 'docker',
    ...paths,
    sockDir: '/tmp/cl-x',
    env: { HOME: '/work/run/wt/.oc/home' },
    cmd: ['npm', 'test'],
    image: 'node:22',
    uid: 501,
    gid: 20,
  });
  assert.equal(w.bin, 'docker');
  const at = (flag) => w.args[w.args.indexOf(flag) + 1];
  assert.equal(at('--network'), 'none');
  assert.ok(w.args.includes('--read-only'));
  assert.equal(at('--cap-drop'), 'ALL');
  assert.equal(at('--user'), '501:20');
  const vols = w.args.flatMap((a, i) => (a === '-v' ? [w.args[i + 1]] : []));
  assert.deepEqual(vols, [
    '/work/run/wt:/work/run/wt',
    '/work/run/repo/.git:/work/run/repo/.git:ro',
    '/line/tools:/line/tools:ro',
    '/line/kit:/line/kit:ro',
    `/tmp/cl-x:${SOCK_MOUNT}:ro`,
  ]);
  assert.ok(w.args.includes('HOME=/work/run/wt/.oc/home'));
  assert.throws(() => wallCommand({ kind: 'chroot', ...paths, sockDir: '/s', cmd: ['true'] }), /no sandbox of kind/);
});

test('the macOS command line passes real paths and the two ports to the profile', () => {
  const w = wallCommand({ kind: 'sandbox-exec', ...paths, cmd: ['/bin/sh', '-c', 'true'] });
  assert.equal(w.bin, '/usr/bin/sandbox-exec');
  for (
    const d of [
      'WT=/work/run/wt',
      'TOOLS=/line/tools',
      'GITDIR=/work/run/repo/.git',
      'NODE_PREFIX=/opt/node',
      'BRIDGE_PORT=4001',
      'PROXY_PORT=4002',
    ]
  ) assert.ok(w.args.includes(d), d);
  assert.equal(w.args[w.args.indexOf('-f') + 1], '/line/kit/agent.sb');
});

test('the node directory opened to the wall is never the root or a directory holding the home', () => {
  const real = nodePrefix();
  assert.ok(real !== '/' && !homedir().startsWith(real + '/') && real !== homedir());
  assert.equal(
    nodePrefix(process.execPath, join(real, 'lib', 'someone')),
    join(real, 'bin'),
    'a home under the prefix narrows it to the bin directory',
  );
  assert.throws(() => nodePrefix(process.execPath, join(real, 'bin', 'someone')), /refusing/);
});

test('with no sandbox the line refuses to run agent or product code: blocked, replay only', async () => {
  const s = scratch('no-sandbox');
  try {
    const cfg = offlineConfig(s.dir, { sandbox: 'none' });
    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket);
    const rec = await startRun(cfg, { ticket, approvals, council });
    assert.equal(rec.state, 'blocked');
    assert.match(rec.waiting_on, /replay only: nothing that executes agent or product code will run/);
    assert.equal(rec.attempts.length, 0);
    assert.equal(existsSync(join(cfg.scratch, ticket.id)), false);
    // the command wrapper itself also refuses, with exit 3, and a check run through it is never a pass
    const wt = join(s.dir, 'wt');
    mkdirSync(wt);
    spawnSync('git', ['init', '-q', wt]);
    const r = await inSandbox(wt, { bridgePort: 9, proxyPort: 9, tools: s.dir, sandbox: 'none' }, 'echo ran > proof.txt');
    assert.equal(r.launched, false);
    assert.equal(r.code, 3);
    assert.equal(existsSync(join(wt, 'proof.txt')), false, 'the command did not run');
  } finally {
    s.cleanup();
  }
});

/** A worktree-shaped scratch run with a bridge, ready for the probe. */
async function probeBed(s) {
  const run = join(s.dir, 'scratch', 'probe-run'), wt = join(run, 'wt'), tools = join(s.dir, 'tools');
  const records = join(s.dir, 'records'), work = join(s.dir, 'work'), secrets = join(s.dir, 'secrets'), home = join(s.dir, 'fake-home');
  for (const d of [join(run, 'repo'), tools, records, work, secrets, join(home, '.ssh')]) mkdirSync(d, { recursive: true });
  const g = (args, cwd) =>
    spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args], {
      cwd,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: '/var/empty' },
    });
  g(['init', '-q'], join(run, 'repo'));
  g(['commit', '-q', '--allow-empty', '-m', 'first'], join(run, 'repo'));
  assert.equal(g(['worktree', 'add', '-q', '-b', 'build/probe-run', wt], join(run, 'repo')).status, 0);
  writeFileSync(join(secrets, 'placeholder.key'), 'not-a-key\n', { mode: 0o600 });
  writeFileSync(join(home, '.ssh', 'id_placeholder'), 'not-a-key\n');
  for (const f of ['line-probe.sh', 'probe-net.mjs']) copyFileSync(join(KIT, f), join(tools, f));
  writeFileSync(join(s.dir, 'bridge-secret'), 'probe-secret', { mode: 0o600 });
  const free = async () => {
    const x = createServer();
    await new Promise((r) => x.listen(0, '127.0.0.1', r));
    const p = x.address().port;
    await new Promise((r) => x.close(r));
    return p;
  };
  const sockDir = needsSockets(wall.kind) ? scratch('sock').dir : null;
  const ports = { bridgePort: await free(), proxyPort: await free(), tools, sockDir };
  const bridge = spawn(process.execPath, [
    join(KIT, 'bridge.mjs'),
    '--secret-file',
    join(s.dir, 'bridge-secret'),
    '--trace',
    join(s.dir, 'trace.jsonl'),
    '--port',
    String(ports.bridgePort),
    '--proxy-port',
    String(ports.proxyPort),
    ...(sockDir ? ['--unix-dir', sockDir] : []),
  ], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((r) => bridge.stdout.once('data', r));
  const other = createServer((c) => c.destroy());
  await new Promise((r) => other.listen(0, '127.0.0.1', r));
  const online = await new Promise((r) => {
    const c = spawnSync(process.execPath, [join(KIT, 'probe-net.mjs'), 'tcp', 'registry.npmjs.org', '443']);
    r(c.status === 0);
  });
  const args = [
    String(ports.bridgePort),
    String(ports.proxyPort),
    run,
    records,
    work,
    home,
    secrets,
    String(other.address().port),
    online ? 'online' : 'offline',
  ];
  const stop = async () => {
    other.close();
    await new Promise((r) => {
      bridge.once('exit', r);
      bridge.kill();
    });
    if (sockDir) rmSync(sockDir, { recursive: true, force: true });
  };
  return { run, wt, tools, records, work, home, secrets, ports, args, online, stop };
}

test('the probe, inside the wall: every allowed thing works, every forbidden thing is refused', needsWall, async () => {
  const s = scratch('probe-inside');
  const bed = await probeBed(s);
  try {
    const r = await inSandbox(bed.wt, bed.ports, ['/bin/sh', join(bed.tools, 'line-probe.sh'), ...bed.args], { timeout: 120_000 });
    const lines = r.out.trim().split('\n');
    assert.equal(r.code, 0, r.out);
    assert.match(
      lines.at(-1),
      /^sandbox probe: (19 passed, 0 failed, 0|18 passed, 0 failed, 1|17 passed, 0 failed, 2) skipped$/,
    );
    const verdict = (name) => lines.find((l) => l.includes(name))?.slice(0, 4);
    assert.equal(verdict('write inside the worktree'), 'PASS');
    for (
      const refused of [
        'write a sibling of the worktree',
        'write /tmp',
        'write the user home directory',
        'write the repository behind the tree',
        'repoint the worktree link',
        'write the run records',
        'write the run artefacts',
        'read the secrets directory',
        'read ~/.ssh',
        'example.com through the tunnel',
        'github.com through the tunnel',
        'api.vercel.com through the tunnel',
        'example.com direct',
        'a public address direct',
        'another loopback port',
        'node fetch example.com',
      ]
    ) {
      const line = lines.find((l) => l.includes(refused));
      // where the wall leaves no ~/.ssh in view at all there is nothing to refuse: that arm prints SKIP with its reason
      if (refused === 'read ~/.ssh' && /^SKIP /.test(line)) continue;
      assert.match(line, /^PASS .* expect refused exit [1-9]/, refused);
    }
    assert.match(lines.find((l) => l.includes('bridge port (loopback)')), /^PASS .* expect ok +exit 0 +HTTP\/1\.1 404/);
    if (bed.online) {
      assert.match(lines.find((l) => l.includes('registry.npmjs.org through the tunnel')), /^PASS .* expect ok +exit 0 +HTTP\/1\.1 200/);
    } else {assert.match(
        lines.find((l) => l.includes('registry.npmjs.org through the tunnel')),
        /^SKIP .*the build machine itself is offline/,
      );}
    // nothing the probe tried to write outside exists
    for (
      const p of [
        join(bed.run, 'probe-outside'),
        join(bed.home, 'line-probe-outside'),
        join(bed.records, 'probe-outside'),
        join(bed.work, 'probe-outside'),
        join(bed.run, 'repo/.git/probe-outside'),
      ]
    ) {
      assert.equal(existsSync(p), false, p);
    }
    assert.equal(existsSync(join(bed.wt, '.oc/tmp/probe-inside')), true);
  } finally {
    await bed.stop();
    s.cleanup();
  }
});

test('the probe, with NO wall around it, fails: it really detects a hole', async () => {
  const s = scratch('probe-outside');
  const bed = await probeBed(s);
  try {
    const r = spawnSync('/bin/sh', [join(bed.tools, 'line-probe.sh'), ...bed.args], {
      cwd: bed.wt,
      encoding: 'utf8',
      timeout: 120_000,
      env: { PATH: `${process.execPath.replace(/\/[^/]+$/, '')}:${process.env.PATH}` },
    });
    assert.notEqual(r.status, 0, 'an unwalled probe must not pass');
    const failed = r.stdout.split('\n').filter((l) => l.startsWith('FAIL')).map((l) => l.slice(6, 50).trim());
    for (
      const hole of [
        'write a sibling of the worktree',
        'write the user home directory',
        'write the run records',
        'read the secrets directory',
        'read ~/.ssh',
        'another loopback port',
      ]
    ) {
      assert.ok(failed.includes(hole), `${hole} should be reported as a hole: ${failed.join(' | ')}`);
    }
  } finally {
    rmSync('/tmp/line-probe-outside', { force: true });
    await bed.stop();
    s.cleanup();
  }
});

test('Linux only: inside bubblewrap the bridge is reachable through the forwarder, and nothing else is', {
  skip: process.platform !== 'linux'
    ? 'bubblewrap exists on Linux only; this machine is ' + process.platform
    : wall.kind !== 'bwrap'
    ? `no working bubblewrap here (${wall.why ?? wall.kind})`
    : false,
}, async () => {
  const s = scratch('bwrap');
  const bed = await probeBed(s);
  try {
    const env = wallEnv(bed.ports);
    const run = (cmd) =>
      spawnSync(join(KIT, 'in-sandbox.sh'), [bed.wt, String(bed.ports.bridgePort), String(bed.ports.proxyPort), ...cmd], {
        encoding: 'utf8',
        env,
        timeout: 60_000,
      });
    const net = join(bed.tools, 'probe-net.mjs');
    assert.equal(run(['node', net, 'http', String(bed.ports.bridgePort)]).status, 0, 'the bridge answers on loopback inside the namespace');
    assert.notEqual(run(['node', net, 'tunnel', String(bed.ports.proxyPort), 'example.com:443']).status, 0);
    assert.notEqual(run(['node', net, 'tcp', '1.1.1.1', '443']).status, 0, 'no route out of the namespace');
    assert.notEqual(run(['/bin/sh', '-c', 'echo x > /tmp/outside']).status, 0, 'the root is read-only');
    assert.equal(run(['/bin/sh', '-c', 'echo x > inside.txt']).status, 0);
    assert.equal(existsSync(join(bed.wt, 'inside.txt')), true);
    assert.notEqual(run(['/bin/sh', '-c', 'echo x >> .git']).status, 0, 'the worktree link is read-only');
  } finally {
    await bed.stop();
    s.cleanup();
  }
});
