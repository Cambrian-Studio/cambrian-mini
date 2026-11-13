#!/usr/bin/env node
// solo.mjs — `npm run solo`: run your own line on this machine, as a council of one.
// It keeps everything it makes under .solo/ (ignored by git), so the committed record is untouched:
//   .solo/data    your council of one, your briefs, your builds and their records
//   .solo/state   the agent runtime, scratch space, your enrolment link
// It needs your own NEAR AI key in a file (mode 600). Nothing is recorded on NEAR: no contract is configured here.
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const data = join(ROOT, '.solo', 'data'); const state = join(ROOT, '.solo', 'state');
const port = Number(process.env.CAMBRIAN_PORT || 8787);
const keyFile = process.env.NEARAI_KEY_FILE || join(homedir(), '.cambrian-secrets', 'nearai.key');
const die = (msg) => { console.error(msg); process.exit(2); };

if (!existsSync(keyFile)) die(`No NEAR AI key file at ${keyFile}.\nPut your key in a file and point to it: NEARAI_KEY_FILE=/path/to/key npm run solo`);
if ((statSync(keyFile).mode & 0o777) !== 0o600) die(`${keyFile} must be readable by you only: chmod 600 ${keyFile}`);

mkdirSync(data, { recursive: true }); mkdirSync(state, { recursive: true });
const origin = `http://localhost:${port}`;
const put = (name, value) => { const f = join(data, name); if (!existsSync(f)) writeFileSync(f, `${JSON.stringify(value, null, 2)}\n`); };
// A council of one is its own, labelled case: `solo: true`, one member, threshold 1. It is never the collective's council.
put('council.json', { v: 1, solo: true, label: 'solo, a council of one', threshold: 1, rp: { id: 'localhost', name: 'Cambrian Mini (solo)', origins: [origin] },
  members: [{ id: 'you', name: 'You', role: 'Solo', figure: null, credentials: [] }] });
put('products.json', { v: 1, products: [] });
put('stake.json', { v: 1, placeholder: true, note: 'A solo line records no stake.' });

if (!existsSync(join(state, 'tools', 'node_modules', '.bin', 'opencode'))) {
  console.log('Installing the coding agent (OpenCode) into .solo/state/tools. This happens once.');
  const r = spawnSync('sh', [join(ROOT, 'line', 'kit', 'setup-tools.sh'), join(state, 'tools')], { stdio: 'inherit' });
  if (r.status !== 0) die('The coding agent could not be installed. Check your network and run `npm run solo` again.');
}

// The build model: an open model NEAR AI hosts, unless you name another (LINE_MODEL). Each of its calls is signed in its TEE.
const buildModel = process.env.LINE_MODEL || 'Qwen/Qwen3.6-35B-A3B-FP8';
// A solo line publishes nothing: the preview is served from this machine. Name a Vercel token file yourself to deploy previews.
const vercel = process.env.VERCEL_TOKEN_FILE || join(state, 'no-vercel-token');
Object.assign(process.env, { CAMBRIAN_DATA: data, CAMBRIAN_STATE: state, NEARAI_KEY_FILE: keyFile, CAMBRIAN_PORT: String(port), CAMBRIAN_EXPOSED: '',
  LINE_MODEL: buildModel, VERCEL_TOKEN_FILE: vercel });
const { appConfig } = await import('../app/config.mjs');
const { council } = await import('../app/store.mjs');
const { createInvite } = await import('../approvals/council.mjs');
const { makeServer } = await import('../app/server.mjs');
const cfg = appConfig();
if (cfg.mode !== 'live') die(`The app did not start in LIVE mode (${cfg.reasons.join('; ')}).`);
const { server } = await makeServer(cfg);
server.listen(cfg.port, cfg.host, () => {
  console.log(`\nCambrian Mini, solo: your own line, a council of one. ${origin}/`);
  const c = council(cfg);
  if (!c.members[0].credentials.length) {
    const inv = createInvite({ invitesFile: cfg.files.invites, council: c, memberId: 'you' });
    console.log('\n1. Enrol your passkey (this link works once, for 24 hours):');
    console.log(`   ${origin}/#/enrol/${inv.token}`);
    console.log(`2. Talk through an idea, draft the brief and send it:  ${origin}/#/talk`);
    console.log(`3. Sign it with your passkey:                          ${origin}/#/approvals`);
    console.log(`4. Watch it build, then open the preview and record:   ${origin}/#/line`);
  } else console.log(`Your passkey is enrolled. Talk: ${origin}/#/talk`);
  console.log(`\nBuilds run on ${buildModel}.`);
  console.log(`One build may cost at most $${process.env.CAMBRIAN_BUILD_CAP_USD || 2}; the day's cap is $${cfg.dailyCapUsd}. Nothing is recorded on NEAR.`);
});
