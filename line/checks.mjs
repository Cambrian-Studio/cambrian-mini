// checks.mjs — GREEN, as the ticket wrote it. The ticket's `green` is a list of JSON checks
// (tickets/ticket.mjs validates the shape); runChecks runs them in order on a FRESH CLONE of the commit the
// harness made, and every command of the agent's code runs behind the wall (kit/in-sandbox.sh) — never in
// this process. A check that could not observe its condition is {pass:false, unverified:true}: never a pass.
// The harness adds one check of its own that no ticket can drop: nothing beside the worktree changed while
// the agent ran (a manifest before and after).
//
// recheck() re-runs the `file` and `no_external_hosts` checks later, offline, against the copy of the built
// output kept with the run record. It is pure file reading: no sandbox, no network, nothing executed.
import { spawn } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { KIT } from './config.mjs';
import { DEAD_PORT } from './kit/sandbox.mjs';

export { DEAD_PORT };
const tail = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(-n);

/** Everything under root except the excluded paths → {path: "size:mtime:mode"}. */
export function manifest(root, exclude = []) {
  const ex = exclude.map((p) => resolve(p));
  const out = {};
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      if (ex.some((x) => p === x || p.startsWith(x + '/'))) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out[p] = `${st.size}:${Math.floor(st.mtimeMs)}:${st.mode.toString(8)}`;
    }
  };
  walk(resolve(root));
  return out;
}

export function manifestCheck(before, after, root) {
  const base = { id: 'outside-untouched', name: 'no file outside the worktree touched', kind: 'harness' };
  if (!before || !after) return { ...base, pass: false, unverified: true, detail: 'UNVERIFIED: a manifest is missing' };
  if (!Object.keys(before).length) {
    return { ...base, pass: false, unverified: true, detail: 'UNVERIFIED: the before-manifest is empty, so there was nothing to compare' };
  }
  const added = Object.keys(after).filter((p) => !(p in before)), gone = Object.keys(before).filter((p) => !(p in after));
  const changed = Object.keys(after).filter((p) => p in before && after[p] !== before[p]);
  const n = added.length + gone.length + changed.length;
  const detail = n === 0
    ? `${Object.keys(after).length} files beside the worktree are unchanged since before the agent started (size, mtime, mode)`
    : `${added.length} added, ${gone.length} removed, ${changed.length} changed: ${
      [...added, ...gone, ...changed].slice(0, 5).map((p) => p.slice(root.length + 1)).join(', ')
    }`;
  return { ...base, pass: n === 0, detail };
}

/** One process, without blocking this one. Never throws. → {status, signal, stdout, stderr, error, timedOut} */
export function runProcess(bin, args, { env, cwd, timeout = 0, killSignal = 'SIGTERM', maxBuffer = 32e6 } = {}) {
  return new Promise((done) => {
    let child;
    const out = { stdout: '', stderr: '' };
    let timedOut = false, timer = null;
    try {
      child = spawn(bin, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      return done({ status: null, signal: null, ...out, error, timedOut });
    }
    for (const k of ['stdout', 'stderr']) {
      child[k].on('data', (d) => {
        if (out[k].length < maxBuffer) out[k] += d;
      });
    }
    if (timeout) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill(killSignal);
        setTimeout(() => child.kill('SIGKILL'), 5000).unref();
      }, timeout);
    }
    child.on('error', (error) => {
      clearTimeout(timer);
      done({ status: null, signal: null, ...out, error, timedOut });
    });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      done({ status, signal: signal ?? null, ...out, error: null, timedOut });
    });
  });
}

/** The environment in-sandbox.sh is started with. ports: {bridgePort, proxyPort, tools, sockDir?, sandbox?} */
export const wallEnv = (ports, extra = {}) => ({
  PATH: process.env.PATH ?? '/usr/bin:/bin',
  LINE_TOOLS: ports.tools,
  LINE_NODE: process.execPath,
  ...(ports.sockDir ? { LINE_SOCK_DIR: ports.sockDir } : {}),
  ...(ports.sandbox ? { LINE_SANDBOX: ports.sandbox } : {}),
  ...extra,
});

/**
 * One command behind the wall, in dir. proxyPort DEAD_PORT = no network; the tunnel's port = registry.npmjs.org only.
 * cmd is a shell command line, or an argv array. → {code, signal, out, launched}
 */
