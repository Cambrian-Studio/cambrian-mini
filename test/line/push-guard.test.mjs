// The one write the line makes: <commit>:refs/heads/build/<ticket-id>, never main, never forced, an id used once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProductRepo, git, pushBranch, pushGuard, remoteRef } from '../../line/github.mjs';
import { offlineConfig, refOf, scratch } from './helpers.mjs';

const SHA = 'a'.repeat(40);

test('the push guard: one shape is accepted, every other is refused', () => {
  const ok = pushGuard({ branch: 'build/facts-page-1', commit: SHA });
  assert.deepEqual(ok, { ok: true, ref: 'refs/heads/build/facts-page-1', why: null });
  assert.equal(pushGuard({ branch: 'build/facts-page-1', commit: SHA, refspec: `${SHA}:refs/heads/build/facts-page-1` }).ok, true);
  const table = [
    ['main', { branch: 'main', commit: SHA }, /only build\/<ticket-id>/],
    ['a forced push', { branch: 'build/facts-page-1', commit: SHA, force: true }, /never forces/],
    [
      'a + refspec',
      { branch: 'build/facts-page-1', commit: SHA, refspec: `+${SHA}:refs/heads/build/facts-page-1` },
      /\+ refspec is a forced push/,
    ],
    ['a refspec to main', { branch: 'build/facts-page-1', commit: SHA, refspec: `${SHA}:refs/heads/main` }, /writes exactly/],
    ['a refspec with a force option', {
      branch: 'build/facts-page-1',
      commit: SHA,
      refspec: `--force ${SHA}:refs/heads/build/facts-page-1`,
    }, /force option/],
    [
      'a refspec for another branch',
      { branch: 'build/facts-page-1', commit: SHA, refspec: `${SHA}:refs/heads/build/other-ticket` },
      /writes exactly/,
    ],
    ['a wrong branch', { branch: 'feature/x', commit: SHA }, /only build\/<ticket-id>/],
    ['a branch under build/ that is not a ticket id', { branch: 'build/../main', commit: SHA }, /only build\/<ticket-id>/],
    ['a branch that looks like an option', { branch: '--mirror', commit: SHA }, /only build\/<ticket-id>/],
    ['a commit that looks like an option', { branch: 'build/facts-page-1', commit: '--receive-pack=evil' }, /not a commit sha/],
    ['a tag-like ref', { branch: 'refs/tags/v1', commit: SHA }, /only build\/<ticket-id>/],
    ['no branch', { commit: SHA }, /only build\/<ticket-id>/],
  ];
  for (const [name, ask, why] of table) {
    const g = pushGuard(ask);
    assert.equal(g.ok, false, name);
    assert.match(g.why, why, name);
  }
});

test('a real push to a local bare repository: build/<id> lands, main is untouched, the id cannot be used twice', () => {
  const s = scratch('push');
  try {
    const cfg = offlineConfig(s.dir);
    const made = ensureProductRepo(cfg, 'facts-page');
    assert.equal(made.created, true);
    assert.equal(ensureProductRepo(cfg, 'facts-page').created, false, 'made once');
    const bare = made.url;
    const main = refOf(bare, 'refs/heads/main');
    assert.match(main, /^[0-9a-f]{40}$/, 'the new repository has one commit on main');
    // a clone with one new commit on top of main
    const clone = join(s.dir, 'clone');
    assert.equal(git(['clone', '-q', bare, clone]).code, 0);
    writeFileSync(join(clone, 'file.txt'), 'built\n');
    const who = ['-c', 'user.name=test', '-c', 'user.email=test@localhost'];
    assert.equal(git(['add', '-A'], { cwd: clone }).code, 0);
    assert.equal(git([...who, 'commit', '-q', '-m', 'work'], { cwd: clone }).code, 0);
    const commit = git(['rev-parse', 'HEAD'], { cwd: clone }).out;

    // refused asks reach the remote with nothing
    for (
      const ask of [{ branch: 'main' }, { branch: 'build/push-test-1', force: true }, {
        branch: 'build/push-test-1',
        refspec: `+${commit}:refs/heads/build/push-test-1`,
      }]
    ) {
      const r = pushBranch({ repoDir: clone, url: bare, commit, ...ask });
      assert.equal(r.ok, false);
      assert.ok(r.refused.why);
    }
    assert.equal(refOf(bare, 'refs/heads/build/push-test-1'), null, 'nothing was pushed by the refused asks');
    assert.equal(refOf(bare, 'refs/heads/main'), main);

    // the accepted ask
    const p = pushBranch({ repoDir: clone, url: bare, branch: 'build/push-test-1', commit });
    assert.deepEqual(p, { ok: true, why: null, ref: 'refs/heads/build/push-test-1', remote_sha: commit });
    assert.equal(refOf(bare, 'refs/heads/build/push-test-1'), commit, 'read back from the repository itself');
    assert.equal(remoteRef(bare, 'refs/heads/main'), main, 'main untouched');

    // the same id again, with a newer commit: refused, the branch stays where it was
    writeFileSync(join(clone, 'file.txt'), 'built twice\n');
    git(['add', '-A'], { cwd: clone });
    git([...who, 'commit', '-q', '-m', 'more'], { cwd: clone });
    const second = git(['rev-parse', 'HEAD'], { cwd: clone }).out;
    const again = pushBranch({ repoDir: clone, url: bare, branch: 'build/push-test-1', commit: second });
    assert.equal(again.ok, false);
    assert.match(again.why, /already exists at the remote.*a ticket id is used once/);
    assert.equal(refOf(bare, 'refs/heads/build/push-test-1'), commit);
    assert.equal(refOf(bare, 'refs/heads/main'), main);
  } finally {
    s.cleanup();
  }
});
