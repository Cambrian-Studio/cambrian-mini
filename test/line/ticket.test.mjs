// The ticket: what it must say, and what it can never say.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { branchOf, budgetCapUsd, parseTicket, ticketHash } from '../../tickets/ticket.mjs';
import { ticketHash as releaseHash, verifyRelease } from '../../approvals/release.mjs';
import { makeTestCouncil } from '../../approvals/test-authenticator.mjs';
import { recheck } from '../../line/checks.mjs';
import { FIXTURES, fixtureTicket, scratch } from './helpers.mjs';
import { readFileSync } from 'node:fs';

const base = () => JSON.parse(readFileSync(join(FIXTURES, 'tickets', 'facts-page-1.json'), 'utf8'));
const refused = (change, pattern) =>
  assert.throws(() => {
    const t = base();
    change(t);
    parseTicket(t);
  }, pattern);

test('a good ticket parses, from an object and from bytes, to the same thing', () => {
  const fromObject = parseTicket(base());
  const fromBytes = parseTicket(readFileSync(join(FIXTURES, 'tickets', 'facts-page-1.json')));
  const fromString = parseTicket(JSON.stringify(base()), 'facts-page-1');
  assert.deepEqual(fromObject, fromBytes);
  assert.deepEqual(fromObject, fromString);
  assert.equal(fromObject.branch, 'build/facts-page-1');
  assert.equal(branchOf('abc'), 'build/abc');
  assert.equal(fromObject.base, 'main');
  assert.equal(fromObject.green.length, 10);
  assert.deepEqual(parseTicket(fromObject), fromObject, 'parsing a parsed ticket changes nothing');
});

test('the hash is over the canonical form: key order does not matter, one changed byte does', () => {
  const t = parseTicket(base());
  const reordered = Object.fromEntries(Object.entries(t).reverse());
  assert.match(ticketHash(t), /^[0-9a-f]{64}$/);
  assert.equal(ticketHash(reordered), ticketHash(t));
  assert.equal(releaseHash(t), ticketHash(t), 'the council signs the same hash the line computes');
  assert.notEqual(ticketHash({ ...t, title: t.title + '.' }), ticketHash(t));
});

test('a ticket cannot name a repository, a host or any unknown key', () => {
  refused((t) => {
    t.repo = 'someone/else';
  }, /unknown key 'repo'/);
  refused((t) => {
    t.remote = 'https://example.com/x.git';
  }, /unknown key 'remote'/);
  refused((t) => {
    t.green[0].cwd = '/';
  }, /unknown key 'cwd'/);
  refused((t) => {
    t.budget.tokens = 5;
  }, /unknown key 'tokens'/);
  refused((t) => {
    t.base = 'release';
  }, /base must be "main"/);
  refused((t) => {
    t.branch = 'main';
  }, /branch must be "build\/facts-page-1"/);
});

test('paths in checks stay inside the repository: no .., no absolute path, no backslash', () => {
  const file = (path) => (t) => {
    t.green = [{ id: 'f', kind: 'file', path }];
  };
  const dir = (d) => (t) => {
    t.green = [{ id: 'd', kind: 'no_external_hosts', dir: d }];
  };
  for (const p of ['../outside', 'dist/../../outside', '/etc/passwd', 'dist\\x', './dist', 'dist//x', '..']) {
    refused(file(p), /relative path inside the repository/);
    refused(dir(p), /relative path inside the repository/);
  }
  assert.equal(parseTicket({ ...base(), green: [{ id: 'f', kind: 'file', path: 'dist/index.html' }] }).green[0].path, 'dist/index.html');
});

