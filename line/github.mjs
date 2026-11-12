// github.mjs — everything the line does with git: read a remote, make a product's repository on first
// use, and the ONE write a run makes — a push of exactly <commit>:refs/heads/build/<ticket-id>.
//
// The push is never forced, never to main, and the refspec is built here from the ticket id; nothing a
// ticket or an agent says can change it. Each step ends with a read that shows what is now true.
// A token, where a remote needs one, reaches git only through kit/askpass.sh — never argv, a URL or a log.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { KIT } from './config.mjs';

const ASKPASS = join(KIT, 'askpass.sh');
const SCRUB = /(github_pat_|ghp_|gho_|ghs_|ghu_)[A-Za-z0-9_]{8,}/g;
const clean = (s) => String(s ?? '').replace(SCRUB, '$1…').replace(/\s+/g, ' ').trim().slice(0, 400);
const PRODUCT = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** A token file is usable: placed, mode 600, printable bytes only. → {ok, why} */
export function tokenState(file) {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { ok: false, why: `no token at ${file}` };
  }
  if ((st.mode & 0o777) !== 0o600) return { ok: false, why: `${file} is mode ${(st.mode & 0o777).toString(8)}, must be 600` };
  const body = readFileSync(file, 'utf8').replace(/\n$/, '');
  if (!body || /[^\x21-\x7e]/.test(body)) return { ok: false, why: `${file} is empty or holds non-printing bytes` };
  return { ok: true, why: null };
}

/** git with hooks off, no credential helper, no prompt, no user or system config. Never throws. */
export function git(args, { cwd, tokenFile = null, timeout = 120_000 } = {}) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: '/var/empty',
    LC_ALL: 'C',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    ...(tokenFile ? { GIT_ASKPASS: ASKPASS, LINE_TOKEN_FILE: tokenFile } : {}),
  };
  const fixed = [
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'credential.helper=',
    '-c',
    'core.fsmonitor=false',
    '-c',
    'protocol.file.allow=always',
  ];
  const r = spawnSync('git', [...fixed, ...args], { cwd, env, encoding: 'utf8', timeout, maxBuffer: 64e6 });
  return { code: r.status, out: (r.stdout ?? '').trim(), err: clean(r.stderr), signal: r.signal ?? null };
}

/** Where a product's repository is: cfg.product_remote(product), or the local bare repository under products_dir. */
export function productRemote(cfg, product) {
  if (!PRODUCT.test(String(product ?? ''))) throw new Error(`not a product id: ${JSON.stringify(product)}`);
  if (typeof cfg.product_remote === 'function') return { url: String(cfg.product_remote(product)), local: false };
  return { url: join(cfg.products_dir, `${product}.git`), local: true };
}

/** The default product repository, made on first use: a bare repository with one empty commit on main. → {url, created} */
export function ensureProductRepo(cfg, product) {
  const { url, local } = productRemote(cfg, product);
  if (!local || existsSync(join(url, 'HEAD'))) return { url, created: false };
  mkdirSync(dirname(url), { recursive: true });
  const init = git(['init', '-q', '--bare', '--initial-branch=main', url]);
  if (init.code !== 0) throw new Error(`could not create ${url}: ${init.err}`);
  const tree = git(['hash-object', '-t', 'tree', '-w', '--stdin'], { cwd: url }); // stdin is empty: the empty tree
  if (tree.code !== 0) throw new Error(`could not write the empty tree: ${tree.err}`);
  const who = ['-c', `user.name=${cfg.commit_name}`, '-c', `user.email=${cfg.commit_email}`];
  const commit = git([...who, 'commit-tree', tree.out, '-m', `first commit: ${product}`], { cwd: url });
  if (commit.code !== 0) throw new Error(`could not write the first commit: ${commit.err}`);
  const ref = git(['update-ref', 'refs/heads/main', commit.out], { cwd: url });
  if (ref.code !== 0) throw new Error(`could not set main: ${ref.err}`);
  return { url, created: true };
}

