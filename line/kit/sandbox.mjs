#!/usr/bin/env node
// sandbox.mjs — picks the wall the agent (and every command that runs code it wrote) is put behind,
// and builds the exact command line for it. kit/in-sandbox.sh scrubs the environment and then runs this.
//
//   macOS   sandbox-exec + kit/agent.sb: default deny; write the worktree only; network = two loopback ports.
//   Linux   bubblewrap, `bwrap --unshare-all`: a new, EMPTY network namespace (loopback only, never
//           --share-net); the worktree bound read-write; the tools, the kit and the repository behind the
//           worktree read-only; system directories read-only; everything else an empty read-only root.
//   Linux fallback   docker or podman with `--network none` and the same binds.
//
// The loopback question. In an empty network namespace the host's 127.0.0.1 does not exist, so the agent
// could not reach the bridge. The choice made here: the bridge also listens on two unix sockets in a small
// directory; that directory is bound read-only into the sandbox at /run/line; and the command is started by
// kit/sandbox-forward.mjs, which listens on 127.0.0.1:<bridge port> and :<proxy port> INSIDE the namespace and
// pipes each connection to the matching socket. The agent sees the same two loopback ports on every platform,
// the namespace still has no route to anything, and the only way out is the bridge's own two doors.
//
// With no wall at all sandboxAvailable() says {ok:false, why} and the line runs nothing that executes agent
// or product code.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIT = dirname(fileURLToPath(import.meta.url));
export const SOCK_MOUNT = '/run/line';
export const DEAD_PORT = '9'; // a port nothing listens on: as the tunnel's port it leaves the sandbox with no network at all
const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

const onPath = (bin) => (process.env.PATH ?? '/usr/bin:/bin').split(':').some((d) => d && existsSync(join(d, bin)));
const runs = (bin, args) => {
  const r = spawnSync(bin, args, { stdio: 'ignore', timeout: 20_000 });
  return r.status === 0;
};

