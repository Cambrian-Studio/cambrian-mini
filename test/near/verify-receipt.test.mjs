// The keyless verify, offline: a stand-in node answers `status`, `tx` and `view_account`.
// The answer shape is the one a public mainnet node gives for `tx` (fields trimmed to what is read).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { receiptEventLine, wasmCodeHash } from '../../near/rpc.mjs';
import { CHECKS, parseArgs, runCli, verifyOnChain } from '../../scripts/verify-receipt.mjs';
import { stubRpc } from './rpc-stub.test.mjs';

const HASH = '9f86d081884c7d659a2feae0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const OTHER_HASH = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const TX = 'Fo3MJ9XzKjnKuDuQKhDAC6fra5H2UWawRejFSEpPNk3Y';
const RECEIPT_ID = 'J32NiaMfc9Pa2rJkLHRbj8B88VGhB4rN9GMatqtoqBh7';
const ARGS_B64 = Buffer.from(HASH, 'hex').toString('base64'); // the 32 raw bytes, as a node shows them
const WASM = Buffer.from('0061736d01000000', 'hex'); // stands in for the committed wasm
const INPUT = { network: 'mainnet', contract: 'receipts.example.near', signer: 'recorder.example.near', txHash: TX, hash: HASH };

/** A correct, final record_receipt transaction as a node reports it. `change` edits a deep copy. */
function goodStatus(change = () => {}) {
  const status = {
    final_execution_status: 'FINAL',
    status: { SuccessValue: '' },
    transaction: {
      signer_id: INPUT.signer,
      public_key: 'ed25519:Anu7LYDfpLtkP7E16LT9imXF694BdQaa9ufVkQiwTQxC',
      nonce: 42,
      receiver_id: INPUT.contract,
      actions: [{ FunctionCall: { method_name: 'record_receipt', args: ARGS_B64, gas: 30000000000000, deposit: '0' } }],
      hash: TX,
    },
    transaction_outcome: {
      id: TX,
      block_hash: 'FDNwePh6H5ZzMm1X1SdTsq55wSFEZ4Le5FoVyFDk4H2E',
      outcome: { executor_id: INPUT.signer, logs: [], receipt_ids: [RECEIPT_ID], status: { SuccessReceiptId: RECEIPT_ID } },
    },
    receipts_outcome: [
      {
        id: RECEIPT_ID,
        block_hash: 'HfxbFy8WEFZVv3jxSFsfyuaiWt3hzVSzGDkot2hcwSdJ',
        outcome: { executor_id: INPUT.contract, logs: [receiptEventLine(HASH)], receipt_ids: ['refund'], status: { SuccessValue: '' } },
      },
      // the gas refund to the signer: a second outcome with no logs
      { id: 'refund', block_hash: 'x', outcome: { executor_id: INPUT.signer, logs: [], receipt_ids: [], status: { SuccessValue: '' } } },
    ],
  };
  change(status);
  return status;
}

function node({ change, chain = 'mainnet', codeHash = wasmCodeHash(WASM), tx } = {}) {
  return stubRpc({
    status: () => ({ result: { chain_id: chain } }),
    tx: tx || (() => ({ result: goodStatus(change) })),
    'query:view_account': () => ({ result: { code_hash: codeHash, block_height: 9 } }),
  });
}

const verify = (stub, over = {}) => verifyOnChain({ ...INPUT, wasmBytes: WASM, fetchImpl: stub.fetchImpl, timeoutMs: 500, ...over });
const failedNames = (result) => result.checks.filter((c) => !c.ok && !c.skipped).map((c) => c.name);

test('a correct record passes every check, using only read-only requests', async () => {
  const stub = node();
  const result = await verify(stub);
  assert.equal(result.ok, true, result.why);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(result.checks.map((c) => c.name), [...CHECKS]);
  assert.ok(result.checks.every((c) => c.ok === true && !c.skipped && typeof c.detail === 'string'));
  assert.match(result.why, /was recorded by recorder\.example\.near in tx /);

  assert.deepEqual(stub.calls.map((c) => (c.method === 'query' ? c.params.request_type : c.method)), ['status', 'tx', 'view_account']);
  assert.deepEqual(stub.calls[1].params, { tx_hash: TX, sender_account_id: INPUT.signer, wait_until: 'NONE' });
  assert.equal(stub.calls[2].params.account_id, INPUT.contract);
});

