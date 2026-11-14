#!/usr/bin/env node
// Checks, WITHOUT ANY KEY, that a receipt hash was recorded on NEAR by the expected account.
// Read-only: it asks a public RPC node four questions and signs or sends nothing.
//
//   node scripts/verify-receipt.mjs --network <mainnet|testnet> --contract <account> \
//     --signer <expected recorder account> --tx <transaction hash> --hash <64 lowercase hex>
//   node scripts/verify-receipt.mjs --onchain <file written by record-receipt --out> [--signer <account>]
//
// What a full pass means:
//   - the transaction exists, is final, and was signed by the expected recorder account;
//   - it is one FunctionCall record_receipt to the contract, its args are exactly the 32 bytes of
//     the hash, and it carries no deposit;
//   - the call succeeded and its log is exactly the one receipt event line for that hash;
//   - the code on the contract account right now is the committed contracts/receipts.wasm.
//
// Honest limits:
//   - The contract is log-only and keeps no state. There is no view call that "gets" a receipt:
//     the record is the transaction, so the transaction hash is needed to find it.
//   - Ordinary nodes forget old transactions (after a few days). For an old record pass an
//     archival node with --rpc-url; an unknown transaction is reported as a FAIL with that hint.
//   - The contract lets anyone log any hash. The --signer check is what gives a record meaning.
//     With --onchain alone the expected signer is the recorder that data/chain.json names for that
//     contract, never the signer written in the file under check. For a contract data/chain.json
//     does not name, --signer is required.
//   - The code hash is the account's CURRENT code, not the code at the time of the transaction.
//   - The answers are the RPC node's. This script does not verify light-client proofs.
//
// Exit codes: 0 every check passed, 1 a check failed, 2 bad arguments, 3 [skip] (no answer from the
// node, or not final yet): a skip is not a pass.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { base58Decode, chainId, compareCodeHash, receiptEventLine, rpcUrlFor, txStatus } from '../near/rpc.mjs';

// Ordinary nodes forget a transaction after a few days. data/chain.json names a public archival node for this network; it is
// used when no --rpc-url is given, so an old record still checks.
function committedRpc(network) {
  try {
    const c = JSON.parse(readFileSync(new URL('../data/chain.json', import.meta.url), 'utf8'));
    return c.network === network && typeof c.rpc_url === 'string' ? c.rpc_url : null;
  } catch { return null; }
}

// The recorder this repository names for a contract: the account whose signature gives a logged hash its meaning.
function committedChain() {
  try { return JSON.parse(readFileSync(new URL('../data/chain.json', import.meta.url), 'utf8')); } catch { return null; }
}

const WASM_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'receipts.wasm');
const RECORD_METHOD = 'record_receipt';
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;

// The checks, in the order they are printed. Every result lists all of them.
export const CHECKS = Object.freeze([
  'node serves the chosen network',
  'transaction found and final',
  'signed by the expected recorder',
  'sent to the receipts contract',
  'one FunctionCall record_receipt',
  'args are the 32 bytes of the hash',
  'no deposit',
  'execution succeeded',
  'log is exactly the receipt event',
  'deployed code is the committed wasm',
]);

function validate({ network, contract, signer, txHash, hash }) {
  if (network !== 'mainnet' && network !== 'testnet') return `network must be mainnet or testnet, not "${network}"`;
  for (const [what, id] of [['contract', contract], ['signer', signer]]) {
    if (!ACCOUNT_ID.test(String(id))) return `${what} "${id}" is not a NEAR account id`;
  }
  if (!SHA256_HEX.test(String(hash))) return 'hash must be 64 lowercase hex characters';
  try {
    if (base58Decode(String(txHash)).length !== 32) return 'tx must be a transaction hash (base58 of 32 bytes)';
  } catch {
    return 'tx must be a transaction hash (base58 of 32 bytes)';
  }
  return null;
}

/**
 * The whole check. → { ok, skipped?, checks: [{ name, ok, skipped?, detail }], why }.
 * ok is true only when every check passed. skipped:true means nothing failed but something could
 * not be read (node unreachable, not final yet, no wasm): not a pass, not a failure.
 * wasmBytes defaults to the committed contracts/receipts.wasm.
 */
