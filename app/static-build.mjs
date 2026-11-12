// static-build.mjs — `npm run build:static`: the public REPLAY demo as plain files.
// It copies web/ and writes every api/*.json from the SAME snapshot() the server answers with, forced to
// REPLAY mode. No key is read, nothing from the private state directory is copied, and the build fails if a
// secret-shaped string shows up in the output.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from './config.mjs';
import { snapshot } from './store.mjs';

const SECRET_SHAPES = [/github_pat_[A-Za-z0-9_]{20,}/, /\bgh[pousr]_[A-Za-z0-9]{20,}/, /\bsk-[A-Za-z0-9_-]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /_vercel_share=/, /\bed25519:[1-9A-HJ-NP-Za-km-z]{80,}/];

export function buildStatic({ out, cfg = appConfig() } = {}) {
  const replay = { ...cfg, mode: 'replay', reasons: ['hosted replay: recorded runs, no keys'] };
  const dest = resolve(out ?? join(cfg.root, 'dist-static'));
  rmSync(dest, { recursive: true, force: true }); mkdirSync(dest, { recursive: true });
  cpSync(join(cfg.root, 'web'), dest, { recursive: true });
  mkdirSync(join(dest, 'lib'), { recursive: true });
  cpSync(join(cfg.root, 'receipts', 'canonical.mjs'), join(dest, 'lib', 'canonical.mjs'));
  const snap = snapshot(replay, { static: true });
  for (const [path, value] of Object.entries(snap)) {
    const file = join(dest, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, JSON.stringify(value));
  }
  const hits = []; let count = 0;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); if (statSync(p).isDirectory()) { walk(p); continue; } count++;
    if (/\.(png|jpg|woff2|ttf|ico)$/.test(n)) continue; const text = readFileSync(p, 'utf8');
    for (const re of SECRET_SHAPES) if (re.test(text)) hits.push(`${p}: ${re}`); } };
  walk(dest);
  if (hits.length) throw new Error(`static build: secret-shaped text in the output — ${hits.join('; ')}`);
  return { dest, files: count, api: Object.keys(snap).length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = buildStatic({ out: process.argv[2] });
  console.log(`static REPLAY build: ${r.files} files (${r.api} api documents) in ${r.dest}`);
}