// Each wrong thing fails exactly the check that is about it. The correct record above is the
// other direction. Rows: title, the change to the node's answer, the failing check, its detail.
const call = (s) => s.transaction.actions[0].FunctionCall;
const REFUSALS = [
  ['wrong signer', (s) => (s.transaction.signer_id = 'stranger.near'), 'signed by the expected recorder', /signer_id is stranger\.near/],
  [
    'wrong receiver',
    (s) => (s.transaction.receiver_id = 'elsewhere.near'),
    'sent to the receipts contract',
    /receiver_id is elsewhere\.near/,
  ],
  ['wrong method', (s) => (call(s).method_name = 'record'), 'one FunctionCall record_receipt', /method_name is record$/],
  [
    'args are another hash',
    (s) => (call(s).args = Buffer.from(OTHER_HASH, 'hex').toString('base64')),
    'args are the 32 bytes of the hash',
    /args are 32 bytes: e3b0c442/,
  ],
  [
    'args are the hex text, not the bytes',
    (s) => (call(s).args = Buffer.from(HASH, 'utf8').toString('base64')),
    'args are the 32 bytes of the hash',
    /args are 64 bytes/,
  ],
  ['a deposit', (s) => (call(s).deposit = '1'), 'no deposit', /deposit is 1/],
  [
    'a failed execution',
    (s) => {
      s.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } } };
      s.receipts_outcome[0].outcome.status = { Failure: s.status.Failure };
    },
    'execution succeeded',
    /Smart contract panicked/,
  ],
  ['a missing log line', (s) => (s.receipts_outcome[0].outcome.logs = []), 'log is exactly the receipt event', /found no log line/],
  [
    'a log line for another hash',
    (s) => (s.receipts_outcome[0].outcome.logs = [receiptEventLine(OTHER_HASH)]),
    'log is exactly the receipt event',
    /found 1 log line/,
  ],
  [
    'an extra log line next to the right one',
    (s) => s.receipts_outcome[0].outcome.logs.push('something else'),
    'log is exactly the receipt event',
    /found 2 log line/,
  ],
  [
    'the right log line, but only in some other receipt',
    (s) => {
      s.receipts_outcome[1].outcome.logs = s.receipts_outcome[0].outcome.logs;
      s.receipts_outcome[0].outcome.logs = [];
    },
    'log is exactly the receipt event',
    /found no log line/,
  ],
  [
    'the call ran on another account',
    (s) => (s.receipts_outcome[0].outcome.executor_id = 'elsewhere.near'),
    'execution succeeded',
    /ran on elsewhere\.near/,
  ],
  [
    'a second action next to the call',
    (s) => s.transaction.actions.push({ Transfer: { deposit: '1' } }),
    'one FunctionCall record_receipt',
    /found: FunctionCall, Transfer/,
  ],
  [
    'a transfer instead of a call',
    (s) => (s.transaction.actions = [{ Transfer: { deposit: '1' } }]),
    'one FunctionCall record_receipt',
    /found: Transfer/,
  ],
  [
    'an answer about another transaction',
    (s) => (s.transaction.hash = RECEIPT_ID),
    'transaction found and final',
    /answered with transaction/,
  ],
];

for (const [title, change, checkName, detail] of REFUSALS) {
  test(`refuses: ${title}`, async () => {
    const result = await verify(node({ change }));
    assert.equal(result.ok, false);
    assert.equal(result.skipped, undefined, 'a mismatch is a failure, not a skip');
    assert.deepEqual(failedNames(result), [checkName]);
    assert.match(result.checks.find((c) => c.name === checkName).detail, detail);
    assert.ok(result.why.startsWith(`${checkName}: `));
  });
}

test('refuses: the contract account runs other code, or no code', async () => {
  const other = await verify(node({ codeHash: wasmCodeHash(Buffer.concat([WASM, Buffer.from([0])])) }));
  assert.equal(other.ok, false);
  assert.deepEqual(failedNames(other), ['deployed code is the committed wasm']);
  assert.match(other.why, /is not the committed wasm/);

  const none = await verify(node({ codeHash: '1'.repeat(32) }));
  assert.deepEqual(failedNames(none), ['deployed code is the committed wasm']);
  assert.match(none.why, /no contract is deployed/);
});