export async function inSandbox(dir, ports, cmd, { timeout = 300_000 } = {}) {
  const argv = [dir, String(ports.bridgePort), String(ports.proxyPort), ...(Array.isArray(cmd) ? cmd : ['/bin/sh', '-e', '-c', cmd])];
  const r = await runProcess(join(KIT, 'in-sandbox.sh'), argv, { timeout, env: wallEnv(ports) });
  // exit 3 is the wall saying it could not be put up: the command did not run
  return { code: r.status, signal: r.signal, out: r.stdout + r.stderr, launched: r.error == null && r.status !== 3 };
}

/** rel inside root, following symbolic links: does it exist, and does it resolve to somewhere outside root? */
function inside(root, rel) {
  const p = join(root, rel);
  let link = false;
  try {
    link = lstatSync(p).isSymbolicLink();
  } catch { /* absent */ }
  if (!existsSync(p)) return { p, exists: link, escapes: link }; // a dangling link is treated as an escape, not as "absent"
  const real = realpathSync(p), base = realpathSync(root);
  return { p, exists: true, escapes: !(real === base || real.startsWith(base + '/')) };
}

function fileCheck(c, root, base) {
  const f = inside(root, c.path);
  if (f.exists && f.escapes) return { ...base, pass: false, detail: `${c.path} resolves outside the clone` };
  if (!c.exists) {
    return { ...base, pass: !f.exists, detail: f.exists ? `${c.path} exists, wanted absent` : `${c.path} is absent, as wanted` };
  }
  if (!f.exists) return { ...base, pass: false, detail: `${c.path} does not exist` };
  if (!lstatSync(realpathSync(f.p)).isFile()) return { ...base, pass: false, detail: `${c.path} is not a file` };
  const text = readFileSync(f.p, 'utf8');
  const problems = [];
  for (const s of c.contains ?? []) if (!text.includes(s)) problems.push(`does not contain ${JSON.stringify(s.slice(0, 60))}`);
  for (const re of c.matches ?? []) if (!new RegExp(re, 'm').test(text)) problems.push(`does not match /${re}/`);
  for (const re of c.not_matches ?? []) if (new RegExp(re, 'm').test(text)) problems.push(`matches /${re}/`);
  if (c.count) {
    const n = (text.match(new RegExp(c.count.pattern, 'gm')) ?? []).length;
    if (n !== c.count.equals) problems.push(`/${c.count.pattern}/ occurs ${n} time(s), wanted ${c.count.equals}`);
  }
  const detail = problems.length ? `${c.path}: ${problems.join('; ')}` : `${c.path} (${text.length} characters) meets every condition`;
  return { ...base, pass: !problems.length, detail };
}

/** no_external_hosts: nothing under dir names another host. */
function hostsCheck(c, root, base) {
  const d = inside(root, c.dir);
  if (!d.exists) return { ...base, pass: false, detail: `${c.dir}/ does not exist — nothing was built there` };
  if (d.escapes) return { ...base, pass: false, detail: `${c.dir} resolves outside the clone` };
  const hits = [];
  let files = 0;
  const walk = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        files++;
        const m = readFileSync(p, 'latin1').match(/https?:\/\/[^\s"'<>)]*|(?:src|href)\s*=\s*["']?\/\/[^\s"'<>]*/gi);
        if (m) hits.push(`${p.slice(root.length + 1)}: ${m.slice(0, 3).join(', ')}`);
      }
    }
  };
  walk(d.p);
  if (!files) return { ...base, pass: false, detail: `${c.dir}/ holds no file` };
  const detail = hits.length
    ? `external references: ${hits.slice(0, 4).join(' | ')}`
    : `${files} file(s) under ${c.dir}/ name no other host`;
  return { ...base, pass: !hits.length, detail };
}

