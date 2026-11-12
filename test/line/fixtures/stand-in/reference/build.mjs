// build.mjs — facts.json in, dist/index.html out. No dependencies.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const facts = JSON.parse(readFileSync(new URL('./facts.json', import.meta.url), 'utf8'));
const badge = '<span class="badge">Market: 50%</span>';
const item = (f) => `    <li data-fact-id="${esc(f.id)}"><span class="text">${esc(f.text)}</span> ${badge}</li>`;
const items = facts.map(item).join('\n');
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Facts</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}
li{margin:.75rem 0}
.badge{font-size:.8em;padding:.1em .5em;border:1px solid currentColor;border-radius:1em;white-space:nowrap}
</style>
</head>
<body>
  <h1>Facts</h1>
  <ul>
${items}
  </ul>
</body>
</html>
`;
mkdirSync(new URL('./dist/', import.meta.url), { recursive: true });
writeFileSync(new URL('./dist/index.html', import.meta.url), html);
console.log(`built dist/index.html with ${facts.length} facts`);
