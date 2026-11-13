// config.mjs — where things are and which mode the app is in. No secret is read here: the config names
// the FILES that hold them. LIVE needs a NEAR AI key file; without one the app is in REPLAY.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));
const env = (k, d = null) => (process.env[k] && process.env[k].trim() !== '' ? process.env[k].trim() : d);
const keyFileOk = (f) => { try { return !!f && existsSync(f) && (statSync(f).mode & 0o777) === 0o600 && statSync(f).size > 0; } catch { return false; } };

function committedChain(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c.network && c.contract ? { network: c.network, contract: c.contract, recorder: c.recorder ?? null } : null;
  } catch { return null; }
}

export function appConfig() {
  const data = resolve(env('CAMBRIAN_DATA', join(ROOT, 'data')));          // the committed record: what REPLAY and the judge read
  const state = resolve(env('CAMBRIAN_STATE', join(ROOT, '.line')));      // the build machine's private state: never committed
  const nearaiKeyFile = env('NEARAI_KEY_FILE', join(homedir(), '.cambrian-secrets', 'baby-nearai.key'));
  const vercelTokenFile = env('VERCEL_TOKEN_FILE', join(homedir(), '.cambrian-secrets', 'baby-vercel.token'));
  const port = Number(env('CAMBRIAN_PORT', '8787'));
  const forcedReplay = env('CAMBRIAN_MODE') === 'replay';
  const live = !forcedReplay && keyFileOk(nearaiKeyFile);
  const cap = Math.max(0, Number(env('CAMBRIAN_DAILY_CAP_USD', '5')) || 5);
  return {
    root: ROOT, data, state, port,
    host: '127.0.0.1',                                                     // LIVE never listens beyond this machine
    mode: live ? 'live' : 'replay',
    reasons: live ? [] : [forcedReplay ? 'CAMBRIAN_MODE=replay' : 'no NEAR AI key file on this machine'],
    nearai: { keyFile: nearaiKeyFile, base: env('NEARAI_BASE', 'https://cloud-api.near.ai/v1'), model: env('LINE_MODEL', 'deepseek-ai/DeepSeek-V4.1-Flash-1017'), briefModel: env('BRIEF_MODEL') },
    vercel: { tokenFile: keyFileOk(vercelTokenFile) ? vercelTokenFile : null, team: env('VERCEL_TEAM') },
    dailyCapUsd: cap,
    rp: { id: env('CAMBRIAN_RP_ID'), origin: env('CAMBRIAN_ORIGIN') },   // override data/council.json's site when served on another host
    // EXPOSED: the app is reachable from outside this machine (through a tunnel that forwards to 127.0.0.1).
    // Then guests may only read. Proposing an idea needs an enrolled council member's passkey; enrolment and approval work as usual.
    exposed: env('CAMBRIAN_EXPOSED') === '1',
    publish: { remote: env('PUBLISH_REMOTE'), tokenFile: env('PUBLISH_TOKEN_FILE') },   // where GREEN build branches are also pushed
    // The contract that logs record hashes: from the environment, else the committed data/chain.json, else none.
    chain: env('NEAR_RECEIPTS_CONTRACT') ? { network: env('NEAR_NETWORK', 'testnet'), contract: env('NEAR_RECEIPTS_CONTRACT') }
      : committedChain(join(data, 'chain.json')),
    files: {
      council: join(data, 'council.json'), stake: join(data, 'stake.json'), products: join(data, 'products.json'),
      lessons: join(ROOT, 'lessons', 'lessons.json'), talk: join(data, 'talk.json'),
      tickets: join(data, 'tickets'), runs: join(data, 'runs'), invites: join(state, 'invites.json'),
    },
  };
}
