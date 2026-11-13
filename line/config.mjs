// config.mjs — where the line lives and what it may talk to. No secret is in here: the config names
// FILES that hold them; each is read at the moment of use and must be mode 600.
//
// loadConfig(overrides) takes an object (tests point every path at a scratch directory and every outside
// address at a loopback stand-in) or the path of a JSON file with the same keys. An unknown key is refused.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { budgetCapUsd } from '../tickets/ticket.mjs';

export const LINE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(LINE, '..');
export const KIT = join(LINE, 'kit');
const SECRETS = join(homedir(), '.cambrian-secrets');

function defaults(home) {
  return {
    offline: false, // true: a stand-in agent script instead of the model; nothing is metered
    home, // scratch, tools, product repositories, per-attempt artefacts; never committed
    scratch: join(home, 'scratch'), // per-run clone, worktree and check clones; the agent can write the worktree only
    tools: join(home, 'tools'), // the agent runtime (node_modules/.bin/opencode); read-only inside the sandbox
    records: join(REPO, 'data', 'runs'), // the committed record: <records>/<id>/run.json
    products_dir: join(home, 'products'), // default product repositories: one local bare repository per product
    product_remote: null, // (product) => git URL or path; null = <products_dir>/<product>.git, made on first use
    product_token_file: null, // only when product_remote is an https remote that needs a token (mode 600)
    publish_remote: null, // optional second remote that receives the same GREEN commit: a URL or (product) => URL
    publish_token_file: null, // its token (mode 600); reaches git only through kit/askpass.sh
    nearai_base: process.env.NEARAI_BASE ?? 'https://cloud-api.near.ai/v1',
    nearai_key_file: process.env.NEARAI_KEY_FILE ?? join(SECRETS, 'baby-nearai.key'),
    model: process.env.LINE_MODEL ?? 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
    model_context: 128000,
    model_output: 16000, // what the agent runtime is told about the model's window
    pricing_file: null, // a ready pricing table (tests); null = ask NEAR AI for it before each run
    notify: 'memory', // 'memory' returns each notification for the record; 'stdout' also prints it
    telegram_api: 'https://api.telegram.org',
    vercel_api: 'https://api.vercel.com',
    vercel_token_file: process.env.VERCEL_TOKEN_FILE ?? join(SECRETS, 'vercel.token'), // null or absent = no preview is attempted
    vercel_team: process.env.VERCEL_TEAM ?? null,
    preview_wait_seconds: 300,
    preview_poll_seconds: 3,
    bridge_port: null,
    proxy_port: null, // null = a free loopback port, picked for each attempt
    commit_name: 'cambrian-line',
    commit_email: 'cambrian-line@users.noreply.github.com',
    sandbox: null, // null = pick (kit/sandbox.mjs); 'none' = behave as if no sandbox exists
    stand_in: join(REPO, 'test', 'line', 'fixtures', 'stand-in'), // offline only: the stand-in agent and what it writes
    agent_stub: 'agent-stub.sh', // offline only: the script in stand_in that runs in place of the agent
    daily_ceiling_usd: 5,
    daily_cap_usd: null, // the app's daily cap when the operator raised it for the day; the ceiling may go up to it
    spend_fixture: null, // offline only: a JSON file {"spent_usd": n} read in place of the run records
    push_override: null, // offline only: { <ticket-id>: {branch, force, refspec} }, so tests see the push guard refuse
  };
}

export function loadConfig(over = process.env.LINE_CONFIG ?? {}) {
  const raw = typeof over === 'string' ? JSON.parse(readFileSync(over, 'utf8')) : (over ?? {});
  const given = Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)); // an undefined key means "the default"
  const home = resolve(given.home ?? process.env.CAMBRIAN_LINE_HOME ?? join(REPO, '.line'));
  const base = defaults(home);
  for (const k of Object.keys(given)) if (!(k in base)) throw new Error(`line config: unknown key '${k}'`);
  const c = { ...base, ...given, home };
  const cap = Math.max(budgetCapUsd(), Number.isFinite(c.daily_cap_usd) ? c.daily_cap_usd : 0);
  for (const k of ['agent_stub', 'spend_fixture', 'push_override']) {
    if (given[k] != null && !c.offline) throw new Error(`line config: ${k} is honoured only with offline:true`);
  }
  if (!['memory', 'stdout'].includes(c.notify)) throw new Error('line config: notify is memory or stdout');
  if (!(Number.isFinite(c.daily_ceiling_usd) && c.daily_ceiling_usd > 0 && c.daily_ceiling_usd <= cap)) {
    throw new Error(`line config: daily_ceiling_usd is above 0 and at most ${cap} (the daily cap)`);
  }
  if (c.product_remote != null && typeof c.product_remote !== 'function') {
    throw new Error('line config: product_remote is a function (product) => URL');
  }
  if (c.sandbox != null && !['none', 'sandbox-exec', 'bwrap', 'docker', 'podman'].includes(c.sandbox)) {
    throw new Error('line config: sandbox is none, sandbox-exec, bwrap, docker or podman');
  }
  if (!/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(String(c.nearai_base))) {
    throw new Error('line config: nearai_base is https (plain http only on loopback, for tests)');
  }
  return c;
}
