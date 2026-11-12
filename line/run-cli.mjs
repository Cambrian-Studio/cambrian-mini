#!/usr/bin/env node
// run-cli.mjs — run one ticket from the command line, offline:
//
//   node line/run-cli.mjs --offline --ticket test/line/fixtures/tickets/facts-page-1.json
//
// Offline means: no model, no key, no spend. A throwaway TEST council is made in memory (software passkeys,
// approvals/test-authenticator.mjs), two of its three members sign the ticket, and a stand-in agent script
// writes the files. Everything else is the real line: the release check, the sandbox and its probe, the
// commit, the checks, the push guard, the run record and the receipt hash. The run lives in a scratch
// directory (printed at the end) unless --home says otherwise. --approvals 1 shows a refusal.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadConfig } from './config.mjs';
import { startRun } from './dispatch.mjs';
import { recheck } from './checks.mjs';
import { parseTicket } from '../tickets/ticket.mjs';
import { makeTestCouncil } from '../approvals/test-authenticator.mjs';

const arg = (k, d = null) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > 0 ? (process.argv[i + 1] ?? d) : d;
};
const has = (k) => process.argv.includes(`--${k}`);
if (!has('offline') || !arg('ticket')) {
  console.error(
    'usage: node line/run-cli.mjs --offline --ticket <file> [--approvals 0..3] [--home <dir>]\n' +
      'Only offline runs start here. A live run is started by the app, after two council members approve the ticket.',
  );
  process.exit(2);
}

const ticket = parseTicket(readFileSync(resolve(arg('ticket'))));
const home = resolve(arg('home') ?? mkdtempSync(join(tmpdir(), 'cambrian-offline-run-')));
const cfg = loadConfig({ offline: true, home, records: join(home, 'records'), notify: 'stdout' });
const { council, sign } = makeTestCouncil();
const signers = council.members.slice(0, Number(arg('approvals', '2'))).map((m) => m.id);
const approvals = signers.map((id) => sign(id, ticket));
console.log(
  `ticket ${ticket.id}: "${ticket.title}" — ${ticket.green.length} checks; test council, signed by ${signers.join(' and ') || 'nobody'}`,
);

const rec = await startRun(cfg, { ticket, approvals, council, hooks: { log: (id, line) => console.log(`  ${line}`) } });

console.log('\nstations');
for (const [name, s] of Object.entries(rec.stations)) {
  const extra = Object.entries(s).filter(([k, v]) => k !== 'at' && v !== null).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`  ${name.padEnd(9)} ${s.at}${extra ? '  ' + extra : ''}`);
}
console.log(`state     ${rec.state}${rec.waiting_on ? ' — ' + rec.waiting_on : ''}`);
if (rec.push?.pushed) {
  console.log(
    `pushed    ${rec.push.ref} @ ${rec.push.commit.slice(0, 10)}; main ${rec.main.untouched ? 'untouched' : 'NOT confirmed untouched'}`,
  );
}
if (/^green/.test(rec.state)) {
  const again = recheck({ ticket, outputDir: join(cfg.records, ticket.id, 'output') });
  const reread = again.checks.filter((c) => !c.skipped);
  console.log(
    `recheck   ${reread.filter((c) => c.pass).length} of ${reread.length} file checks pass again from the kept output (${
      again.checks.length - reread.length
    } run checks skipped)`,
  );
}
console.log(`receipt   sha256 ${rec.receipt_sha256 ?? '(no receipt module)'}`);
console.log(`record    ${join(cfg.records, ticket.id, 'run.json')}`);
process.exit(/^green/.test(rec.state) ? 0 : 1);
