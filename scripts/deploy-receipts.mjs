// deploy-receipts.mjs — set the receipt contract up on NEAR, one transaction per step, each read back.
// A HUMAN decides when this runs; nothing in the app, the tests or CI calls it.
//
//   node scripts/deploy-receipts.mjs status            read-only: both accounts, their keys, the code hash
//   node scripts/deploy-receipts.mjs deploy            contract account: DeployContract(contracts/receipts.wasm)
//   node scripts/deploy-receipts.mjs add-recorder-key  recorder account: AddKey — a key for record_receipt on the contract only
//   node scripts/deploy-receipts.mjs lock-contract     contract account: DeleteKey of its only full-access key → immutable
//   node scripts/deploy-receipts.mjs lock-recorder     recorder account: DeleteKey of its full-access key → record_receipt only
//
// Options: --network mainnet|testnet (required), --contract-key <file>, --recorder-key <file>, --recorder-fc-key <file>
// (mode-600 JSON files: {account_id, public_key, private_key}); mainnet needs --i-am-a-human-and-approve-mainnet.
// Order matters and is enforced: lock-contract refuses unless the deployed code is the committed wasm;
// lock-recorder refuses unless the record_receipt-only key is already on the account. Both locks are irreversible.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadKeyFile, broadcastSigned, RECORD_METHOD, MAINNET_FLAG } from '../near/record.mjs';
import { rpcCall, rpcUrlFor, chainId, getAccessKey, compareCodeHash, wasmCodeHash } from '../near/rpc.mjs';
import { encodeDeployContract, encodeAddFunctionCallKey, encodeDeleteKey, signSelfTransaction } from '../near/admin.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2); const cmd = argv[0];
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i > 0 ? argv[i + 1] : null; };
const die = (msg, code = 2) => { console.error(msg); process.exit(code); };

const network = opt('network');
if (!['status', 'deploy', 'add-recorder-key', 'lock-contract', 'lock-recorder'].includes(cmd) || !['mainnet', 'testnet'].includes(network)) {
  die('usage: node scripts/deploy-receipts.mjs <status|deploy|add-recorder-key|lock-contract|lock-recorder> --network <mainnet|testnet>\n'
    + '       --contract-key <file> --recorder-key <file> --recorder-fc-key <file>');
}
if (cmd !== 'status' && network === 'mainnet' && !argv.includes(MAINNET_FLAG)) die(`refused: mainnet needs ${MAINNET_FLAG}`);
const rpcUrl = opt('rpc') ?? rpcUrlFor(network);
const load = (flag) => { const f = opt(flag); if (!f) die(`--${flag} <file> is required`); const r = loadKeyFile(f); if (!r.ok) die(r.why); return { ...r.key, file: f, accountId: JSON.parse(readFileSync(f, 'utf8')).account_id }; };
const contract = load('contract-key'), recorder = load('recorder-key'), fc = load('recorder-fc-key');
if (fc.accountId !== recorder.accountId) die('refused: the record_receipt key file names another account than the recorder key file');
const wasm = readFileSync(join(ROOT, 'contracts', 'receipts.wasm'));

const view = async (request) => { const a = await rpcCall({ rpcUrl, method: 'query', params: { finality: 'final', ...request } }); return a.ok ? a.result : { error: a.why }; };
const keysOf = async (accountId) => { const r = await view({ request_type: 'view_access_key_list', account_id: accountId }); return r.keys ?? null; };
const describe = (k) => `${k.public_key} ${k.access_key.permission === 'FullAccess' ? 'FULL ACCESS' : `function-call only → ${k.access_key.permission.FunctionCall.receiver_id} ${JSON.stringify(k.access_key.permission.FunctionCall.method_names)}`}`;

