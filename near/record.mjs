// Builds, signs and sends ONE kind of NEAR transaction: record_receipt on the log-only receipts
// contract. The call arguments are the 32 RAW BYTES of the receipt sha256 (not JSON, not hex).
// Zero dependencies: borsh layout, ed25519 (node:crypto) and base58 are all here or in rpc.mjs.
//
// What this file guarantees:
//   - the only transaction it can build has exactly one FunctionCall action, method record_receipt,
//     args = the 32 hash bytes, deposit 0;
//   - it refuses to sign with a FullAccess key: the key must be a function-call key limited to this
//     contract and to the method record_receipt (read from the chain before anything is signed);
//   - mainnet needs an explicit human flag; the node's chain id must match the chosen network;
//   - the key file must be mode 600 and the secret is never printed;
//   - it writes no file unless --out is given, and then only after the chain accepted the call.
//
// The contract keeps no state. The record IS the transaction: its signer, its args and the one log
// line in its outcome. scripts/verify-receipt.mjs reads all three back without any key.

import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';
import * as nodeFs from 'node:fs';
import { base58Decode, base58Encode, chainId, getAccessKey, receiptEventLine, rpcCall, rpcUrlFor } from './rpc.mjs';

export const RECORD_METHOD = 'record_receipt';
export const DEFAULT_GAS = 30_000_000_000_000n; // 30 Tgas, far more than one log line needs
export const MAINNET_FLAG = '--i-am-a-human-and-approve-mainnet';

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ACCOUNT_ID = /^(?=.{2,64}$)[a-z0-9]+([-_.][a-z0-9]+)*$/;

// ---- borsh -------------------------------------------------------------------------------------
// Layout (nearcore `Transaction`, the same one near-api-js serializes):
//   signer_id: string | public_key: u8 key type (0 = ed25519) + 32 bytes | nonce: u64 |
//   receiver_id: string | block_hash: 32 bytes | actions: u32 count + actions
// FunctionCall action: u8 tag 2 | method_name: string | args: u32 len + bytes | gas: u64 | deposit: u128
// Integers are little-endian; a string is a u32 byte length followed by UTF-8.

function uintLE(value, byteLength) {
  let v = BigInt(value);
  if (v < 0n || v >= 1n << BigInt(8 * byteLength)) throw new Error(`value ${value} does not fit in ${byteLength} bytes`);
  const out = new Uint8Array(byteLength);
  for (let i = 0; i < byteLength; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(parts) {
  return Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
}

function borshBytes(bytes) {
  return concat([uintLE(bytes.length, 4), bytes]);
}

function borshString(text) {
  return borshBytes(Buffer.from(text, 'utf8'));
}

/** "ed25519:<base58>" → the 32 raw public key bytes. */
export function publicKeyBytes(publicKey) {
  const [curve, encoded, ...rest] = String(publicKey).split(':');
  if (curve !== 'ed25519' || !encoded || rest.length) throw new Error('public key must look like ed25519:<base58>');
  const bytes = base58Decode(encoded);
  if (bytes.length !== 32) throw new Error('an ed25519 public key is 32 bytes');
  return bytes;
}

/** One FunctionCall action. args are the raw argument bytes, exactly as the contract will read them. */
export function encodeFunctionCall({ methodName, args, gas, deposit }) {
  return concat([Uint8Array.of(2), borshString(methodName), borshBytes(args), uintLE(gas, 8), uintLE(deposit, 16)]);
}

/** A transaction around already-encoded actions. blockHash is 32 raw bytes. */
export function encodeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actionBytes }) {
  if (blockHash.length !== 32) throw new Error('a block hash is 32 bytes');
  return concat([
    borshString(signerId),
    Uint8Array.of(0),
    publicKeyBytes(publicKey),
    uintLE(nonce, 8),
    borshString(receiverId),
    blockHash,
    uintLE(actionBytes.length, 4),
    ...actionBytes,
  ]);
}

/** SignedTransaction = transaction bytes + u8 key type (0 = ed25519) + 64 signature bytes. */
export function encodeSignedTransaction(transactionBytes, signature) {
  if (signature.length !== 64) throw new Error('an ed25519 signature is 64 bytes');
  return concat([transactionBytes, Uint8Array.of(0), signature]);
}

/** What gets signed, and what the chain calls the transaction hash: sha256 of the transaction bytes. */
export function transactionHash(transactionBytes) {
  return Uint8Array.from(createHash('sha256').update(transactionBytes).digest());
}

// ---- keys --------------------------------------------------------------------------------------

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function rawPublicKey(keyObject) {
  return Uint8Array.from(createPublicKey(keyObject).export({ format: 'der', type: 'spki' }).subarray(-32));
}

/**
 * Parses a NEAR secret key ("ed25519:<base58 of seed + public key>", or the JSON credentials file
 * near-cli writes). Returns { publicKey, accountId, sign(bytes) }; the secret stays inside the closure.
 */
