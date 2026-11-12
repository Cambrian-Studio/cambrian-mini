// deploy-replay.mjs — put the static REPLAY build (npm run build:static) on Vercel as the hosted demo.
//   node scripts/deploy-replay.mjs            deploys; the project keeps Vercel's sign-in wall (NOT public)
//   node scripts/deploy-replay.mjs --public   also turns the sign-in wall off, then checks an anonymous GET is 200
// Making the demo public is a human decision: --public is never passed by any script in this repository.
// The token is read from VERCEL_TOKEN_FILE (mode 600) and is never printed.
import { readFileSync, statSync } from 'node:fs';
import { appConfig } from '../app/config.mjs';
import { buildStatic } from '../app/static-build.mjs';
import { outputFiles } from '../line/vercel.mjs';

const cfg = appConfig(); const makePublic = process.argv.includes('--public');
const NAME = 'cambrian-line-replay';
if (!cfg.vercel.tokenFile || (statSync(cfg.vercel.tokenFile).mode & 0o777) !== 0o600) { console.error('no Vercel token file (mode 600) — nothing deployed'); process.exit(2); }
const token = readFileSync(cfg.vercel.tokenFile, 'utf8').trim();
if (!cfg.vercel.team) { console.error('set VERCEL_TEAM to the team that hosts the demo — nothing deployed'); process.exit(2); }
const q = `slug=${encodeURIComponent(cfg.vercel.team)}`;
const api = async (method, path, body) => {
  const r = await fetch(`https://api.vercel.com${path}${path.includes('?') ? '&' : '?'}${q}`, { method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const json = await r.json().catch(() => null);
  return { status: r.status, json, why: String(json?.error?.message ?? `HTTP ${r.status}`).split(token).join('[token]') };
};
const built = buildStatic({ cfg });
const { files } = outputFiles(built.dest);
console.log(`built ${files.length} files`);
const made = await api('POST', '/v11/projects', { name: NAME, framework: null });
if (![200, 201, 409].includes(made.status)) { console.error(`project not made: ${made.why}`); process.exit(1); }
if (makePublic) {
  const open = await api('PATCH', `/v9/projects/${NAME}`, { ssoProtection: null });
  if (open.status !== 200 || open.json?.ssoProtection != null) { console.error(`the sign-in wall could not be turned off: ${open.why}`); process.exit(1); }
}
const dep = await api('POST', '/v13/deployments?skipAutoDetectionConfirmation=1', { name: NAME, project: NAME, target: 'production', projectSettings: { framework: null },
  files: files.map((f) => ({ file: f.rel, data: readFileSync(f.abs).toString('base64'), encoding: 'base64' })) });
if (![200, 201].includes(dep.status)) { console.error(`deployment refused: ${dep.why}`); process.exit(1); }
let state = dep.json.readyState; const t0 = Date.now();
while (state !== 'READY') { if (['ERROR', 'CANCELED'].includes(state) || Date.now() - t0 > 300000) { console.error(`deployment ended ${state}`); process.exit(1); }
  await new Promise((r) => setTimeout(r, 4000)); state = (await api('GET', `/v13/deployments/${dep.json.id}`)).json?.readyState ?? state; }
const proj = await api('GET', `/v9/projects/${NAME}`);
const urls = [`https://${dep.json.url}`, ...(dep.json.alias ?? []).map((a) => `https://${a}`)];
console.log(`deployment ${dep.json.id} READY`);
for (const u of urls) { const r = await fetch(u, { redirect: 'manual' }); console.log(`${u} → anonymous GET ${r.status}`); }
console.log(`sign-in wall: ${proj.json?.ssoProtection == null ? 'OFF (public)' : `ON (${JSON.stringify(proj.json.ssoProtection)}) — not public`}`);