test('a file check does not follow a symbolic link out of the directory it reads', () => {
  const s = scratch('symlink');
  try {
    const out = join(s.dir, 'output'), outside = join(s.dir, 'outside');
    mkdirSync(join(out, 'dist'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'wanted words');
    writeFileSync(join(out, 'dist', 'real.txt'), 'wanted words');
    symlinkSync(join(outside, 'secret.txt'), join(out, 'dist', 'link.txt'));
    symlinkSync(outside, join(out, 'linked-dir'));
    const ticket = parseTicket({
      ...base(),
      green: [
        { id: 'real', kind: 'file', path: 'dist/real.txt', contains: ['wanted words'] },
        { id: 'link', kind: 'file', path: 'dist/link.txt', contains: ['wanted words'] },
        { id: 'dir', kind: 'no_external_hosts', dir: 'linked-dir' },
      ],
    });
    const r = recheck({ ticket, outputDir: out });
    const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
    assert.equal(by.real.pass, true, 'the file inside is read');
    assert.equal(by.link.pass, false);
    assert.match(by.link.detail, /resolves outside/);
    assert.equal(by.dir.pass, false);
    assert.match(by.dir.detail, /resolves outside/);
    assert.deepEqual(r.failing, ['link', 'dir']);
    assert.equal(r.ok, false);
  } finally {
    s.cleanup();
  }
});

test('checks are validated: kinds, ids, regular expressions, exit codes', () => {
  refused((t) => {
    t.green = [];
  }, /a list of 1\.\.20 checks/);
  refused((t) => {
    t.green[0].kind = 'shell';
  }, /kind: one of run, file, no_external_hosts/);
  refused((t) => {
    t.green[1].id = t.green[0].id;
  }, /appears twice/);
  refused((t) => {
    t.green[0].id = 'Bad Id';
  }, /a-z 0-9 -/);
  refused((t) => {
    t.green[1].stdout_matches = '(';
  }, /not a regular expression/);
  refused((t) => {
    t.green[0].network = 'internet';
  }, /'none' or 'registry'/);
  refused((t) => {
    t.green[0].exit = 300;
  }, /exit code 0\.\.255/);
  refused((t) => {
    t.green[0].timeout_s = 6000;
  }, /timeout_s: 1\.\.600/);
  refused((t) => {
    t.green = [{ id: 'f', kind: 'file', path: 'a', exists: false, contains: ['x'] }];
  }, /exists:false takes no content conditions/);
  refused((t) => {
    t.green = [{ id: 'f', kind: 'file', path: 'a', count: { pattern: 'x', equals: -1 } }];
  }, /a whole number/);
});

test('the budget is bounded: at most the daily cap of $5, 120 calls, 45 minutes', () => {
  assert.equal(parseTicket({ ...base(), budget: { usd: 5, calls: 120, minutes: 45 } }).budget.usd, 5);
  refused((t) => {
    t.budget.usd = 5.01;
  }, /at most 5 \(the daily cap\)/);
  refused((t) => {
    t.budget.usd = 0;
  }, /above 0/);
  refused((t) => {
    t.budget.calls = 121;
  }, /budget\.calls/);
  refused((t) => {
    t.budget.minutes = 46;
  }, /budget\.minutes/);
  assert.equal(budgetCapUsd({}), 5);
  assert.equal(budgetCapUsd({ CAMBRIAN_DAILY_CAP_USD: '12' }), 12, 'the environment can raise the cap');
  assert.equal(budgetCapUsd({ CAMBRIAN_DAILY_CAP_USD: '1' }), 5, 'and cannot lower it below 5');
});

test('the rest of the shape: kind, version, id, product, text fields', () => {
  refused((t) => {
    t.kind = 'ticket';
  }, /kind must be "build-ticket"/);
  refused((t) => {
    t.v = 2;
  }, /v must be 1/);
  refused((t) => {
    t.id = 'No';
  }, /id — a-z 0-9 -/);
  refused((t) => {
    t.product = '../x';
  }, /product — a product id/);
  refused((t) => {
    t.task = 'too short';
  }, /task: 9 characters/);
  refused((t) => {
    t.title = 'x\u0000y';
  }, /control characters/);
  refused((t) => {
    t.out_of_scope = 'everything';
  }, /out_of_scope: a list/);
  assert.throws(() => parseTicket(base(), 'another-id'), /is not the expected 'another-id'/);
  assert.throws(() => parseTicket(''), /empty/);
  assert.throws(() => parseTicket('{'), /not JSON/);
  assert.throws(() => parseTicket(Buffer.alloc(70000, 0x20)), /limit 65536/);
  const t = fixtureTicket();
  assert.equal(typeof t.goal, 'string');
  assert.ok(Array.isArray(t.out_of_scope));
});

test('drafted: an optional record of the model call the text came from; four strings, two of them sha256 hex, nothing else', () => {
  const drafted = { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', completion_id: 'chatcmpl-1', request_sha256: 'a'.repeat(64),
    response_sha256: 'b'.repeat(64) };
  const t = parseTicket({ ...base(), drafted });
  assert.deepEqual(t.drafted, drafted);
  assert.deepEqual(parseTicket(t), t, 'parsing a parsed ticket changes nothing');
  assert.equal(parseTicket(base()).drafted, undefined, 'a ticket without it is still a ticket');
  refused((x) => { x.drafted = { ...drafted, extra: 1 }; }, /drafted: unknown key 'extra'/);
  refused((x) => { x.drafted = { ...drafted, response_sha256: 'B'.repeat(64) }; }, /response_sha256: 64 lowercase hex/);
  refused((x) => { x.drafted = { ...drafted, request_sha256: 'a'.repeat(63) }; }, /request_sha256: 64 lowercase hex/);
  refused((x) => { x.drafted = { ...drafted, model: 7 }; }, /drafted\.model: a string is required/);
  refused((x) => { const { completion_id: _gone, ...rest } = drafted; x.drafted = rest; }, /drafted\.completion_id/);
  refused((x) => { x.drafted = 'chatcmpl-1'; }, /drafted/);
  refused((x) => { x.drafted = null; }, /drafted/);
});

test('drafted is inside the hash: changing the response hash changes the ticket hash and voids approvals made before', () => {
  const drafted = { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', completion_id: 'chatcmpl-1', request_sha256: 'a'.repeat(64),
    response_sha256: 'b'.repeat(64) };
  const t = parseTicket({ ...base(), drafted });
  const other = parseTicket({ ...base(), drafted: { ...drafted, response_sha256: 'c'.repeat(64) } });
  assert.notEqual(ticketHash(other), ticketHash(t));
  assert.notEqual(ticketHash(parseTicket(base())), ticketHash(t), 'a ticket with no drafted record is another ticket too');
  const { council, sign } = makeTestCouncil();
  const approvals = [sign('clemens', t), sign('jj', t)];
  assert.equal(verifyRelease(t, approvals, council).ok, true, 'the approvals hold over the ticket they signed');
  const after = verifyRelease(other, approvals, council);
  assert.equal(after.ok, false); assert.deepEqual(after.valid, []);
  // rewriting the recorded hash field to match does not help: the passkey signed the old challenge
  const patched = approvals.map((a) => ({ ...a, ticket_sha256: ticketHash(other) }));
  assert.deepEqual(verifyRelease(other, patched, council).valid, []);
});