export function parseSecretKey(text) {
  let secret = String(text).trim();
  let accountId = null;
  if (secret.startsWith('{')) {
    const file = JSON.parse(secret);
    secret = file.private_key || file.secret_key || '';
    accountId = file.account_id || null;
  }
  const [curve, encoded, ...rest] = secret.split(':');
  if (curve !== 'ed25519' || !encoded || rest.length) throw new Error('not an ed25519 NEAR key');
  const raw = base58Decode(encoded);
  if (raw.length !== 64 && raw.length !== 32) throw new Error('not an ed25519 NEAR key');
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw.subarray(0, 32)]), format: 'der', type: 'pkcs8' });
  const publicRaw = rawPublicKey(privateKey);
  if (raw.length === 64 && !Buffer.from(raw.subarray(32)).equals(Buffer.from(publicRaw))) {
    throw new Error('key file is inconsistent: the public half does not belong to the secret half');
  }
  return {
    publicKey: `ed25519:${base58Encode(publicRaw)}`,
    accountId,
    sign: (bytes) => Uint8Array.from(edSign(null, Buffer.from(bytes), privateKey)),
  };
}

/** Checks an ed25519 signature against an "ed25519:<base58>" public key. */
export function verifySignature({ publicKey, message, signature }) {
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), publicKeyBytes(publicKey)]);
  const key = createPublicKey({ key: spki, format: 'der', type: 'spki' });
  return edVerify(null, Buffer.from(message), key, Buffer.from(signature));
}

/** Reads a key file, refusing unless it is a regular file of mode 600. */
export function loadKeyFile(path, fs = nodeFs) {
  let stat;
  try {
    stat = fs.statSync(path);
  } catch {
    return { ok: false, why: `key file ${path} cannot be read` };
  }
  if (!stat.isFile()) return { ok: false, why: `key file ${path} is not a regular file` };
  const mode = stat.mode & 0o777;
  if (mode !== 0o600) return { ok: false, why: `key file ${path} is mode ${mode.toString(8)}; it must be 600 (chmod 600)` };
  try {
    return { ok: true, key: parseSecretKey(fs.readFileSync(path, 'utf8')) };
  } catch (err) {
    return { ok: false, why: `key file ${path}: ${err.message}` };
  }
}

// ---- the one transaction -----------------------------------------------------------------------

/**
 * Is this access key allowed to be used here? Only a function-call key bound to `contractId` and to
 * exactly the method record_receipt passes. A FullAccess key is always refused.
 */
export function checkAccessKeyPermission(permission, { contractId }) {
  if (permission === 'FullAccess') {
    return { ok: false, why: 'refused: this is a FullAccess key. Use a function-call key limited to record_receipt.' };
  }
  const fc = permission && typeof permission === 'object' ? permission.FunctionCall : null;
  if (!fc) return { ok: false, why: 'refused: unknown access key permission' };
  if (fc.receiver_id !== contractId) {
    return { ok: false, why: `refused: the key is for contract ${fc.receiver_id}, not ${contractId}` };
  }
  const methods = Array.isArray(fc.method_names) ? fc.method_names : [];
  if (methods.length !== 1 || methods[0] !== RECORD_METHOD) {
    const shown = methods.length ? methods.join(', ') : 'any method';
    return { ok: false, why: `refused: the key may call ${shown}; it must be limited to ${RECORD_METHOD} only` };
  }
  return { ok: true, allowance: fc.allowance ?? null };
}

/** The unsigned record_receipt transaction. blockHash is base58 as the RPC reports it. */
export function buildRecordTransaction({ signerId, publicKey, contractId, hash, nonce, blockHash, gas = DEFAULT_GAS }) {
  if (!SHA256_HEX.test(String(hash))) throw new Error('hash must be 64 lowercase hex characters');
  for (const id of [signerId, contractId]) {
    if (!ACCOUNT_ID.test(String(id))) throw new Error(`"${id}" is not a NEAR account id`);
  }
  const args = Uint8Array.from(Buffer.from(hash, 'hex')); // the 32 raw bytes; the contract refuses any other length
  const action = encodeFunctionCall({ methodName: RECORD_METHOD, args, gas, deposit: 0n });
  const bytes = encodeTransaction({
    signerId,
    publicKey,
    nonce,
    receiverId: contractId,
    blockHash: base58Decode(blockHash),
    actionBytes: [action],
  });
  const hashBytes = transactionHash(bytes);
  return {
    bytes,
    hashBytes,
    hash: base58Encode(hashBytes),
    summary: {
      signer_id: signerId,
      public_key: publicKey,
      nonce: String(nonce),
      receiver_id: contractId,
      block_hash: blockHash,
      // args in base64, the way a node shows them in a transaction status
      actions: [
        { FunctionCall: { method_name: RECORD_METHOD, args: Buffer.from(args).toString('base64'), gas: String(gas), deposit: '0' } },
      ],
    },
  };
}