test('refuses: an unknown transaction (with the archival hint) and a node on another chain', async () => {
  const unknown = node({
    tx: () => ({
      error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' }, code: -32000, data: `Transaction ${TX} doesn't exist` },
    }),
  });
  const a = await verify(unknown);
  assert.equal(a.ok, false);
  assert.equal(a.skipped, undefined);
  assert.deepEqual(failedNames(a), ['transaction found and final']);
  assert.match(a.why, /doesn't exist \(an old transaction needs an archival node: --rpc-url\)/);

  const testnetNode = node({ chain: 'testnet' });
  const b = await verify(testnetNode);
  assert.deepEqual(failedNames(b), ['node serves the chosen network']);
  assert.match(b.why, /serves chain "testnet", not "mainnet"/);
  assert.deepEqual(testnetNode.calls.map((c) => c.method), ['status'], 'nothing else is asked of a node on the wrong chain');
});

test('skip, never a pass: unreachable node, a node that goes away half way, a transaction that is not final', async () => {
  const down = {
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
  };
  const a = await verify(down);
  assert.equal(a.ok, false);
  assert.equal(a.skipped, true);
  assert.equal(a.checks.length, CHECKS.length);
  assert.ok(a.checks.every((c) => c.ok === false && c.skipped === true));
  assert.match(a.why, /cannot reach /);

  // The transaction is fine but the code hash cannot be read: still not a pass.
  const good = node();
  const halfway = {
    fetchImpl: async (url, init) => {
      if (JSON.parse(init.body).method === 'query') throw new TypeError('fetch failed');
      return good.fetchImpl(url, init);
    },
  };
  const b = await verify(halfway);
  assert.equal(b.ok, false);
  assert.equal(b.skipped, true);
  assert.deepEqual(b.checks.filter((c) => c.skipped).map((c) => c.name), ['deployed code is the committed wasm']);

  const pending = await verify(node({ change: (s) => (s.final_execution_status = 'EXECUTED_OPTIMISTIC') }));
  assert.equal(pending.ok, false);
  assert.equal(pending.skipped, true);
  assert.match(pending.why, /not final yet \(EXECUTED_OPTIMISTIC\)/);

  const busy = await verify(node({ tx: () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, data: 'Timeout' } }) }));
  assert.equal(busy.skipped, true);

  // A failure wins over a skip: wrong signer and no code hash answer is a FAIL.
  const wrong = node({ change: (s) => (s.transaction.signer_id = 'stranger.near') });
  const both = await verify({
    fetchImpl: async (url, init) => {
      if (JSON.parse(init.body).method === 'query') throw new TypeError('fetch failed');
      return wrong.fetchImpl(url, init);
    },
  });
  assert.equal(both.ok, false);
  assert.equal(both.skipped, undefined);
});

test('bad input is refused before any request', async () => {
  const never = { fetchImpl: async () => assert.fail('no request expected') };
  const cases = [
    [{ hash: HASH.toUpperCase() }, /64 lowercase hex/],
    [{ hash: HASH.slice(2) }, /64 lowercase hex/],
    [{ network: 'betanet' }, /mainnet or testnet/],
    [{ signer: 'Not An Account' }, /signer .* is not a NEAR account id/],
    [{ contract: '' }, /contract .* is not a NEAR account id/],
    [{ txHash: 'not-base58-0OIl' }, /transaction hash/],
    [{ txHash: 'abc' }, /transaction hash/],
  ];
  for (const [over, why] of cases) {
    const result = await verify(never, over);
    assert.equal(result.ok, false);
    assert.equal(result.invalid, true);
    assert.match(result.why, why);
  }
});

// ---- command line ------------------------------------------------------------------------------

const FLAGS = ['--network', 'mainnet', '--contract', INPUT.contract, '--signer', INPUT.signer, '--tx', TX, '--hash', HASH];
const ONCHAIN = {
  network: 'mainnet',
  contract: INPUT.contract,
  signer: INPUT.signer,
  tx_hash: TX,
  receipt_sha256: HASH,
  block_hash: 'FDNwePh6H5ZzMm1X1SdTsq55wSFEZ4Le5FoVyFDk4H2E',
  recorded_at: '2026-01-01T00:00:00.000Z',
};

// what this repository's data/chain.json would say for the fixture contract
const CHAIN = { network: 'mainnet', contract: INPUT.contract, recorder: INPUT.signer };
async function cli(argv, { stub = node(), file = ONCHAIN, chain = CHAIN } = {}) {
  const lines = [];
  const code = await runCli(argv, {
    fetchImpl: stub.fetchImpl,
    out: (line) => lines.push(line),
    readFile: () => (typeof file === 'string' ? file : JSON.stringify(file)),
    chain,
    wasmBytes: WASM,
    timeoutMs: 500,
  });
  return { code, text: lines.join('\n'), lines };
}

test('cli: a correct record prints ten numbered [ok] lines and exits 0', async () => {
  const { code, lines, text } = await cli(FLAGS);
  assert.equal(code, 0, text);
  const numbered = lines.filter((l) => /^ ?\d+\. /.test(l));
  assert.equal(numbered.length, CHECKS.length);
  numbered.forEach((line, i) => assert.ok(line.startsWith(`${String(i + 1).padStart(2)}. [ok]   ${CHECKS[i]}: `), line));
  assert.match(lines.at(-1), /^\[ok\] receipt 9f86d081.* was recorded by recorder\.example\.near in tx /);
});

test('cli: a mismatch prints [FAIL] and exits 1; an unreachable node prints [skip] and exits 3', async () => {
  const wrong = await cli(FLAGS, { stub: node({ change: (s) => (s.transaction.signer_id = 'stranger.near') }) });
  assert.equal(wrong.code, 1);
  assert.match(wrong.text, /^ 3\. \[FAIL\] signed by the expected recorder: signer_id is stranger\.near, not recorder\.example\.near$/m);
  assert.match(wrong.lines.at(-1), /^\[FAIL\] signed by the expected recorder/);
  assert.doesNotMatch(wrong.text, /^\[ok\]/m);

  const down = await cli(FLAGS, {
    stub: {
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    },
  });
  assert.equal(down.code, 3);
  assert.match(down.text, /^ 1\. \[skip\] node serves the chosen network: cannot reach /m);
  assert.match(down.lines.at(-1), /^\[skip\] not verified: /);
  assert.doesNotMatch(down.text, /\[ok\]/);
});

test('cli --onchain: reads the five fields from the file; a flag that disagrees with the file is a FAIL', async () => {
  const fromFile = await cli(['--onchain', 'onchain.json']);
  assert.equal(fromFile.code, 0, fromFile.text);

  const pinned = await cli(['--onchain', 'onchain.json', '--signer', INPUT.signer]);
  assert.equal(pinned.code, 0, pinned.text);

  const stub = node();
  const disagree = await cli(['--onchain', 'onchain.json', '--signer', 'someone-else.near'], { stub });
  assert.equal(disagree.code, 1);
  assert.match(disagree.text, /^\[FAIL\] --signer someone-else\.near does not agree with signer "recorder\.example\.near" in the file$/);
  assert.equal(stub.calls.length, 0);

});

test('cli --onchain: the expected signer comes from data/chain.json, never from the file under check', async () => {
  // A stranger logs the same hash through the same contract and writes a file naming themselves. Checked against that file's
  // own signer it would pass; checked against the recorder the repository names, it fails, and no request is made.
  const stub = node({ change: (s) => (s.transaction.signer_id = 'stranger.near') });
  const forged = await cli(['--onchain', 'onchain.json'], { stub, file: { ...ONCHAIN, signer: 'stranger.near' } });
  assert.equal(forged.code, 1, forged.text);
  assert.match(forged.text, /^\[FAIL\] signer "stranger\.near" in the file is not the recorder data\/chain\.json names for this contract, recorder\.example\.near$/);
  assert.equal(stub.calls.length, 0);
  // a file with no signer at all is checked against the repository's recorder, and the chain check catches the stranger
  const { signer: _omit, ...bare } = ONCHAIN;
  const noSigner = await cli(['--onchain', 'onchain.json'], { stub: node({ change: (s) => (s.transaction.signer_id = 'stranger.near') }), file: bare });
  assert.equal(noSigner.code, 1);
  assert.match(noSigner.text, /\[FAIL\] signed by the expected recorder: signer_id is stranger\.near, not recorder\.example\.near/);
  assert.equal((await cli(['--onchain', 'onchain.json'], { file: bare })).code, 0, 'and passes when the recorder signed');
  // a contract the repository does not name: the reader must say whom they expect
  for (const chain of [null, { ...CHAIN, contract: 'other.example.near' }, { ...CHAIN, network: 'testnet' }, { ...CHAIN, recorder: undefined }]) {
    const unknown = await cli(['--onchain', 'onchain.json'], { chain });
    assert.equal(unknown.code, 2);
    assert.match(unknown.text, /^\[refused\] data\/chain\.json names no recorder for this contract: pass --signer/);
    assert.equal((await cli(['--onchain', 'onchain.json', '--signer', INPUT.signer], { chain })).code, 0, 'with --signer it is checked');
  }
  // the committed records: each names the recorder in data/chain.json, so each resolves with no flag
  const chain = JSON.parse(readFileSync(new URL('../../data/chain.json', import.meta.url), 'utf8'));
  for (const id of ['upread-mini-086cdf', 'postmark-6ee0a5']) {
    const p = parseArgs(['--onchain', fileURLToPath(new URL(`../../data/runs/${id}/onchain.json`, import.meta.url))]);
    assert.equal(p.ok && p.input.signer, chain.recorder, id);
  }
});

test('cli: missing or unknown arguments and an unreadable file are refused with exit 2, no request made', async () => {
  const never = { fetchImpl: async () => assert.fail('no request expected') };
  for (const drop of ['--network', '--contract', '--signer', '--tx', '--hash']) {
    const argv = FLAGS.filter((_, i) => FLAGS[i - (i % 2)] !== drop);
    const { code, text } = await cli(argv, { stub: never });
    assert.equal(code, 2, drop);
    assert.match(text, new RegExp(`\\[refused\\] missing ${drop}`));
  }
  assert.equal((await cli([...FLAGS, '--sign'], { stub: never })).code, 2);
  assert.equal((await cli(['--onchain', 'x.json'], { stub: never, file: 'not json' })).code, 2);
  const thin = await cli(['--onchain', 'x.json'], { stub: never, file: { network: 'mainnet' } });
  assert.match(thin.text, /missing --contract, --signer, --tx, --hash/);
  assert.equal((await cli(FLAGS.map((v) => (v === HASH ? 'xyz' : v)), { stub: never })).code, 2);
  assert.equal((await cli(['--help'], { stub: never })).code, 0);
  assert.equal(parseArgs(FLAGS).input.txHash, TX);
});

test('a rate-limited node is a skip with the reason, exit 3, never a FAIL; a wrong answer after it still fails', async () => {
  const { retry } = await import('../../near/rpc.mjs'); const keep = { ...retry }; retry.sleep = async () => {};
  try {
    const limit = { status: 200, json: async () => ({ error: { message: 'Rate limits exceeded. For higher rate limits get a subscription' } }) };
    const out = await cli(FLAGS, { stub: { fetchImpl: async () => limit } });
    assert.equal(out.code, 3, out.text);
    assert.match(out.text, /^ 1\. \[skip\] node serves the chosen network: rate limited by /m);
    assert.doesNotMatch(out.text, /\[FAIL\]|\[ok\]/);
    // limited twice, then the node answers, and what it answers is a transaction signed by someone else: that fails
    const stub = node({ change: (s) => (s.transaction.signer_id = 'stranger.near') }); let n = 0;
    const flaky = await cli(FLAGS, { stub: { fetchImpl: async (...a) => (n++ < 2 ? limit : stub.fetchImpl(...a)) } });
    assert.equal(flaky.code, 1, flaky.text);
    assert.match(flaky.text, /\[FAIL\] signed by the expected recorder: signer_id is stranger\.near/);
  } finally { Object.assign(retry, keep); }
});
