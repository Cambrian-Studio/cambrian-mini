// admin.mjs — the three one-off transactions that set the receipt contract up, and nothing else:
//   DeployContract   put the committed wasm on the contract account
//   AddKey           give the recorder account a key that can ONLY call record_receipt on that contract
//   DeleteKey        remove a full-access key (after which nobody can change the contract's code again)
// Same hand-written borsh as near/record.mjs, checked against near-api-js's published vectors
// (test/near/admin.test.mjs). No dependency. A human decides when these run; see scripts/deploy-receipts.mjs.
import { publicKeyBytes, encodeTransaction, encodeSignedTransaction, transactionHash, verifySignature } from './record.mjs';
import { base58Decode, base58Encode } from './rpc.mjs';

const u = (value, bytes) => {
  let v = BigInt(value); const out = new Uint8Array(bytes);
  for (let i = 0; i < bytes; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  if (v !== 0n) throw new Error(`value does not fit in ${bytes} bytes`);
  return out;
};
const cat = (parts) => Uint8Array.from(Buffer.concat(parts.map((p) => Buffer.from(p))));
const bytes = (b) => cat([u(b.length, 4), b]);
const str = (s) => bytes(Buffer.from(s, 'utf8'));

/** DeployContract: tag 1 | code: u32 length + bytes. */
export const encodeDeployContract = (code) => cat([Uint8Array.of(1), bytes(code)]);

/**
 * AddKey of a FUNCTION-CALL key: tag 5 | public key | access key { nonce u64 = 0 | permission tag 0 (FunctionCall) |
 * allowance: Option<u128> | receiver_id | method_names }. allowance null = no spending limit of its own
 * (the key can still only pay gas for the named methods). There is deliberately no encoder for a full-access key.
 */
export function encodeAddFunctionCallKey({ publicKey, receiverId, methodNames, allowance = null }) {
  if (!Array.isArray(methodNames) || methodNames.length < 1) throw new Error('a function-call key names at least one method');
  return cat([
    Uint8Array.of(5), Uint8Array.of(0), publicKeyBytes(publicKey), u(0, 8), Uint8Array.of(0),
    allowance == null ? Uint8Array.of(0) : cat([Uint8Array.of(1), u(allowance, 16)]),
    str(receiverId), u(methodNames.length, 4), ...methodNames.map(str),
  ]);
}

/** DeleteKey: tag 6 | public key. */
export const encodeDeleteKey = (publicKey) => cat([Uint8Array.of(6), Uint8Array.of(0), publicKeyBytes(publicKey)]);

/** One action, from an account to itself, signed. → { bytes, hash (base58), signedBytes } */
export function signSelfTransaction({ accountId, key, nonce, blockHash, action }) {
  const tx = encodeTransaction({ signerId: accountId, publicKey: key.publicKey, nonce, receiverId: accountId, blockHash: base58Decode(blockHash), actionBytes: [action] });
  const hashBytes = transactionHash(tx);
  const signature = key.sign(hashBytes);
  if (!verifySignature({ publicKey: key.publicKey, message: hashBytes, signature })) throw new Error('signature did not verify against the public key');
  return { bytes: tx, hash: base58Encode(hashBytes), signedBytes: encodeSignedTransaction(tx, signature) };
}