async function status() {
  for (const [name, a] of [['contract', contract.accountId], ['recorder', recorder.accountId]]) {
    const acc = await view({ request_type: 'view_account', account_id: a });
    if (acc.error || acc.amount === undefined) { console.log(`${name} ${a}: not on ${network} yet (${String(acc.error ?? 'no account').slice(0, 80)})`); continue; }
    console.log(`${name} ${a}: balance ${(Number(BigInt(acc.amount) / 10n ** 18n) / 1e6).toFixed(6)} NEAR, storage ${acc.storage_usage} bytes, code_hash ${acc.code_hash}`);
    for (const k of (await keysOf(a)) ?? []) console.log(`    key ${describe(k)}`);
    if ((await keysOf(a))?.length === 0) console.log('    no access keys: nobody can sign for this account');
  }
  console.log(`committed wasm code hash: ${wasmCodeHash(wasm)} (${wasm.length} bytes)`);
}

async function send(account, action, what) {
  const chain = await chainId({ rpcUrl }); if (!chain.ok || chain.chain_id !== network) die(`refused: the node does not serve ${network}`, 3);
  const access = await getAccessKey({ rpcUrl, accountId: account.accountId, publicKey: account.publicKey });
  if (!access.ok) die(`cannot read the signing key of ${account.accountId}: ${access.why}`, 3);
  const tx = signSelfTransaction({ accountId: account.accountId, key: account, nonce: access.nonce + 1n, blockHash: access.block_hash, action });
  console.log(`${what}: sending transaction ${tx.hash}`);
  const r = await broadcastSigned({ rpcUrl, signedBytes: tx.signedBytes });
  if (!r.ok) die(`${what}: FAILED — ${r.why}`, 1);
  console.log(`${what}: done, transaction ${tx.hash}`);
  return tx.hash;
}

if (cmd === 'status') await status();

if (cmd === 'deploy') {
  await send(contract, encodeDeployContract(wasm), 'deploy the committed wasm');
  const c = await compareCodeHash({ rpcUrl, accountId: contract.accountId, wasmBytes: wasm });
  if (!c.ok || !c.match) die(`read back: the account's code is NOT the committed wasm (${c.why ?? `${c.deployed} vs ${c.committed}`})`, 1);
  console.log(`read back: code_hash ${c.deployed} equals the committed wasm`);
}

if (cmd === 'add-recorder-key') {
  await send(recorder, encodeAddFunctionCallKey({ publicKey: fc.publicKey, receiverId: contract.accountId, methodNames: [RECORD_METHOD], allowance: null }), 'add the record_receipt-only key');
  await status();
}

if (cmd === 'lock-contract') {
  const c = await compareCodeHash({ rpcUrl, accountId: contract.accountId, wasmBytes: wasm });
  if (!c.ok || !c.match) die('refused: the contract account does not run the committed wasm; locking it now would freeze the wrong code');
  const keys = await keysOf(contract.accountId);
  if (!keys || keys.length !== 1 || keys[0].public_key !== contract.publicKey) die('refused: expected exactly one key on the contract account, the one in --contract-key');
  await send(contract, encodeDeleteKey(contract.publicKey), 'delete the contract account\'s only key');
  const after = await keysOf(contract.accountId);
  if (!after || after.length !== 0) die(`read back: the contract account still has ${after?.length ?? '?'} key(s)`, 1);
  console.log('read back: the contract account has NO access keys — its code can never be changed and nothing can be sent from it');
}

if (cmd === 'lock-recorder') {
  const keys = await keysOf(recorder.accountId);
  const good = keys?.find((k) => k.public_key === fc.publicKey);
  const p = good?.access_key?.permission?.FunctionCall;
  if (!p || p.receiver_id !== contract.accountId || JSON.stringify(p.method_names) !== JSON.stringify([RECORD_METHOD])) die('refused: the record_receipt-only key is not on the recorder account yet (run add-recorder-key first)');
  await send(recorder, encodeDeleteKey(recorder.publicKey), 'delete the recorder account\'s full-access key');
  const after = await keysOf(recorder.accountId);
  if (!after || after.length !== 1 || after[0].access_key.permission === 'FullAccess') die('read back: the recorder account does not hold exactly one function-call key', 1);
  console.log(`read back: the recorder account holds one key: ${describe(after[0])}`);
}
