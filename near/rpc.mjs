// Read-only NEAR JSON-RPC client. Zero dependencies; every network call goes through an
// injectable fetch, so tests run offline. Nothing in this file signs or sends a transaction.
//
// Every function resolves (never throws for a network fault) to one of:
//   { ok: true, ... }                    the node answered
//   { ok: false, offline: true, why }    no answer (network down, timeout, bad gateway): callers print [skip]
//   { ok: false, why, ... }              the node answered with an error, or the input was refused

import { createHash } from 'node:crypto';

// Public endpoints that need no API key (FastNEAR free tier, listed on docs.near.org/api/rpc/providers).
// The older rpc.mainnet.near.org / rpc.testnet.near.org hosts are deprecated and heavily rate limited.
export const DEFAULT_RPC = Object.freeze({
  mainnet: 'https://free.rpc.fastnear.com',
  testnet: 'https://test.rpc.fastnear.com',
});

export const DEFAULT_TIMEOUT_MS = 10_000;

// What view_account reports as code_hash for an account with no contract: 32 zero bytes in base58.
export const NO_CONTRACT_CODE_HASH = '1'.repeat(32);

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function rpcUrlFor(network) {
  const url = DEFAULT_RPC[network];
  if (!url) throw new Error(`unknown network "${network}" (known: ${Object.keys(DEFAULT_RPC).join(', ')})`);
  return url;
}

// ---- base58 (Bitcoin alphabet, as NEAR uses for hashes and keys) -------------------------------

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes) {
  const input = Uint8Array.from(bytes);
  let zeros = 0;
  while (zeros < input.length && input[zeros] === 0) zeros++;
  const digits = []; // base58 digits, least significant first
  for (let i = zeros; i < input.length; i++) {
    let carry = input[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 256;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = '1'.repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58[digits[i]];
  return out;
}

export function base58Decode(text) {
  if (typeof text !== 'string') throw new Error('base58: not a string');
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') zeros++;
  const bytes = []; // least significant first
  for (let i = zeros; i < text.length; i++) {
    let carry = B58.indexOf(text[i]);
    if (carry < 0) throw new Error(`base58: bad character "${text[i]}"`);
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i];
  return out;
}

// ---- JSON-RPC ----------------------------------------------------------------------------------

function offline(why) {
  return { ok: false, offline: true, why };
}

function rpcErrorText(error) {
  if (!error || typeof error !== 'object') return String(error);
  const cause = error.cause?.name ? `${error.cause.name}: ` : '';
  const detail = typeof error.data === 'string' ? error.data : error.message || error.name || JSON.stringify(error);
  return `${cause}${detail}`;
}

/** One JSON-RPC request. */
export async function rpcCall({ rpcUrl, method, params, fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!rpcUrl) return { ok: false, why: 'no rpcUrl given' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'cambrian-mini', method, params }),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    return offline(timedOut ? `no answer from ${rpcUrl} within ${timeoutMs} ms` : `cannot reach ${rpcUrl}: ${err?.message || err}`);
  } finally {
    clearTimeout(timer);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    return offline(`${rpcUrl} answered HTTP ${response.status} without JSON`);
  }
  if (body && body.error) return { ok: false, why: rpcErrorText(body.error), error: body.error };
  if (!body || body.result === undefined) return offline(`${rpcUrl} answered HTTP ${response.status} without a result`);
  return { ok: true, result: body.result };
}

/** Calls a view method. args is a JSON value; the result bytes are parsed as JSON into `value`. */
export async function viewCall({ rpcUrl, contractId, method, args = {}, fetchImpl, timeoutMs }) {
  const answer = await rpcCall({
    rpcUrl,
    fetchImpl,
    timeoutMs,
    method: 'query',
    params: {
      request_type: 'call_function',
      finality: 'final',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(args), 'utf8').toString('base64'),
    },
  });
  if (!answer.ok) return answer;
  const result = answer.result;
  // Some nodes report a failed view inside the result instead of as a JSON-RPC error.
  if (result.error) return { ok: false, why: String(result.error) };
  if (!Array.isArray(result.result)) return { ok: false, why: 'view call answered without result bytes' };
  const text = Buffer.from(result.result).toString('utf8');
  let value;
  try {
    value = text === '' ? null : JSON.parse(text);
  } catch {
    return { ok: false, why: `view result is not JSON: ${text.slice(0, 80)}` };
  }
  return { ok: true, value, block_height: result.block_height, block_hash: result.block_hash, logs: result.logs || [] };
}

// There is no getReceipt here on purpose. The receipts contract is log-only: it keeps no state, so
// no view call can "get" a receipt. A record lives in the outcome of the transaction that made it,
// and is read back with txStatus() below (see scripts/verify-receipt.mjs).

