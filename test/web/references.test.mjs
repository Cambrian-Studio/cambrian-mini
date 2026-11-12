// index.html, the stylesheet and every module reference only files that exist under web/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '../../web');
const read = (name) => readFileSync(join(web, name), 'utf8');
const local = (ref) => ref && !/^(https?:|data:|#|mailto:)/.test(ref);

// The references in a file that do not resolve to a file inside web/.
// One file is not under web/: the server serves receipts/canonical.mjs at lib/canonical.mjs,
// and the static build copies it there, so the browser and the server hash with the same code.
const SERVED = { 'lib/canonical.mjs': resolve(web, '../receipts/canonical.mjs') };
export function missing(from, refs) {
  return refs.filter(local).map((ref) => resolve(web, dirname(from), ref.split(/[?#]/)[0]))
    .map((p) => [p, SERVED[relative(web, p)] || p])
    .filter(([p, real]) => !p.startsWith(web) || !existsSync(real) || !statSync(real).isFile()).map(([p]) => relative(web, p));
}

const htmlRefs = (html) => [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const cssRefs = (css) => [...css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)].map((m) => m[1]);
const jsRefs = (js) => [...js.matchAll(/\bfrom\s+'([^']+)'|\bimport\s+'([^']+)'/g)].map((m) => m[1] || m[2]);

function modules(dir = web) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return modules(p);
    return /\.m?js$/.test(name) ? [relative(web, p)] : [];
  });
}

test('the checker reports a missing file and a path that leaves web/', () => {
  assert.deepEqual(missing('index.html', ['app.js', '#/talk', 'https://example.org/x.js']), []);
  assert.deepEqual(missing('index.html', ['nope.js']), ['nope.js']);
  assert.equal(missing('index.html', ['../package.json']).length, 1);
});

test('index.html references only files that exist', () => {
  const refs = htmlRefs(read('index.html'));
  assert.ok(refs.includes('app.js') && refs.includes('styles.css'));
  assert.deepEqual(missing('index.html', refs), []);
  assert.deepEqual(refs.filter((r) => /^https?:/.test(r)), [], 'the page loads nothing from another host');
});

test('the stylesheet references only files that exist', () => {
  const refs = cssRefs(read('styles.css'));
  assert.ok(refs.some((r) => r.endsWith('.ttf')));
  assert.deepEqual(missing('styles.css', refs), []);
});

test('every module imports only files that exist, and nothing from npm', () => {
  const all = modules();
  assert.ok(all.includes('app.js') && all.includes('lib/webauthn.mjs'));
  for (const file of all) {
    const refs = jsRefs(read(file));
    assert.deepEqual(refs.filter((r) => !r.startsWith('.')), [], `${file} imports a bare module`);
    assert.deepEqual(missing(file, refs), [], file);
  }
});

test('asset paths written in the screens exist', () => {
  // one figure is published today; the other two members are drawn without one until they agree to theirs
  assert.deepEqual(readdirSync(join(web, 'assets/members')).sort(), ['clemens.png']);
});

test('the serializer is the server\'s file, not a copy kept under web/', () => {
  assert.equal(existsSync(join(web, 'lib/canonical.mjs')), false);
  const real = readFileSync(SERVED['lib/canonical.mjs'], 'utf8');
  for (const name of ['canonical', 'hashOfAsync']) assert.match(real, new RegExp(`export (function|const) ${name}\\b`));
  const users = modules().filter((f) => /from '\.\.\/lib\/canonical\.mjs'/.test(read(f)));
  assert.deepEqual(users.sort(), ['screens/approvals.js', 'screens/receipts.js']);
});