export async function verifyOnChain({ network, contract, signer, txHash, hash, rpcUrl, wasmBytes, fetchImpl, timeoutMs }) {
  const bad = validate({ network, contract, signer, txHash, hash });
  if (bad) return { ok: false, invalid: true, checks: [], why: bad };
  const url = rpcUrl || committedRpc(network) || rpcUrlFor(network);
  const net = { rpcUrl: url, fetchImpl, timeoutMs };

  const results = new Map();
  const pass = (i, detail) => results.set(CHECKS[i], { ok: true, detail });
  const fail = (i, detail) => results.set(CHECKS[i], { ok: false, detail });
  const skip = (i, detail) => results.set(CHECKS[i], { ok: false, skipped: true, detail });
  const check = (i, good, yes, no) => (good ? pass(i, yes) : fail(i, no));
  const finish = () => {
    const checks = CHECKS.map((name) => ({ name, ...(results.get(name) || { ok: false, skipped: true, detail: 'not checked' }) }));
    const failed = checks.filter((c) => !c.ok && !c.skipped);
    const skipped = checks.filter((c) => c.skipped);
    if (failed.length) return { ok: false, checks, why: `${failed[0].name}: ${failed[0].detail}` };
    if (skipped.length) return { ok: false, skipped: true, checks, why: `${skipped[0].name}: ${skipped[0].detail}` };
    return { ok: true, checks, why: `receipt ${hash} was recorded by ${signer} in tx ${txHash}` };
  };

  // 1. the node serves the network we were asked about
  const chain = await chainId(net);
  if (!chain.ok) {
    if (chain.offline) skip(0, chain.why);
    else fail(0, chain.why);
    return finish();
  }
  if (chain.chain_id !== network) {
    fail(0, `${url} serves chain "${chain.chain_id}", not "${network}"`);
    return finish();
  }
  pass(0, `${url} serves "${network}"`);

  // 2-9. the transaction and its outcomes
  const status = await txStatus({ ...net, txHash, senderId: signer });
  if (!status.ok) {
    if (status.offline) skip(1, status.why);
    else if (status.unknown) fail(1, `${status.why} (an old transaction needs an archival node: --rpc-url)`);
    else fail(1, status.why);
  } else {
    checkTransaction(status.result, { contract, signer, txHash, hash, pass, fail, skip, check });
  }

  // 10. the code on the contract account
  let wasm = wasmBytes;
  if (wasm === undefined && existsSync(WASM_PATH)) wasm = readFileSync(WASM_PATH);
  if (wasm === undefined) skip(9, 'contracts/receipts.wasm has not been built');
  else {
    const code = await compareCodeHash({ ...net, accountId: contract, wasmBytes: wasm });
    if (!code.ok) (code.offline ? skip : fail)(9, code.why);
    else check(9, code.match, `${contract} runs ${code.onchain}`, code.why);
  }
  return finish();
}