async function runCheck(c, clone, ports, base) {
  const r = await inSandbox(clone, { ...ports, proxyPort: c.network === 'registry' ? ports.proxyPort : DEAD_PORT }, c.run, {
    timeout: c.timeout_s * 1000,
  });
  if (!r.launched || (r.code === null && !r.signal)) {
    return { ...base, pass: false, unverified: true, detail: 'UNVERIFIED: the sandbox did not start the command' };
  }
  if (r.signal) return { ...base, pass: false, detail: `stopped by ${r.signal} after ${c.timeout_s}s: ${tail(r.out, 200)}` };
  const problems = [];
  if (r.code !== c.exit) problems.push(`exit ${r.code}, wanted ${c.exit}`);
  if (c.stdout_matches && !new RegExp(c.stdout_matches, 'm').test(r.out)) problems.push(`output does not match /${c.stdout_matches}/`);
  if (c.stdout_not_matches && new RegExp(c.stdout_not_matches, 'm').test(r.out)) problems.push(`output matches /${c.stdout_not_matches}/`);
  const net = c.network === 'registry' ? ' (registry.npmjs.org reachable)' : ' with no network';
  const detail = problems.length
    ? `${problems.join('; ')}: ${tail(r.out)}`
    : `exit ${r.code}${net}${c.stdout_matches ? `; output matches /${c.stdout_matches}/` : ''}`;
  return { ...base, pass: !problems.length, detail, exit: r.code };
}

async function runOne(c, clone, ports) {
  const base = { id: c.id, name: c.name, kind: c.kind };
  if (c.kind === 'run') return runCheck(c, clone, ports, base);
  if (c.kind === 'file') return fileCheck(c, realpathSync(clone), base);
  return hostsCheck(c, realpathSync(clone), base);
}

/**
 * The ticket's checks on a fresh clone of <branch> from <repoDir>, in order, then the harness's own.
 * → {green, commit, checks, failing}
 */
export async function runChecks({ ticket, repoDir, workDir, ports, git, manifestBefore, manifestAfter, manifestRoot }) {
  const clone = join(workDir, 'clone');
  let head = null;
  const checks = [];
  const c = git(['clone', '-q', '--branch', ticket.branch, repoDir, clone]);
  if (c.code === 0) {
    const h = git(['rev-parse', 'HEAD'], { cwd: clone });
    if (h.code === 0) head = h.out;
  }
  for (const chk of ticket.green) {
    const base = { id: chk.id, name: chk.name, kind: chk.kind };
    if (!head) {
      checks.push({
        ...base,
        pass: false,
        unverified: true,
        detail: `UNVERIFIED: the branch ${ticket.branch} could not be cloned (${c.err || 'no HEAD'})`,
      });
      continue;
    }
    try {
      checks.push(await runOne(chk, clone, ports));
    } catch (e) {
      checks.push({
        ...base,
        pass: false,
        unverified: true,
        detail: `UNVERIFIED: the check could not run (${String(e.message).slice(0, 160)})`,
      });
    }
  }
  checks.push(manifestCheck(manifestBefore, manifestAfter, manifestRoot));
  const failing = checks.filter((x) => !x.pass).map((x) => x.id);
  return {
    green: checks.length === ticket.green.length + 1 && failing.length === 0,
    commit: head,
    checks,
    failing,
    checked_at: new Date().toISOString(),
  };
}

/**
 * Re-run the ticket's `file` and `no_external_hosts` checks against a kept copy of the built output
 * (<records>/<id>/output). `run` checks execute code, so they are reported {skipped:true}, never as passed.
 * → {ok, checks, failing}   ok = every check that could be re-run passes
 */
export function recheck({ ticket, outputDir }) {
  const checks = [];
  let root = null;
  try {
    root = realpathSync(outputDir);
  } catch { /* no kept output */ }
  for (const c of ticket.green) {
    const base = { id: c.id, name: c.name, kind: c.kind };
    if (c.kind === 'run') {
      checks.push({ ...base, skipped: true, detail: 'a run check executes code; it is not re-run here' });
      continue;
    }
    if (!root) {
      checks.push({ ...base, pass: false, unverified: true, detail: `UNVERIFIED: no kept output at ${outputDir}` });
      continue;
    }
    try {
      checks.push(c.kind === 'file' ? fileCheck(c, root, base) : hostsCheck(c, root, base));
    } catch (e) {
      checks.push({
        ...base,
        pass: false,
        unverified: true,
        detail: `UNVERIFIED: the check could not run (${String(e.message).slice(0, 160)})`,
      });
    }
  }
  const failing = checks.filter((x) => !x.skipped && !x.pass).map((x) => x.id);
  return { ok: failing.length === 0 && checks.some((x) => !x.skipped), checks, failing };
}
