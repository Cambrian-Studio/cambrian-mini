// Nothing is built until two of the three council members have signed THIS ticket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimRun, startRun } from '../../line/dispatch.mjs';
import { runTicket } from '../../line/run.mjs';
import { fixtureTicket, needsWall, offlineConfig, refOf, release, scratch } from './helpers.mjs';

/** A refused run ran nothing: no attempt, no worktree, no repository made, nothing pushed, and a WAITING notice says why. */
function assertNothingRan(cfg, rec, why) {
  assert.equal(rec.state, 'refused');
  assert.match(rec.waiting_on, why);
  assert.equal(rec.release.ok, false);
  assert.equal(rec.attempts.length, 0);
  assert.deepEqual(rec.push, { pushed: false });
  assert.equal(existsSync(join(cfg.scratch, rec.ticket.id)), false, 'no clone, no worktree');
  assert.equal(existsSync(join(cfg.products_dir, `${rec.ticket.product}.git`)), false, 'the product repository was not even made');
  assert.equal(rec.stations.approved, undefined);
  assert.equal(rec.stations.build, undefined);
  const note = rec.notifications.at(-1);
  assert.equal(note.kind, 'WAITING');
  assert.match(note.text, /was not started: the council has not released it/);
  assert.deepEqual(
    JSON.parse(readFileSync(join(cfg.records, rec.ticket.id, 'run.json'), 'utf8')),
    rec,
    'the record on disk is the record returned',
  );
}

test('no approvals: refused, nothing runs, nothing is pushed', async () => {
  const s = scratch('release-0');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const { council } = release(ticket, []);
    const rec = await startRun(cfg, { ticket, approvals: [], council });
    assertNothingRan(cfg, rec, /0 of 3 valid approvals; 2 are required/);
  } finally {
    s.cleanup();
  }
});

test('one of three: refused', async () => {
  const s = scratch('release-1');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket, ['michael']);
    const rec = await startRun(cfg, { ticket, approvals, council });
    assertNothingRan(cfg, rec, /1 of 3 valid approvals/);
    assert.deepEqual(rec.release.valid, ['michael']);
  } finally {
    s.cleanup();
  }
});

test('the same member twice is still one approval: refused', async () => {
  const s = scratch('release-dup');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const { council, sign } = release(ticket, []);
    const rec = await startRun(cfg, { ticket, approvals: [sign('jj', ticket), sign('jj', ticket)], council });
    assertNothingRan(cfg, rec, /1 of 3 valid approvals/);
  } finally {
    s.cleanup();
  }
});

test('a ticket altered by one byte after two members signed it: refused', async () => {
  const s = scratch('release-altered');
  try {
    const cfg = offlineConfig(s.dir);
    const signedTicket = fixtureTicket();
    const { council, approvals } = release(signedTicket, ['clemens', 'jj']);
    const altered = { ...signedTicket, task: signedTicket.task.replace('five facts', 'five fActs') };
    assert.equal(altered.task.length, signedTicket.task.length);
    assert.notEqual(altered.task, signedTicket.task);
    const rec = await startRun(cfg, { ticket: altered, approvals, council });
    assertNothingRan(cfg, rec, /0 of 3 valid approvals.*signed a different ticket body/);
  } finally {
    s.cleanup();
  }
});

test('signatures from a different council do not release the ticket', async () => {
  const s = scratch('release-foreign');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const theirs = release(ticket, ['clemens', 'jj', 'michael']);
    const ours = release(ticket, []);
    const rec = await startRun(cfg, { ticket, approvals: theirs.approvals, council: ours.council });
    assertNothingRan(cfg, rec, /0 of 3 valid approvals/);
  } finally {
    s.cleanup();
  }
});

test('a ticket that is not in its validated form is refused before the signatures are even read', async () => {
  const s = scratch('release-shape');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = { ...fixtureTicket(), repo: 'someone/else' };
    const { council, approvals } = release(ticket);
    const rec = await startRun(cfg, { ticket, approvals, council });
    assert.equal(rec.state, 'refused');
    assert.match(rec.waiting_on, /unknown key 'repo'/);
    assert.equal(rec.attempts.length, 0);
  } finally {
    s.cleanup();
  }
});

test('two of three: the run proceeds — and a ticket id runs once', needsWall, async () => {
  const s = scratch('release-2');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket, ['jj', 'michael']);
    const rec = await startRun(cfg, { ticket, approvals, council });
    assert.equal(rec.state, 'green-no-preview', rec.waiting_on ?? '');
    assert.equal(rec.release.ok, true);
    assert.deepEqual(rec.release.valid, ['jj', 'michael']);
    assert.equal(rec.release.threshold, 2);
    assert.ok(rec.stations.approved.at);
    assert.equal(rec.push.pushed, true);
    await assert.rejects(startRun(cfg, { ticket, approvals, council }), /a ticket id runs once/);
    assert.equal(claimRun(cfg, ticket.id).ok, false);
  } finally {
    s.cleanup();
  }
});

test('the release is checked again right before the push: withdrawn mid-run → refused, nothing pushed', needsWall, async () => {
  const s = scratch('release-withdrawn');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket);
    // once the checks are green, one signer's passkey is removed from the council the line was handed
    const onUpdate = (rec) => {
      if (rec.stations.test?.green) council.members.find((m) => m.id === 'jj').credentials = [];
    };
    const rec = await runTicket(cfg, { ticket, approvals, council }, { onUpdate });
    assert.equal(rec.attempts.length, 1);
    assert.equal(rec.attempts[0].green, true, 'the build itself was green');
    assert.equal(rec.state, 'refused');
    assert.match(rec.waiting_on, /no longer holds right before the push/);
    assert.deepEqual(rec.push, { pushed: false });
    const bare = join(cfg.products_dir, 'facts-page.git');
    assert.equal(refOf(bare, `refs/heads/${ticket.branch}`), null, 'the branch is absent in the repository');
    assert.equal(refOf(bare, 'refs/heads/main'), rec.main.before);
    assert.equal(rec.main.untouched, true);
  } finally {
    s.cleanup();
  }
});