/** Checks 2 to 9 against one transaction status as the node reports it. */
function checkTransaction(result, { contract, signer, txHash, hash, pass, fail, skip, check }) {
  const tx = result.transaction;
  if (tx.hash !== txHash) return fail(1, `the node answered with transaction ${tx.hash}, not ${txHash}`);
  const finality = result.final_execution_status;
  if (finality !== 'FINAL') skip(1, `transaction found but not final yet (${finality}); try again shortly`);
  else pass(1, `tx ${txHash} is FINAL`);

  check(2, tx.signer_id === signer, `signer_id is ${signer}`, `signer_id is ${tx.signer_id}, not ${signer}`);
  check(3, tx.receiver_id === contract, `receiver_id is ${contract}`, `receiver_id is ${tx.receiver_id}, not ${contract}`);

  const actions = Array.isArray(tx.actions) ? tx.actions : [];
  const call = actions.length === 1 && actions[0] && typeof actions[0] === 'object' ? actions[0].FunctionCall : null;
  if (!call) {
    const shown = actions.map((a) => (typeof a === 'string' ? a : Object.keys(a || {}).join('+'))).join(', ') || 'none';
    fail(4, `expected exactly one FunctionCall action, found: ${shown}`);
    skip(5, 'not checked: no single FunctionCall');
    skip(6, 'not checked: no single FunctionCall');
  } else {
    check(4, call.method_name === RECORD_METHOD, `method_name is ${RECORD_METHOD}`, `method_name is ${call.method_name}`);
    const args = typeof call.args === 'string' ? Buffer.from(call.args, 'base64') : Buffer.alloc(0);
    const same = args.length === 32 && args.toString('hex') === hash;
    check(5, same, `args are ${hash}`, `args are ${args.length} bytes: ${args.toString('hex').slice(0, 80)}`);
    check(6, String(call.deposit) === '0', 'deposit is 0', `deposit is ${call.deposit}`);
  }

  // The FunctionCall runs in the first receipt the transaction created; its outcome has the logs.
  const firstReceiptId = result.transaction_outcome?.outcome?.receipt_ids?.[0];
  const entry = result.receipts_outcome.find((o) => o && o.id === firstReceiptId);
  const outcome = entry?.outcome;
  if (!firstReceiptId || !outcome) {
    fail(7, 'the node reported no outcome for the call');
    return skip(8, 'not checked: no outcome');
  }
  const succeeded =
    result.status?.SuccessValue !== undefined && outcome.status?.SuccessValue !== undefined && outcome.executor_id === contract;
  const whyNot =
    outcome.executor_id !== contract
      ? `the call ran on ${outcome.executor_id}, not ${contract}`
      : `status ${JSON.stringify(result.status?.Failure ?? outcome.status ?? result.status)}`;
  check(7, succeeded, `receipt ${firstReceiptId} succeeded on ${contract}`, whyNot);

  const line = receiptEventLine(hash);
  const logs = Array.isArray(outcome.logs) ? outcome.logs : [];
  const exact = logs.length === 1 && logs[0] === line;
  const found = logs.length ? `${logs.length} log line(s), first: ${String(logs[0]).slice(0, 160)}` : 'no log line';
  check(8, exact, line, `expected exactly one line ${line}; found ${found}`);
}

// ---- command line ------------------------------------------------------------------------------

export function usage() {
  return [
    'verify-receipt: check without any key that a receipt hash was recorded by the expected account.',
    '',
    'usage: node scripts/verify-receipt.mjs --network mainnet|testnet --contract <account>',
    '         --signer <expected recorder account> --tx <transaction hash> --hash <64 lowercase hex>',
    '         [--rpc-url <url>]',
    '   or: node scripts/verify-receipt.mjs --onchain <file> [--signer <account>] [--rpc-url <url>]',
    '',
    '  --onchain  a JSON file with { network, contract, signer, tx_hash, receipt_sha256 }, as',
    '             record-receipt --out writes it. The expected signer is the recorder data/chain.json names',
    '             for that contract, not the one in the file; for another contract pass --signer.',
    '             A flag given next to it must agree with the file.',
    '  --rpc-url  another node; an archival one is needed once the transaction is a few days old.',
    '',
    'Read-only. Exit 0: every check passed. 1: a check failed. 2: bad arguments. 3: [skip], the node',
    'did not answer or the transaction is not final yet. A skip is not a pass.',
  ].join('\n');
}

const VALUE_FLAGS = ['--network', '--contract', '--signer', '--tx', '--hash', '--onchain', '--rpc-url'];
// flag → the field of the --onchain file that carries the same value
const FILE_FIELDS = {
  '--network': 'network',
  '--contract': 'contract',
  '--signer': 'signer',
  '--tx': 'tx_hash',
  '--hash': 'receipt_sha256',
};

