// CLAIMS.md is checked, not trusted: every `file:line` must exist, every named test must be in its file,
// every row that is not pending must name a test, and every pending row must say so.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rows = readFileSync(join(ROOT, 'CLAIMS.md'), 'utf8').split('\n').filter((l) => /^\| \d+ \|/.test(l))
  .map((l) => { const c = l.split('|').slice(1, -1).map((x) => x.trim()); return { n: Number(c[0]), claim: c[1], where: c[2], test: c[3], status: c[4] }; });

test('the claims table is numbered 1..N with no gap', () => {
  assert.ok(rows.length >= 40); rows.forEach((r, i) => assert.equal(r.n, i + 1));
});
test('every "where" exists: the file, and the line in it', () => {
  for (const r of rows) {
    const m = /^`([^`:]+)(?::(\d+))?`$/.exec(r.where); assert.ok(m, `claim ${r.n}: where is not \`path[:line]\` (${r.where})`);
    const p = join(ROOT, m[1]); assert.ok(existsSync(p), `claim ${r.n}: ${m[1]} does not exist`);
    if (m[2]) { assert.ok(statSync(p).isFile()); assert.ok(readFileSync(p, 'utf8').split('\n').length >= Number(m[2]), `claim ${r.n}: ${m[1]} has no line ${m[2]}`); }
  }
});
test('every claim that is not pending names a test that is really in that file', () => {
  for (const r of rows) {
    if (r.test === '—') { assert.match(r.status, /pending/, `claim ${r.n} names no test, so it must be pending (or rehearsed and pending)`); continue; }
    const m = /^`([^`]+)` › "(.+)"$/.exec(r.test); assert.ok(m, `claim ${r.n}: test is not \`file\` › "name" (${r.test})`);
    const p = join(ROOT, m[1]); assert.ok(existsSync(p), `claim ${r.n}: ${m[1]} does not exist`);
    assert.ok(readFileSync(p, 'utf8').includes(m[2]), `claim ${r.n}: no test named "${m[2]}" in ${m[1]}`);
  }
});
test('a pending claim is never called tested', () => {
  for (const r of rows.filter((x) => x.test === '—')) assert.doesNotMatch(r.status, /^tested/, `claim ${r.n}`);
});
