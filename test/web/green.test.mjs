// The chrome has one hue: the small live dot. No stylesheet and no screen may use a green for text, a border
// or a fill. Allowed: the --live token, used by .cb-dot alone, and the --cadence-* tokens.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '../../web');
const NAMED = /\b(green|lime|limegreen|lightgreen|darkgreen|forestgreen|seagreen|springgreen|chartreuse|lawngreen|olive|olivedrab)\b/i;

// A colour is green when its hue lies between yellow-green and spring green and it is not a grey.
export function isGreen(r, g, b) {
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  if (max === 0 || (max - min) / max <= 0.15 || max !== g) return false;
  const hue = 60 * (2 + (b - r) / (max - min));
  return hue >= 70 && hue <= 170;
}

function hexGreen(hex) {
  const h = hex.length <= 4 ? [...hex.slice(0, 3)].map((c) => c + c).join('') : hex.slice(0, 6);
  return isGreen(parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16));
}

/** Every green colour written in a value → the text that carries it. */
export function greensIn(value) {
  const found = [];
  for (const m of value.matchAll(/#([0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{3,4})\b/gi)) if (hexGreen(m[1])) found.push(m[0]);
  for (const m of value.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) if (isGreen(+m[1], +m[2], +m[3])) found.push(m[0] + ')');
  for (const m of value.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%/gi)) {
    if (+m[1] >= 70 && +m[1] <= 170 && +m[2] > 15) found.push(m[0] + ')');
  }
  return found;
}

/** The green uses in a stylesheet that are not allowed → ["selector { property: what }"]. */
export function greenFaults(css) {
  const faults = [];
  const plain = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, sel, body] of plain.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = sel.trim().replace(/\s+/g, ' ');
    for (const decl of body.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at).trim();
      const value = decl.slice(at + 1).trim();
      if (/^--(live|cadence-\d+)$/.test(prop)) continue;                       // the tokens themselves
      const bad = [...greensIn(value)];
      if (/var\(\s*--live\b/.test(value) && selector !== '.cb-dot') bad.push('var(--live)');
      if (!prop.startsWith('--') && NAMED.test(value.replace(/url\([^)]*\)/g, ''))) bad.push(value.match(NAMED)[0]);
      for (const what of bad) faults.push(`${selector} { ${prop}: ${what} }`);
    }
  }
  return faults;
}

/** The green colours a script writes: a colour literal, the live token, or a green colour name set as a style. */
export function scriptFaults(js) {
  const faults = [...greensIn(js)];
  if (/var\(\s*--live\b/.test(js)) faults.push('var(--live)');
  for (const m of js.matchAll(/\b(color|background|border|fill|stroke)[\w-]*\s*[:=]\s*['"`]?[^'"`;]*/gi)) {
    if (NAMED.test(m[0])) faults.push(m[0]);
  }
  return faults;
}

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('the checker refuses a green text, border or fill, and accepts the dot, the tokens and the greys', () => {
  for (const bad of [
    '.x { color: #73ff01; }', '.x { border: 1px solid rgba(115, 255, 1, .45); }', '.x { background: var(--live); }',
    '.x { fill: limegreen; }', '.x { box-shadow: 0 0 8px hsl(120 80% 50%); }', '.x { color: #5e9c20; }',
    '@media (min-width: 700px) { .bar { background: #3d4e2d; } }', '.cb-dot, .x { background: var(--live); }',
  ]) assert.ok(greenFaults(bad).length > 0, `not caught: ${bad}`);
  for (const fine of [
    '.cb-dot { width: 4px; background: var(--live); }', ':root { --live: #73ff01; --cadence-0: #3d4e2d; --cadence-3: #5e9c20; }',
    '.x { color: #a7a7a7; border: 1px solid rgba(255, 255, 255, .08); }', '.heat { background: var(--cadence-2); }',
    '.icon { background: radial-gradient(circle at 30% 22%, #ffd8a8, #ff8a3d 48%, #b4400e); }', '.field { background: #3a4fd8; }',
  ]) assert.deepEqual(greenFaults(fine), [], `wrongly refused: ${fine}`);
  assert.ok(scriptFaults("el.style.color = '#73ff01'").length > 0);
  assert.ok(scriptFaults("h('i', { style: 'background: green' })").length > 0);
  assert.deepEqual(scriptFaults("toast('Upread built cleanly.', 'green'); const isGreen = (r) => r.state === 'green-preview';"), []);
});

test('no stylesheet under web/ uses a green for text, a border or a fill', () => {
  const sheets = files(web).filter((f) => extname(f) === '.css');
  assert.ok(sheets.length >= 3, 'tokens, components and the app sheet');
  const found = sheets.flatMap((f) => greenFaults(readFileSync(f, 'utf8')).map((x) => `${relative(web, f)}: ${x}`));
  assert.deepEqual(found, []);
});

test('no screen or script under web/ writes a green colour', () => {
  const scripts = files(web).filter((f) => ['.js', '.mjs', '.html'].includes(extname(f)));
  assert.ok(scripts.length >= 12);
  const found = scripts.flatMap((f) => scriptFaults(readFileSync(f, 'utf8')).map((x) => `${relative(web, f)}: ${x}`));
  assert.deepEqual(found, []);
});

test('the one green is the dot: components.css gives --live to .cb-dot, and tokens.css defines it', () => {
  assert.match(readFileSync(join(web, 'components.css'), 'utf8'), /\.cb-dot\s*\{[^}]*background:\s*var\(--live\)/);
  assert.match(readFileSync(join(web, 'tokens.css'), 'utf8'), /--live:\s*#73ff01/i);
});
