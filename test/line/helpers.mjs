// helpers.mjs — shared by the line's tests: scratch directories, a config that points everything at them,
// the fixture tickets, a signed release from the test council, and a few git reads.
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../../line/config.mjs';
import { parseTicket } from '../../tickets/ticket.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { sandboxAvailable } from '../../line/kit/sandbox.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
export const KIT = join(HERE, '..', '..', 'line', 'kit');

/** A scratch directory under the system temp directory with a telling name. Real path: the macOS sandbox matches those only. */
export function scratch(name) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `cambrian-line-test-${name}-`)));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
/** An offline config with every path inside `root`. */
export const offlineConfig = (root, over = {}) =>
  loadConfig({ offline: true, home: join(root, 'home'), records: join(root, 'records'), ...over });

/** A fixture ticket, optionally changed (and re-parsed, so it is in its validated form). */
export function fixtureTicket(name = 'facts-page-1', change = null) {
  const raw = JSON.parse(readFileSync(join(FIXTURES, 'tickets', `${name}.json`), 'utf8'));
  if (change) {
    change(raw);
    delete raw.branch;
  }
  return parseTicket(raw);
}
/** A fresh test council and the approvals of the named members for this ticket. */
export function release(ticket, members = ['clemens', 'jj']) {
  const { council, sign } = makeTestCouncil();
  return { council, sign, approvals: members.map((m) => sign(m, ticket)) };
}

const gitRead = (args, cwd) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: '/var/empty', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
/** The sha of a ref in a bare repository, or null. */
export const refOf = (bare, ref) => {
  const r = gitRead(['rev-parse', '--verify', '-q', ref], bare);
  return r.status === 0 ? r.stdout.trim() : null;
};

/** Tests that need the wall are skipped — with the reason — where no sandbox exists. Never reported as passed. */
export const wall = sandboxAvailable();
export const needsWall = wall.ok ? {} : { skip: `no sandbox on this machine: ${wall.why}` };
