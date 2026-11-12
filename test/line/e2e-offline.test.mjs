// The whole line, offline: a stand-in agent instead of a model, everything else real — the release check, the
// sandbox and its probe, the commit, the checks on a fresh clone, the push guard, the record and the receipt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startRun } from '../../line/dispatch.mjs';
import { recheck } from '../../line/checks.mjs';
import { buildReceipt, receiptHash } from '../../receipts/receipt.mjs';
import { ticketHash } from '../../tickets/ticket.mjs';
import { fixtureTicket, needsWall, offlineConfig, refOf, release, scratch } from './helpers.mjs';

const onDisk = (cfg, id) => JSON.parse(readFileSync(join(cfg.records, id, 'run.json'), 'utf8'));
const bareOf = (cfg, product) => join(cfg.products_dir, `${product}.git`);

test(
  'a released ticket runs to GREEN: pushed to build/<id>, main untouched, output kept, receipt hashed, recheck agrees',
  needsWall,
  async () => {
    const s = scratch('e2e-green');
    try {
      const cfg = offlineConfig(s.dir);
      const ticket = fixtureTicket();
      const { council, approvals } = release(ticket);
      const updates = [];
      const fired = [{ lesson: 'L-001', what: 'keep the page free of other hosts' }];
      const rec = await startRun(cfg, {
        ticket,
        approvals,
        council,
        lessonsFired: fired,
        hooks: { onUpdate: (r) => updates.push(r.state + ':' + Object.keys(r.stations).join(',')) },
      });

      // the record: exactly the agreed shape, and what was returned is what is on disk
      assert.deepEqual(onDisk(cfg, ticket.id), rec);
      assert.deepEqual(Object.keys(rec).sort(), [
        'approvals',
        'attempts',
        'budget',
        'cost',
        'finished',
        'lessons',
        'main',
        'mode',
        'notifications',
        'origin',
        'preview',
        'push',
        'receipt_sha256',
        'release',
        'started',
        'state',
        'stations',
        'ticket',
        'ticket_sha256',
        'v',
        'waiting_on',
      ]);
      assert.deepEqual([rec.v, rec.origin, rec.mode, rec.state, rec.waiting_on], [1, 'baby', 'offline', 'green-no-preview', null]);
      assert.deepEqual(rec.ticket, {
        id: ticket.id,
        title: ticket.title,
        product: 'facts-page',
        branch: 'build/facts-page-1',
        budget: ticket.budget,
        checks: ticket.green.map((c) => c.id),
      });
      assert.equal(rec.ticket_sha256, ticketHash(ticket));
      assert.deepEqual(rec.approvals, approvals);
      assert.deepEqual(rec.release, { ok: true, valid: ['clemens', 'jj'], threshold: 2 });
      assert.deepEqual(rec.lessons, { fired, drafted: null });

      // the stations, in order, each with its time; the listener saw the run move through them
      assert.deepEqual(Object.keys(rec.stations), ['brief', 'approved', 'build', 'test', 'preview', 'receipt']);
      const times = [
        rec.stations.brief.at,
        rec.stations.approved.at,
        rec.stations.build.at,
        rec.stations.build.done,
        rec.stations.test.at,
        rec.stations.test.done,
        rec.stations.preview.at,
        rec.stations.receipt.at,
      ];
      assert.deepEqual([...times].sort(), times, 'station times only go forward');
      assert.equal(rec.stations.test.green, true);
      assert.equal(updates[0], 'running:brief');
      assert.equal(updates.at(-1), 'green-no-preview:brief,approved,build,test,preview,receipt');

      // one attempt, behind the wall, every check passed — the ticket's ten and the harness's own
      assert.equal(rec.attempts.length, 1);
      const a = rec.attempts[0];
      assert.match(a.walls, /^sandbox probe: \d+ passed, 0 failed, [012] skipped$/);   // skips: an offline machine; no ~/.ssh to refuse
      assert.ok(['sandbox-exec', 'bwrap', 'docker', 'podman'].includes(a.sandbox.kind));
      assert.deepEqual([a.agent.kind, a.agent.exit, a.green, a.failing.length], ['stand-in (offline)', 0, true, 0]);
      assert.deepEqual(a.checks.map((c) => c.id), [...ticket.green.map((c) => c.id), 'outside-untouched']);
      assert.ok(a.checks.every((c) => c.pass === true));
      assert.deepEqual(
        a.bridge,
        { forwarded: 0, refused: 1, computed_usd: 0, unpriced_calls: 0 },
        'the one refusal is the probe knocking on the bridge',
      );
      assert.deepEqual(a.calls, []);
      assert.deepEqual(rec.cost, { usd: 0, calls: 0, priced_from: 'NEAR AI /v1/models pricing × usage' });

      // the push: exactly build/<id> at the attempt's commit, read from the repository itself; main did not move
      const bare = bareOf(cfg, 'facts-page');
      assert.deepEqual(rec.push, { pushed: true, ref: 'refs/heads/build/facts-page-1', commit: a.commit, remote_sha: a.commit });
      assert.equal(refOf(bare, 'refs/heads/build/facts-page-1'), a.commit);
      assert.equal(refOf(bare, 'refs/heads/main'), rec.main.before);
      assert.deepEqual([rec.main.after, rec.main.untouched], [rec.main.before, true]);
      assert.deepEqual(refOf(bare, `${a.commit}^`), rec.main.before, 'the build commit sits directly on main');

      // offline: no preview is attempted, and the message says so
      assert.deepEqual(rec.preview, { state: 'skipped', why: 'offline', url: null, deployment_id: null, public: false });
      assert.deepEqual(rec.notifications.map((n) => n.kind), ['GREEN']);
      assert.match(rec.notifications[0].text, /built cleanly.*passed all checks on the first attempt/s);

      // the receipt: a pure projection of the record on disk — anyone can rebuild it and get the same hash
      assert.match(rec.receipt_sha256, /^[0-9a-f]{64}$/);
      assert.equal(receiptHash(buildReceipt(onDisk(cfg, ticket.id))), rec.receipt_sha256);
      assert.equal(rec.stations.receipt.sha256, rec.receipt_sha256);

      // the kept output: the built page and the files the checks read; recheck agrees with the run, and notices a change
      const out = join(cfg.records, ticket.id, 'output');
      assert.deepEqual(readdirSync(out).sort(), ['.gitignore', 'README.md', 'dist', 'vercel.json']);
      assert.deepEqual(readdirSync(join(out, 'dist')), ['index.html']);
      const again = recheck({ ticket, outputDir: out });
      assert.equal(again.ok, true);
      assert.deepEqual(again.failing, []);
      for (const c of again.checks) {
        if (c.kind === 'run') assert.deepEqual([c.skipped, c.pass], [true, undefined], 'a run check is skipped, never passed');
        else assert.equal(c.pass, a.checks.find((x) => x.id === c.id).pass, `${c.id} agrees with the run`);
      }
      writeFileSync(
        join(out, 'dist', 'index.html'),
        readFileSync(join(out, 'dist', 'index.html'), 'utf8').replace('Market: 50%', 'Market: 51%') +
          '<script src="https://example.com/x.js"></script>',
      );
      const tampered = recheck({ ticket, outputDir: out });
      assert.equal(tampered.ok, false);
      assert.deepEqual(tampered.failing, ['badges', 'no-hosts']);
      assert.equal(recheck({ ticket, outputDir: join(s.dir, 'nowhere') }).ok, false, 'no kept output is not a pass');
    } finally {
      s.cleanup();
    }
  },
);

