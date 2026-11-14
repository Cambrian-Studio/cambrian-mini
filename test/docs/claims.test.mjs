// CLAIMS.md is checked, not trusted: every file named must exist, every named test must be in its file, a row
// without a test must be "recorded" (and name the judge check or the file that shows it) or "next", and the rows
// that are not true yet sit together under "What is next".
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = readFileSync(join(ROOT, 'CLAIMS.md'), 'utf8');
const nextAt = text.indexOf('\n## What is next');
const parse = (part, next) => part.split('\n').filter((l) => /^\| \d+ \|/.test(l))
  .map((l) => { const c = l.split('|').slice(1, -1).map((x) => x.trim()); return { n: Number(c[0]), claim: c[1], where: c[2], test: c[3], status: c[4], next }; });
const rows = [...parse(text.slice(0, nextAt), false), ...parse(text.slice(nextAt), true)];

test('the claims are numbered 1..N with no gap and no repeat', () => {
  assert.ok(nextAt > 0, 'there is a "What is next" section'); assert.ok(rows.length >= 40);
  assert.deepEqual(rows.map((r) => r.n).sort((a, b) => a - b), rows.map((_, i) => i + 1));
});
test('every "where" names a file that exists', () => {
  for (const r of rows) {
    const m = /^`([^`:]+)`$/.exec(r.where); assert.ok(m, `claim ${r.n}: where is not a \`path\` (${r.where})`);
    assert.ok(existsSync(join(ROOT, m[1])), `claim ${r.n}: ${m[1]} does not exist`);
  }
});
test('every claim names a test that is really in that file, or is recorded with its proof, or is next', () => {
  for (const r of rows) {
    if (r.next) {
      assert.equal(r.test, '—', `claim ${r.n} is under "What is next" and names a test`);
      assert.match(r.status, /^next: /, `claim ${r.n}: a row under "What is next" says what is missing`);
      continue;
    }
    assert.doesNotMatch(r.status, /\bpending\b|^next\b/, `claim ${r.n}: a row that is not true yet belongs under "What is next"`);
    if (r.test === '—') {
      assert.match(r.status, /^recorded: /, `claim ${r.n} names no test, so it must be recorded`);
      assert.match(r.status, /`npm run judge`|`[^`]*(data|run\.json)[^`]*`|`push\.publish`/, `claim ${r.n}: recorded, but no judge check or record is named`);
      continue;
    }
    const m = /^`([^`]+)` › "(.+)"$/.exec(r.test); assert.ok(m, `claim ${r.n}: test is not \`file\` › "name" (${r.test})`);
    const p = join(ROOT, m[1]); assert.ok(existsSync(p), `claim ${r.n}: ${m[1]} does not exist`);
    assert.ok(readFileSync(p, 'utf8').includes(m[2]), `claim ${r.n}: no test named "${m[2]}" in ${m[1]}`);
  }
});
test('a row that is next is never called tested or recorded', () => {
  for (const r of rows.filter((x) => x.next)) assert.doesNotMatch(r.status, /tested|recorded/, `claim ${r.n}`);
});