/** Which wall this machine has. `force` (config or LINE_SANDBOX) names one, or 'none'. → {ok, kind, why} */
export function sandboxAvailable(
  { force = process.env.LINE_SANDBOX || null, platform = process.platform, has = onPath, works = runs } = {},
) {
  const no = (why) => ({ ok: false, kind: 'none', why: `${why} — replay only: nothing that executes agent or product code will run` });
  if (force === 'none') return no('the sandbox is switched off (sandbox: none)');
  if (platform === 'darwin') {
    if (force && force !== 'sandbox-exec') return no(`${force} is not a macOS sandbox`);
    return existsSync('/usr/bin/sandbox-exec') ? { ok: true, kind: 'sandbox-exec', why: null } : no('no /usr/bin/sandbox-exec on this Mac');
  }
  if (platform !== 'linux') return no(`no sandbox is implemented for ${platform}`);
  const tried = [];
  // bubblewrap must be present AND allowed to make namespaces here (some hosts switch unprivileged ones off)
  if (!force || force === 'bwrap') {
    if (!has('bwrap')) tried.push('bwrap is not installed');
    else if (works('bwrap', ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'])) return { ok: true, kind: 'bwrap', why: null };
    else tried.push('bwrap is installed but cannot create a namespace here');
  }
  for (const engine of ['docker', 'podman']) {
    if (force && force !== engine) continue;
    if (!has(engine)) tried.push(`${engine} is not installed`);
    else if (works(engine, ['info'])) return { ok: true, kind: engine, why: null };
    else tried.push(`${engine} is installed but not running`);
  }
  return no(`no sandbox on this machine (${tried.join('; ') || 'nothing to try'})`);
}

/** Does this wall need the bridge's unix sockets (it has no host loopback)? */
export const needsSockets = (kind) => kind !== 'sandbox-exec';

/**
 * The directory that holds this node: read-only and executable inside the wall, so the line also works where
 * node is not under /usr or /opt/homebrew. It is never the file system root or a directory holding the home.
 */
export function nodePrefix(execPath = process.execPath, home = homedir()) {
  const real = realpathSync(execPath);
  const bin = dirname(real);
  const prefix = dirname(bin);
  const holdsHome = (d) => d === '/' || home === d || home.startsWith(d.endsWith('/') ? d : d + '/');
  if (!holdsHome(prefix)) return prefix;
  if (!holdsHome(bin)) return bin;
  throw new Error(`node at ${real} sits directly in a directory that holds the home; refusing to open that to the sandbox`);
}

const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
const under = (p, dir) => p === dir || p.startsWith(dir + '/');

/**
 * PURE. The command line that runs `cmd` behind the wall. Paths are real paths.
 * → {bin, args, env}   (env is what the wall is started with; docker gets it as --env flags)
 */
export function wallCommand(
  {
    kind,
    wt,
    tools,
    gitdir,
    kit = KIT,
    prefix,
    bridgePort,
    proxyPort,
    sockDir = null,
    env = {},
    cmd,
    image = process.env.LINE_SANDBOX_IMAGE ?? 'node:22-bookworm',
    uid = process.getuid?.() ?? 1000,
    gid = process.getgid?.() ?? 1000,
  },
) {
  if (!Array.isArray(cmd) || !cmd.length) throw new Error('wall: no command');
  for (const [k, p] of Object.entries({ wt, tools, gitdir })) {
    if (!String(p ?? '').startsWith('/')) throw new Error(`wall: ${k} must be an absolute path`);
  }
  const gitLink = join(wt, '.git');
  if (kind === 'sandbox-exec') {
    const defs = {
      WT: wt,
      TOOLS: tools,
      GITDIR: gitdir,
      NODE_PREFIX: prefix,
      BRIDGE_PORT: String(bridgePort),
      PROXY_PORT: String(proxyPort),
    };
    const args = Object.entries(defs).flatMap(([k, v]) => ['-D', `${k}=${v}`]);
    return { bin: '/usr/bin/sandbox-exec', args: [...args, '-f', join(kit, 'agent.sb'), ...cmd], env };
  }
  if (!sockDir) throw new Error(`wall: ${kind} needs the bridge's socket directory`);
  const inner = ['node', join(kit, 'sandbox-forward.mjs'), SOCK_MOUNT, String(bridgePort), String(proxyPort), '--', ...cmd];
  if (kind === 'bwrap') {
    const ro = (p) => ['--ro-bind', p, p], roTry = (p) => ['--ro-bind-try', p, p];
    const args = [
      '--unshare-all',
      '--die-with-parent',
      '--new-session',
      ...ro('/usr'),
      ...['/bin', '/sbin', '/lib', '/lib64', '/lib32'].flatMap(roTry),
      ...['/etc/ssl', '/etc/pki', '/etc/ca-certificates', '/etc/alternatives', '/etc/ld.so.cache', '/etc/passwd', '/etc/group'].flatMap(
        roTry,
      ),
      '--proc',
      '/proc',
      '--dev',
      '/dev',
      ...(prefix && !under(prefix, '/usr') ? ro(prefix) : []),
      ...ro(tools),
      ...ro(kit),
      ...(under(gitdir, wt) ? [] : ro(gitdir)),
      '--bind',
      wt,
      wt,
      ...(isFile(gitLink) ? ro(gitLink) : []), // the worktree's link file: the agent may not repoint it
      '--ro-bind',
      sockDir,
      SOCK_MOUNT,
      '--remount-ro',
      '/', // the bare root is read-only: no /tmp, no home, nothing to write beside the worktree
      '--chdir',
      wt,
      '--',
      ...inner,
    ];
    return { bin: 'bwrap', args, env };
  }
  if (kind === 'docker' || kind === 'podman') {
    const vol = (p, mode = '') => ['-v', `${p}:${p}${mode}`];
    const inside = { ...env, PATH: `${tools}/node_modules/.bin:${SYSTEM_PATH}` }; // the image's own node, not the host's
    const args = [
      'run',
      '--rm',
      '--network',
      'none',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--user',
      `${uid}:${gid}`,
      ...vol(wt),
      ...(isFile(gitLink) ? vol(gitLink, ':ro') : []),
      ...(under(gitdir, wt) ? [] : vol(gitdir, ':ro')),
      ...vol(tools, ':ro'),
      ...vol(kit, ':ro'),
      '-v',
      `${sockDir}:${SOCK_MOUNT}:ro`,
      '-w',
      wt,
      ...Object.entries(inside).flatMap(([k, v]) => ['--env', `${k}=${v}`]),
      image,
      ...inner,
    ];
    return { bin: kind, args, env: { PATH: process.env.PATH ?? SYSTEM_PATH } };
  }
  throw new Error(`wall: no sandbox of kind '${kind}'`);
}

// ---- run: `node sandbox.mjs run <worktree> <bridge-port> <proxy-port> -- <command…>` (called by in-sandbox.sh) ----------------
async function main(argv) {
  if (argv[0] === 'kind') {
    const a = sandboxAvailable();
    console.log(a.ok ? a.kind : `none: ${a.why}`);
    return a.ok ? 0 : 3;
  }
  const sep = argv.indexOf('--');
  if (argv[0] !== 'run' || sep !== 4 || argv.length < 6) {
    console.error('usage: sandbox.mjs run <worktree> <bridge-port> <proxy-port> -- <command…>');
    return 2;
  }
  const [, wt, bridgePort, proxyPort] = argv;
  const cmd = argv.slice(sep + 1);
  const avail = sandboxAvailable();
  if (!avail.ok) {
    console.error(`sandbox: ${avail.why}`);
    return 3;
  }
  // What the wall needs to know arrives in LINE_WALL_* and is not passed on to the command.
  const { LINE_WALL_TOOLS: tools, LINE_WALL_GITDIR: gitdir, LINE_WALL_SOCK_DIR: sockDir, ...rest } = process.env;
  const env = Object.fromEntries(Object.entries(rest).filter(([k]) => !k.startsWith('LINE_')));
  let wall;
  try {
    wall = wallCommand({
      kind: avail.kind,
      wt,
      tools,
      gitdir,
      prefix: nodePrefix(),
      bridgePort,
      proxyPort,
      sockDir: sockDir || null,
      env,
      cmd,
    });
  } catch (e) {
    console.error(`sandbox: ${e.message}`);
    return 3;
  }
  const child = spawn(wall.bin, wall.args, { stdio: 'inherit', env: wall.env });
  const signals = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGALRM'];
  for (const s of signals) process.on(s, () => child.kill(s));
  return await new Promise((resolve) => {
    child.on('error', (e) => {
      console.error(`sandbox: could not start ${wall.bin} (${e.code ?? e.message})`);
      resolve(3);
    });
    child.on('exit', (code, signal) => {
      if (!signal) return resolve(code ?? 1);
      for (const s of signals) process.removeAllListeners(s); // end the way the command ended, so the caller sees the signal
      process.kill(process.pid, signal);
      setTimeout(() => resolve(1), 1000);
    });
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
