// Structure test for index.html. Reads the page as text only: no browser, no network.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, 'index.html'), 'utf8');

const failures = [];
function check(name, ok) {
  console.log((ok ? 'ok   ' : 'FAIL ') + name);
  if (!ok) failures.push(name);
}

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([a-zA-Z-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

check('embedded sample from On the Origin of Species', html.includes('Origin of Species') && /id="sample"/.test(html));
check('sample has at least 200 words', (() => {
  const m = html.match(/<script id="sample"[^>]*>([\s\S]*?)<\/script>/);
  return !!m && m[1].trim().split(/\s+/).length >= 200;
})());

const range = [...html.matchAll(/<input\b[^>]*type="range"[^>]*>/g)].map((m) => attrs(m[0]));
const slider = range.find((a) => a.id === 'speed');
check('speed slider exists', !!slider);
check('slider min is 150', slider?.min === '150');
check('slider max is 900', slider?.max === '900');
check('slider default is 300', slider?.value === '300');
check('slider has a label', /<label[^>]*for="speed"/.test(html));

check('pause control', /id="pause"/.test(html));
check('progress bar', /id="progress"/.test(html) && /role="progressbar"/.test(html));
check('time-left element', /id="time-left"/.test(html));
check('sentence context element', /id="context"/.test(html));
check('#check element', /id="check"/.test(html));
check('measures with getBoundingClientRect', html.includes('getBoundingClientRect'));
check('self-check uses first 200 sample words', /slice\(0,\s*200\)/.test(html));
check('self-check reports drift', /drift/i.test(html));
check('anchor slot at 35%', /SLOT\s*=\s*0\.35/.test(html));
check('longer pauses at commas and full stops', /\[,;:\]/.test(html) && /\[\.!\?\]/.test(html));
check('nothing fetched from the network', !/https?:\/\//.test(html) && !/\bfetch\(|XMLHttpRequest/.test(html));
check('house tokens loaded first', /<link rel="stylesheet" href="tokens\.css">/.test(html));
check('respects reduced motion', html.includes('prefers-reduced-motion'));

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll checks passed.');