test('an impossible ticket goes RED twice: nothing is pushed, main is untouched, the failure is handed to onRed', needsWall, async () => {
  const s = scratch('e2e-red');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket('facts-page-impossible-1');
    const { council, approvals } = release(ticket, ['clemens', 'michael']);
    let handed = null;
    const onRed = (rec, failureLog) => {
      handed = { state: rec.state, failureLog };
      return { id: 'L-draft-1', rule: 'A ticket must not ask for two counts of the same thing.' };
    };
    const rec = await startRun(cfg, { ticket, approvals, council, hooks: { onRed } });
    assert.equal(rec.state, 'red');
    assert.match(
      rec.waiting_on,
      /^RED twice — the same failure both times: impossible\. Nothing was pushed \(build\/facts-page-impossible-1 is absent .*read\)\.$/,
    );
    assert.equal(rec.attempts.length, 2);
    for (const a of rec.attempts) {
      assert.equal(a.green, false);
      assert.deepEqual(a.failing, ['impossible']);
      assert.match(a.checks.find((c) => c.id === 'impossible').detail, /occurs \d time\(s\), wanted 6/);
    }
    assert.ok(
      rec.attempts[0].checks.filter((c) => c.id !== 'impossible').every((c) => c.pass),
      'every other check passed: only the impossible one is red',
    );
    // nothing left the machine
    const bare = bareOf(cfg, 'facts-page');
    assert.deepEqual(rec.push, { pushed: false });
    assert.equal(refOf(bare, 'refs/heads/build/facts-page-impossible-1'), null);
    assert.equal(refOf(bare, 'refs/heads/main'), rec.main.before);
    assert.equal(rec.main.untouched, true);
    assert.equal(rec.preview, null);
    assert.equal(existsSync(join(cfg.records, ticket.id, 'output')), false);
    // the failure went to the hook, and its draft is on the record
    assert.equal(handed.state, 'red');
    assert.match(handed.failureLog, /FAIL impossible \(file\).*wanted 6/);
    assert.deepEqual(rec.lessons.drafted, {
      id: 'L-draft-1',
      rule: 'A ticket must not ask for two counts of the same thing.',
      from_run: ticket.id,
    });
    assert.deepEqual(rec.notifications.map((n) => n.kind), ['RED']);
    assert.match(rec.notifications[0].text, /did not build.*failed twice, the same way.*Nothing was pushed/s);
    assert.equal(receiptHash(buildReceipt(onDisk(cfg, ticket.id))), rec.receipt_sha256, 'a red run has a receipt too');
  } finally {
    s.cleanup();
  }
});