/** The sha a ref has AT THE REMOTE now, or null when the ref is absent; throws when the remote could not be read. */
export function remoteRef(url, ref, tokenFile = null) {
  const r = git(['ls-remote', url, ref], { tokenFile });
  if (r.code !== 0) throw new Error(`ls-remote ${ref}: ${r.err || 'exit ' + r.code}`);
  const line = r.out.split('\n').find((l) => l.endsWith(`\t${ref}`));
  return line ? line.split('\t')[0] : null;
}

export const BUILD_BRANCH = /^build\/[a-z0-9][a-z0-9-]{2,39}$/;

/**
 * THE PUSH GUARD. PURE: what the runner is about to ask for — a branch, a commit, a force flag, a refspec —
 * against the one shape the line may write: <commit>:refs/heads/build/<ticket-id>, never forced, never a
 * + refspec, never main. → {ok, ref, why}
 */
export function pushGuard({ branch, commit, force = false, refspec = null }) {
  const ref = `refs/heads/${String(branch ?? '')}`;
  if (force) return { ok: false, ref, why: `refusing a forced push to ${ref}: the line never forces (no --force, no --force-with-lease)` };
  if (refspec != null) {
    const r = String(refspec);
    const shown = r.slice(0, 80);
    if (/^\+/.test(r)) return { ok: false, ref, why: `refusing the refspec '${shown}': a + refspec is a forced push` };
    if (/(^|\s)(--force|-f|--force-with-lease)(\b|=)/.test(r)) {
      return { ok: false, ref, why: `refusing the refspec '${shown}': it carries a force option` };
    }
    const [src, dst] = r.split(':');
    if (src !== commit || dst !== ref) {
      return {
        ok: false,
        ref: dst ?? ref,
        why: `refusing the refspec '${shown}': the line writes exactly <commit>:refs/heads/build/<ticket-id>`,
      };
    }
  }
  if (!BUILD_BRANCH.test(String(branch ?? ''))) {
    return { ok: false, ref, why: `refusing to push '${String(branch).slice(0, 80)}': only build/<ticket-id> is ever written` };
  }
  if (!/^[0-9a-f]{40}$/.test(String(commit ?? ''))) return { ok: false, ref, why: 'refusing to push: not a commit sha' };
  return { ok: true, ref, why: null };
}

/**
 * Push <commit> to refs/heads/<branch>. The guard first; then a branch that already exists at the remote is
 * refused (a ticket id is used once); the git arguments are built from the guarded pieces only. After the push
 * the remote is read back. A refusal comes back {ok:false, why, refused:{ref, why}}.
 */
export function pushBranch({ repoDir, url, branch, commit, tokenFile = null, force = false, refspec = null }) {
  const g = pushGuard({ branch, commit, force, refspec });
  if (!g.ok) return { ok: false, why: g.why, refused: { ref: g.ref, why: g.why } };
  const ref = g.ref;
  let there;
  try {
    there = remoteRef(url, ref, tokenFile);
  } catch (e) {
    return { ok: false, why: String(e.message), refused: { ref, why: String(e.message) } };
  }
  if (there) {
    const why = `${branch} already exists at the remote (${there.slice(0, 10)})`;
    return { ok: false, why: `${why} — a ticket id is used once; nothing was pushed`, refused: { ref, why } };
  }
  const args = ['push', url, `${commit}:${ref}`];
  if (args.some((a, i) => i > 0 && /^[-+]/.test(a))) {
    return {
      ok: false,
      why: 'refusing to push: an argument looks like an option',
      refused: { ref, why: 'an argument looks like an option' },
    };
  }
  const p = git(args, { cwd: repoDir, tokenFile, timeout: 180_000 });
  if (p.code !== 0) {
    const why = p.err || 'exit ' + p.code;
    return { ok: false, why: `push refused: ${why}`, refused: { ref, why: `the remote refused the push: ${why}` } };
  }
  let now;
  try {
    now = remoteRef(url, ref, tokenFile);
  } catch (e) {
    return { ok: false, why: `pushed, but the remote could not be read back: ${e.message}` };
  }
  if (now !== commit) return { ok: false, why: `pushed, but the remote's ${branch} is ${now ?? 'absent'}, not ${commit.slice(0, 10)}` };
  return { ok: true, why: null, ref, remote_sha: now };
}