/** argv → { ok, input } or { ok: false, why }. Reads the --onchain file when one is given. */
export function parseArgs(argv, { readFile = (path) => readFileSync(path, 'utf8'), chain = committedChain() } = {}) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--help') return { ok: true, help: true };
    if (!VALUE_FLAGS.includes(flag)) return { ok: false, why: `unknown argument ${flag}` };
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) return { ok: false, why: `${flag} needs a value` };
    opts[flag] = value;
  }
  const values = {};
  if (opts['--onchain']) {
    let file;
    try {
      file = JSON.parse(readFile(opts['--onchain']));
    } catch (err) {
      return { ok: false, why: `cannot read ${opts['--onchain']}: ${err.message}` };
    }
    if (!file || typeof file !== 'object') return { ok: false, why: `${opts['--onchain']} is not a JSON object` };
    for (const [flag, field] of Object.entries(FILE_FIELDS)) {
      if (typeof file[field] === 'string') values[flag] = file[field];
      // The file says what was recorded; a flag says what the reader expects. They must not differ.
      if (opts[flag] !== undefined && values[flag] !== undefined && opts[flag] !== values[flag]) {
        const why = `${flag} ${opts[flag]} does not agree with ${field} "${values[flag]}" in the file`;
        return { ok: false, mismatch: true, why };
      }
    }
    // Who should have signed is not for the file under check to say. Without --signer it is the recorder data/chain.json
    // names for this contract; a file that names another account fails here, before any request.
    if (opts['--signer'] === undefined && values['--network'] !== undefined && values['--contract'] !== undefined) {
      const named = chain && chain.network === values['--network'] && chain.contract === values['--contract']
        && typeof chain.recorder === 'string' ? chain.recorder : null;
      if (!named) {
        return { ok: false, why: 'data/chain.json names no recorder for this contract: pass --signer with the account you expect' };
      }
      if (values['--signer'] !== undefined && values['--signer'] !== named) {
        const why = `signer "${values['--signer']}" in the file is not the recorder data/chain.json names for this contract, ${named}`;
        return { ok: false, mismatch: true, why };
      }
      values['--signer'] = named;
    }
  }
  for (const flag of Object.keys(FILE_FIELDS)) if (opts[flag] !== undefined) values[flag] = opts[flag];
  const missing = Object.keys(FILE_FIELDS).filter((flag) => values[flag] === undefined);
  if (missing.length) return { ok: false, why: `missing ${missing.join(', ')}` };
  return {
    ok: true,
    input: {
      network: values['--network'],
      contract: values['--contract'],
      signer: values['--signer'],
      txHash: values['--tx'],
      hash: values['--hash'],
      rpcUrl: opts['--rpc-url'],
    },
  };
}

/** The whole command. Returns the exit code; prints through `out`. */
export async function runCli(argv, { fetchImpl = globalThis.fetch, out = console.log, readFile, chain, wasmBytes, timeoutMs } = {}) {
  const parsed = parseArgs(argv, { ...(readFile ? { readFile } : {}), ...(chain !== undefined ? { chain } : {}) });
  if (parsed.ok && parsed.help) {
    out(usage());
    return 0;
  }
  if (!parsed.ok) {
    // A flag that contradicts the file is a failed verification, not a typing mistake.
    if (parsed.mismatch) {
      out(`[FAIL] ${parsed.why}`);
      return 1;
    }
    out(`[refused] ${parsed.why}\n\n${usage()}`);
    return 2;
  }
  const input = parsed.input;
  const result = await verifyOnChain({ ...input, wasmBytes, fetchImpl, timeoutMs });
  if (result.invalid) {
    out(`[refused] ${result.why}`);
    return 2;
  }
  out(`receipt   ${input.hash}`);
  out(`recorder  ${input.signer} (expected signer)`);
  out(`contract  ${input.contract} on ${input.network}`);
  out(`tx        ${input.txHash}`);
  result.checks.forEach((c, i) => {
    const mark = c.ok ? '[ok]  ' : c.skipped ? '[skip]' : '[FAIL]';
    out(`${String(i + 1).padStart(2)}. ${mark} ${c.name}: ${c.detail}`);
  });
  if (result.ok) {
    out(`[ok] ${result.why}`);
    return 0;
  }
  if (result.skipped) {
    out(`[skip] not verified: ${result.why}`);
    return 3;
  }
  out(`[FAIL] ${result.why}`);
  return 1;
}

const runDirectly = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (runDirectly) process.exitCode = await runCli(process.argv.slice(2));