test('RED then GREEN: the second attempt gets the findings; an escape attempt by the agent is refused by the wall', needsWall, async () => {
  const s = scratch('e2e-retry');
  try {
    const cfg = offlineConfig(s.dir);
    const ticket = fixtureTicket('facts-page-1', (t) => {
      t.id = 'facts-retry-1';
      t.task += '\n\nSTUB:late-readme STUB:escape';
    });
    const { council, approvals } = release(ticket);
    const rec = await startRun(cfg, { ticket, approvals, council });
    assert.equal(rec.state, 'green-no-preview');
    assert.equal(rec.attempts.length, 2);
    assert.deepEqual(rec.attempts[0].failing, ['readme']);
    assert.equal(rec.attempts[1].green, true);
    assert.match(
      readFileSync(join(cfg.home, 'runs-work', ticket.id, 'a2', 'prompt.txt'), 'utf8'),
      /Your previous attempt failed some checks/,
    );
    assert.equal(rec.push.commit, rec.attempts[1].commit);
    assert.notEqual(rec.attempts[0].commit, rec.attempts[1].commit);
    assert.match(rec.notifications[0].text, /passed all checks on attempt 2/);
    // the stand-in tried to write beside its worktree both times: refused, nothing there, and the harness's own check stayed green
    for (const n of [1, 2]) {
      assert.match(readFileSync(join(cfg.home, 'runs-work', ticket.id, `a${n}`, 'agent-stub.out'), 'utf8'), /escape refused/);
    }
    assert.equal(existsSync(join(cfg.scratch, ticket.id, 'escaped')), false);
    assert.ok(rec.attempts.every((a) => a.checks.find((c) => c.id === 'outside-untouched').pass));
  } finally {
    s.cleanup();
  }
});

test('a GREEN run that asks to push main, or to force, ends RED with the refused ref on the record', needsWall, async () => {
  const s = scratch('e2e-push-refused');
  try {
    const asks = { 'facts-push-main': { branch: 'main' }, 'facts-push-force': { force: true } };
    const cfg = offlineConfig(s.dir, { push_override: asks });
    for (
      const [id, why] of [['facts-push-main', /only build\/<ticket-id> is ever written/], ['facts-push-force', /the line never forces/]]
    ) {
      const ticket = fixtureTicket('facts-page-1', (t) => {
        t.id = id;
      });
      const { council, approvals } = release(ticket);
      const rec = await startRun(cfg, { ticket, approvals, council });
      assert.equal(rec.attempts[0].green, true, 'the build was green');
      assert.equal(rec.state, 'red');
      assert.match(rec.waiting_on, /^RED — the push was refused/);
      assert.match(rec.push.refused.why, why);
      assert.equal(rec.push.pushed, false);
      assert.equal(rec.main.untouched, true);
      const bare = bareOf(cfg, 'facts-page');
      assert.equal(refOf(bare, 'refs/heads/main'), rec.main.before);
      assert.equal(refOf(bare, `refs/heads/build/${id}`), null);
      assert.match(rec.notifications.at(-1).text, /passed its checks, but the push was refused/);
    }
  } finally {
    s.cleanup();
  }
});