/** Signs a built transaction and checks the signature before returning the signed bytes. */
export function signRecordTransaction(tx, key) {
  const signature = key.sign(tx.hashBytes);
  if (!verifySignature({ publicKey: key.publicKey, message: tx.hashBytes, signature })) {
    throw new Error('signature did not verify against the public key');
  }
  return { signature, signedBytes: encodeSignedTransaction(tx.bytes, signature) };
}

/** Reads chain id and access key, applies every refusal, and returns the unsigned transaction. */
export async function prepareRecord({ network, rpcUrl, contractId, signerId, publicKey, hash, fetchImpl, timeoutMs }) {
  const chain = await chainId({ rpcUrl, fetchImpl, timeoutMs });
  if (!chain.ok) return chain;
  if (chain.chain_id !== network) {
    return { ok: false, why: `refused: ${rpcUrl} serves chain "${chain.chain_id}", not "${network}"` };
  }
  const access = await getAccessKey({ rpcUrl, accountId: signerId, publicKey, fetchImpl, timeoutMs });
  if (!access.ok) return access.offline ? access : { ok: false, why: `cannot read the access key of ${signerId}: ${access.why}` };
  const allowed = checkAccessKeyPermission(access.permission, { contractId });
  if (!allowed.ok) return allowed;
  let tx;
  try {
    tx = buildRecordTransaction({ signerId, publicKey, contractId, hash, nonce: access.nonce + 1n, blockHash: access.block_hash });
  } catch (err) {
    return { ok: false, why: err.message };
  }
  return { ok: true, tx, allowance: allowed.allowance };
}

/**
 * Sends signed bytes with broadcast_tx_commit and reports what the chain did with them. With
 * expectLog, success also needs that exact line among the logs of the outcomes: an account that
 * runs some other code would accept the call without logging the receipt.
 */
export async function broadcastSigned({ rpcUrl, signedBytes, expectLog, fetchImpl, timeoutMs = 60_000 }) {
  const answer = await rpcCall({
    rpcUrl,
    fetchImpl,
    timeoutMs,
    method: 'broadcast_tx_commit',
    params: [Buffer.from(signedBytes).toString('base64')],
  });
  if (!answer.ok) return answer;
  const status = answer.result.status || {};
  if (status.Failure !== undefined) {
    const why = `the transaction failed on chain: ${JSON.stringify(status.Failure)}`;
    return { ok: false, why, tx_hash: answer.result.transaction?.hash };
  }
  const tx_hash = answer.result.transaction?.hash;
  if (status.SuccessValue === undefined) return { ok: false, why: `unexpected status: ${JSON.stringify(status)}`, tx_hash };
  if (expectLog !== undefined) {
    const outcomes = Array.isArray(answer.result.receipts_outcome) ? answer.result.receipts_outcome : [];
    const logged = outcomes.some((o) => Array.isArray(o?.outcome?.logs) && o.outcome.logs.includes(expectLog));
    if (!logged) return { ok: false, why: 'the call went through but the receipt event is not in its logs', tx_hash };
  }
  return { ok: true, tx_hash, block_hash: answer.result.transaction_outcome?.block_hash };
}

// ---- command line ------------------------------------------------------------------------------

export function usage() {
  return [
    'record-receipt: log one receipt hash through the receipts contract (one FunctionCall transaction).',
    'The call arguments are the 32 raw bytes of the hash; the deposit is 0.',
    '',
    'usage: node scripts/record-receipt.mjs --network testnet|mainnet --contract <account> --signer <account>',
    '         --key-file <path, mode 600> --hash <64 lowercase hex> [--rpc-url <url>] [--dry-run]',
    `         [--out <file>] [${MAINNET_FLAG}]`,
    '',
    '  --dry-run  prints the unsigned transaction and its hash; signs nothing, sends nothing.',
    '  --out      after a successful call, writes { network, contract, signer, tx_hash, receipt_sha256,',
    '             block_hash, recorded_at } as JSON to <file>. Without it no file is written.',
    '  mainnet is refused unless a human passes the long flag above.',
    '',
    'The key must be a function-call access key limited to this contract and to record_receipt.',
    'A FullAccess key is refused. A human can create the restricted key with near-cli-rs:',
    '',
    '  near account add-key <signer> grant-function-call-access --allowance "0.25 NEAR" \\',
    '    --contract-account-id <contract> --function-names record_receipt \\',
    '    autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-keychain send',
    '',
    'The same call through near-cli-rs instead of this script:',
    '',
    "  near contract call-function as-transaction <contract> record_receipt base64-args '<base64 of the 32 bytes>' \\",
    "    prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <signer> network-config testnet sign-with-keychain send",
    '',
    'Check a record afterwards, with no key: node scripts/verify-receipt.mjs --help',
  ].join('\n');
}

