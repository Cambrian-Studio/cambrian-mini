// The daily ceiling: a run that would carry the day past it does not start.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alertDue, alertText, ceilingDecision, readSpentToday, runsToday, spentOf, utcDay } from '../../line/budget.mjs';
import { loadConfig } from '../../line/config.mjs';
import { claimRun, startRun } from '../../line/dispatch.mjs';
import { fixtureTicket, offlineConfig, release, scratch } from './helpers.mjs';

test('ceilingDecision: under the ceiling starts, over it does not, an unread meter does not', () => {
  const day = '2026-11-12';
  assert.equal(
    ceilingDecision({ spent_usd: 1, committed_usd: 1, ticket_usd: 3, ceiling_usd: 5, day }).ok,
    true,
    'exactly the ceiling is allowed',
  );
  const over = ceilingDecision({ spent_usd: 1, committed_usd: 1, ticket_usd: 3.01, ceiling_usd: 5, day });
  assert.equal(over.ok, false);
  assert.match(over.why, /would carry today's spend past the line's \$5\.00/);
  assert.match(over.detail, /= \$5\.01 of the \$5\.00/);
  const unread = ceilingDecision({ spent_usd: NaN, ticket_usd: 0.1, ceiling_usd: 5, day });
  assert.equal(unread.ok, false);
  assert.match(unread.why, /could not be read/);
});

test('the half-ceiling alert is due once per UTC day', () => {
  const day = '2026-11-12';
  assert.equal(alertDue({ spent_usd: 2.49, ceiling_usd: 5, day, state: {} }), false);
  assert.equal(alertDue({ spent_usd: 2.5, ceiling_usd: 5, day, state: {} }), true);
  assert.equal(alertDue({ spent_usd: 4, ceiling_usd: 5, day, state: { alerted_day: day } }), false);
  assert.equal(alertDue({ spent_usd: 4, ceiling_usd: 5, day, state: { alerted_day: '2026-11-11' } }), true);
  assert.equal(alertText({ spent_usd: 2.5, ceiling_usd: 5, runs_today: 1 }), '$2.50 of $5.00 today, 1 run');
});

test("today's spend is the sum of per-call dollars in today's run records", () => {
  const s = scratch('budget-records');
  try {
    const cfg = loadConfig({ home: join(s.dir, 'home'), records: join(s.dir, 'records') });
    const put = (id, rec) => {
      mkdirSync(join(cfg.records, id), { recursive: true });
      writeFileSync(join(cfg.records, id, 'run.json'), JSON.stringify(rec));
    };
    const today = new Date().toISOString();
    put('today-one', {
      origin: 'mini',
      started: today,
      state: 'green-preview',
      ticket: { budget: { usd: 1 } },
      attempts: [{ calls: [{ usd: 0.25 }, { usd: 0.5 }, { usd: null }], bridge: { computed_usd: 99 } }, { calls: [{ usd: 0.05 }] }],
    });
    put('today-running', {
      origin: 'mini',
      started: today,
      state: 'running',
      ticket: { budget: { usd: 1.5 } },
      attempts: [{ calls: [], bridge: { computed_usd: 0.1 } }],
    });
    put('yesterday', { origin: 'mini', started: '2020-01-01T00:00:00.000Z', state: 'red', attempts: [{ calls: [{ usd: 3 }] }] });
    put('imported', { origin: 'private-line', started: today, state: 'green-preview', attempts: [{ calls: [{ usd: 4 }] }] });
    mkdirSync(join(cfg.records, 'broken'), { recursive: true });
    writeFileSync(join(cfg.records, 'broken', 'run.json'), '{');
    assert.equal(spentOf({ attempts: [{ calls: [{ usd: 0.25 }, { usd: 0.5 }] }] }), 0.75);
    assert.equal(
      readSpentToday(cfg),
      0.9,
      'calls where a record has them, the bridge total where it has none; other days and imported runs are not counted',
    );
    assert.deepEqual(runsToday(cfg, { day: utcDay() }), { committed_usd: 1.5, runs_today: 2 });
    assert.deepEqual(runsToday(cfg, { day: utcDay(), exceptId: 'today-running' }), { committed_usd: 0, runs_today: 2 });
  } finally {
    s.cleanup();
  }
});

test('the config holds the ceiling to the daily cap of $5', () => {
  assert.equal(loadConfig({}).daily_ceiling_usd, 5);
  assert.equal(loadConfig({ daily_ceiling_usd: 2 }).daily_ceiling_usd, 2);
  assert.throws(() => loadConfig({ daily_ceiling_usd: 5.5 }), /at most 5/);
  assert.throws(() => loadConfig({ daily_ceiling_usd: 0 }), /above 0/);
  assert.throws(() => loadConfig({ spend_fixture: '/x' }), /only with offline:true/);
  assert.throws(() => loadConfig({ gateway: 'x' }), /unknown key 'gateway'/);
});

test('a ticket that would pass the ceiling is blocked before anything starts; with room again it can be started, once', async () => {
  const s = scratch('budget-block');
  try {
    const spend = join(s.dir, 'spend.json');
    writeFileSync(spend, JSON.stringify({ spent_usd: 4 }));
    // sandbox 'none' also proves the order: the ceiling is read before the line even looks for a sandbox
    const cfg = offlineConfig(s.dir, { spend_fixture: spend, sandbox: 'none' });
    const ticket = fixtureTicket();
    const { council, approvals } = release(ticket); // the ticket carries $1.50
    const rec = await startRun(cfg, { ticket, approvals, council });
    assert.equal(rec.state, 'blocked');
    assert.match(rec.waiting_on, /daily ceiling: this ticket's \$1\.50 budget would carry/);
    assert.equal(rec.budget.decision, 'blocked');
    assert.equal(rec.budget.spent_usd_at_start, 4);
    assert.equal(rec.budget.ceiling_usd, 5);
    assert.equal(rec.attempts.length, 0);
    assert.equal(existsSync(join(cfg.scratch, ticket.id)), false, 'nothing ran');
    assert.deepEqual(rec.notifications.map((n) => n.kind), ['BUDGET', 'WAITING'], 'the half-ceiling alert, then why it waits');
    // nothing ran, so the id may be claimed again — exactly once
    assert.equal(claimRun(cfg, ticket.id).ok, true);
    assert.equal(claimRun(cfg, ticket.id).ok, false);
    // with room under the ceiling the same ticket passes the budget step (and stops at the next: no sandbox)
    writeFileSync(spend, JSON.stringify({ spent_usd: 3.5 }));
    const s2 = scratch('budget-room');
    try {
      const cfg2 = offlineConfig(s2.dir, { spend_fixture: spend, sandbox: 'none' });
      const rec2 = await startRun(cfg2, { ticket, approvals, council });
      assert.equal(rec2.budget.decision, 'ok');
      assert.match(rec2.waiting_on, /replay only/);
    } finally {
      s2.cleanup();
    }
  } finally {
    s.cleanup();
  }
});