/** The one log line the receipts contract emits for a receipt hash (64 lowercase hex). */
export function receiptEventLine(hash) {
  if (typeof hash !== 'string' || !SHA256_HEX.test(hash)) throw new Error('hash must be 64 lowercase hex characters');
  const event = `{"standard":"cambrian-receipt","version":"1.0.0","event":"record_receipt","data":[{"sha256":"${hash}"}]}`;
  return `EVENT_JSON:${event}`;
}

/**
 * A transaction with the outcomes of its receipts (where contract logs live). Read-only.
 * senderId is needed by the node to find the shard; it is NOT proof of who signed: read
 * result.transaction.signer_id for that. wait_until NONE means "answer now with what you have",
 * so an unknown hash is an immediate error instead of a long wait; final_execution_status says
 * how far the transaction got. Nodes drop old transactions: an archival node is needed for those.
 */
export async function txStatus({ rpcUrl, txHash, senderId, fetchImpl, timeoutMs }) {
  const answer = await rpcCall({
    rpcUrl,
    fetchImpl,
    timeoutMs,
    method: 'tx',
    params: { tx_hash: txHash, sender_account_id: senderId, wait_until: 'NONE' },
  });
  if (!answer.ok) {
    const cause = answer.error?.cause?.name;
    // A node that is too busy to answer is "no answer", not "the transaction is wrong".
    if (cause === 'TIMEOUT_ERROR') return { ok: false, offline: true, why: answer.why };
    return { ...answer, unknown: cause === 'UNKNOWN_TRANSACTION' };
  }
  const result = answer.result;
  if (!result.transaction || !result.transaction_outcome || !Array.isArray(result.receipts_outcome)) {
    return { ok: false, why: 'tx answered without transaction, transaction_outcome and receipts_outcome' };
  }
  return { ok: true, result };
}

/** The sha256 of the code deployed on an account, base58, as the chain reports it. */
export async function contractCodeHash({ rpcUrl, accountId, fetchImpl, timeoutMs }) {
  const answer = await rpcCall({
    rpcUrl,
    fetchImpl,
    timeoutMs,
    method: 'query',
    params: { request_type: 'view_account', finality: 'final', account_id: accountId },
  });
  if (!answer.ok) return answer;
  const codeHash = answer.result.code_hash;
  if (typeof codeHash !== 'string') return { ok: false, why: 'view_account answered without code_hash' };
  return { ok: true, code_hash: codeHash, has_contract: codeHash !== NO_CONTRACT_CODE_HASH, block_height: answer.result.block_height };
}

/** sha256 of wasm bytes in base58: the form view_account reports as code_hash. */
export function wasmCodeHash(bytes) {
  return base58Encode(createHash('sha256').update(bytes).digest());
}

/** Does the code deployed on accountId equal these wasm bytes? */
export async function compareCodeHash({ rpcUrl, accountId, wasmBytes, fetchImpl, timeoutMs }) {
  const onchain = await contractCodeHash({ rpcUrl, accountId, fetchImpl, timeoutMs });
  if (!onchain.ok) return onchain;
  const local = wasmCodeHash(wasmBytes);
  const match = onchain.code_hash === local;
  let why = 'deployed code is the committed wasm';
  if (!onchain.has_contract) why = `no contract is deployed on ${accountId}`;
  else if (!match) why = `deployed code ${onchain.code_hash} is not the committed wasm ${local}`;
  return { ok: true, match, onchain: onchain.code_hash, local, why };
}

/** One access key of an account: its nonce, its permission, and a recent block hash. */
export async function getAccessKey({ rpcUrl, accountId, publicKey, fetchImpl, timeoutMs }) {
  const answer = await rpcCall({
    rpcUrl,
    fetchImpl,
    timeoutMs,
    method: 'query',
    params: { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey },
  });
  if (!answer.ok) return answer;
  const result = answer.result;
  if (result.error) return { ok: false, why: String(result.error) };
  if (result.permission === undefined || result.nonce === undefined || typeof result.block_hash !== 'string') {
    return { ok: false, why: 'view_access_key answered without nonce, permission and block_hash' };
  }
  return { ok: true, nonce: BigInt(result.nonce), permission: result.permission, block_hash: result.block_hash };
}

/** The chain id the node serves ("mainnet", "testnet", ...). */
export async function chainId({ rpcUrl, fetchImpl, timeoutMs }) {
  const answer = await rpcCall({ rpcUrl, fetchImpl, timeoutMs, method: 'status', params: [] });
  if (!answer.ok) return answer;
  if (typeof answer.result.chain_id !== 'string') return { ok: false, why: 'status answered without chain_id' };
  return { ok: true, chain_id: answer.result.chain_id };
}