const VALUE_FLAGS = ['--network', '--contract', '--signer', '--key-file', '--hash', '--rpc-url', '--out'];
const BOOLEAN_FLAGS = ['--dry-run', '--help', MAINNET_FLAG];
const REQUIRED_FLAGS = ['--network', '--contract', '--signer', '--key-file'];

export function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.includes(flag)) opts[flag] = true;
    else if (VALUE_FLAGS.includes(flag)) {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) return { ok: false, why: `${flag} needs a value` };
      opts[flag] = value;
    } else return { ok: false, why: `unknown argument ${flag}` };
  }
  return { ok: true, opts };
}

/**
 * The whole command. Returns the exit code; prints through `out`. Codes: 0 done (or dry run printed),
 * 2 refused, 3 [skip] because the RPC could not be reached, 1 the chain or node reported a failure.
 */
export async function runCli(argv, io = {}) {
  const { fetchImpl = globalThis.fetch, fs = nodeFs, out = console.log, timeoutMs, now = () => new Date() } = io;
  const refuse = (why) => {
    out(`[refused] ${why}`);
    return 2;
  };
  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(`${parsed.why}\n\n${usage()}`);
  const opts = parsed.opts;
  if (opts['--help']) {
    out(usage());
    return 0;
  }
  const missing = [...REQUIRED_FLAGS, '--hash'].filter((flag) => !opts[flag]);
  if (missing.length) return refuse(`missing ${missing.join(', ')}\n\n${usage()}`);

  const network = opts['--network'];
  if (network !== 'mainnet' && network !== 'testnet') return refuse(`--network must be mainnet or testnet, not "${network}"`);
  if (network === 'mainnet' && !opts[MAINNET_FLAG]) {
    return refuse(`mainnet needs a human: pass ${MAINNET_FLAG} if you are one and you approve this transaction`);
  }
  const hash = opts['--hash'];
  if (!SHA256_HEX.test(hash)) return refuse('--hash must be 64 lowercase hex characters');
  const contractId = opts['--contract'];
  const signerId = opts['--signer'];

  const loaded = loadKeyFile(opts['--key-file'], fs);
  if (!loaded.ok) return refuse(loaded.why);
  const key = loaded.key;
  if (key.accountId && key.accountId !== signerId) {
    return refuse(`the key file belongs to ${key.accountId}, not to --signer ${signerId}`);
  }

  const rpcUrl = opts['--rpc-url'] || rpcUrlFor(network);
  const publicKey = key.publicKey;
  const prepared = await prepareRecord({ network, rpcUrl, contractId, signerId, publicKey, hash, fetchImpl, timeoutMs });
  if (!prepared.ok) {
    if (prepared.offline) {
      out(`[skip] ${prepared.why}. Nothing was signed or sent.`);
      return 3;
    }
    return refuse(prepared.why);
  }
  const tx = prepared.tx;
  out(`network      ${network} (${rpcUrl})`);
  out(`access key   ${key.publicKey}: function-call only, ${contractId}.${RECORD_METHOD}, allowance ${prepared.allowance ?? 'unlimited'}`);
  out(`transaction  ${JSON.stringify(tx.summary, null, 2)}`);
  out(`unsigned     ${Buffer.from(tx.bytes).toString('base64')}`);
  out(`tx hash      ${tx.hash}`);
  if (opts['--dry-run']) {
    out('[dry-run] nothing was signed, nothing was sent.');
    return 0;
  }

  const { signedBytes } = signRecordTransaction(tx, key);
  const sent = await broadcastSigned({ rpcUrl, signedBytes, expectLog: receiptEventLine(hash), fetchImpl, timeoutMs });
  if (!sent.ok) {
    out(sent.offline ? `[unknown] no answer after sending: ${sent.why}. Look up tx ${tx.hash} before retrying.` : `[failed] ${sent.why}`);
    return 1;
  }
  const txHash = sent.tx_hash || tx.hash;
  out(`[recorded] receipt ${hash} on ${contractId}, tx ${txHash}`);
  if (opts['--out']) {
    // recorded_at is this machine's clock when the node answered; the block is the chain's own time.
    const record = { network, contract: contractId, signer: signerId, tx_hash: txHash, receipt_sha256: hash };
    if (sent.block_hash) record.block_hash = sent.block_hash;
    record.recorded_at = now().toISOString();
    try {
      fs.writeFileSync(opts['--out'], `${JSON.stringify(record, null, 2)}\n`);
    } catch (err) {
      out(`[failed] the call is on chain (tx ${txHash}) but ${opts['--out']} could not be written: ${err.message}`);
      return 1;
    }
    out(`[written] ${opts['--out']}`);
  }
  return 0;
}
