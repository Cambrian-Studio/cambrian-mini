// Every file under web/ is public. None of them may carry a machine path, a private address, an id or a
// credential shape (test/support/deny.mjs), nor any extra term the publisher's own deny file names.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DENY, faults } from '../support/deny.mjs';

const web = join(dirname(fileURLToPath(import.meta.url)), '../../web');
const BINARY = new Set(['.ttf', '.png', '.jpg', '.woff2', '.ico']);

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('the deny-list catches each sample and passes public words', () => {
  for (const [what, , sample] of DENY) assert.ok(faults(sample).length > 0, `not caught: ${what} in "${sample}"`);
  for (const fine of ['canonical JSON', 'the line', 'the council', 'a desktop browser', 'stations', 'think about it',
    'it writes a receipt', 'http://127.0.0.1:8787', 'toLocaleString', 'propose an idea', 'version 1.2.3']) {
    assert.deepEqual(faults(fine), [], `wrongly refused: "${fine}"`);
  }
});

test('no file under web/ carries a path, a private address, an id or a credential shape', () => {
  const all = files(web);
  assert.ok(all.length >= 20, 'web/ should hold the UI');
  const found = [];
  for (const file of all) {
    const name = relative(web, file);
    for (const f of faults(name)) found.push(`${name} (file name): ${f}`);
    if (BINARY.has(extname(file))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const f of faults(line)) found.push(`${name}:${i + 1}: ${f}`);
    });
  }
  assert.deepEqual(found, []);
});

test('lines stay readable: no source line over 140 characters', () => {
  const long = [];
  for (const file of files(web)) {
    if (!['.js', '.mjs', '.html'].includes(extname(file))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      if (line.length > 140 && !line.includes('<svg') && !line.includes('<path')) long.push(`${relative(web, file)}:${i + 1} (${line.length})`);
    });
  }
  assert.deepEqual(long, []);
});

test('web/ holds no fixtures: no such file or directory, and no fixture marker in any file', () => {
  const all = files(web).map((f) => relative(web, f));
  assert.deepEqual(all.filter((name) => /fixture/i.test(name)), []);
  const marked = all.filter((name) => !BINARY.has(extname(name)) && /_fixture|fixtures\/api|fixtures=1/.test(readFileSync(join(web, name), 'utf8')));
  assert.deepEqual(marked, []);
  assert.ok(/_fixture/.test('{"_fixture": true}'), 'the marker pattern matches a fixture file');
});
