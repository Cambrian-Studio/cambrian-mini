// canonical.mjs — one way to turn a JSON value into bytes, so a hash means the same thing everywhere.
// The server, the line, `npm run judge` and the browser's Verify button all import THIS file.
//
// Rules (a subset of RFC 8785, enough for our records):
//   - object keys sorted by UTF-16 code unit, no whitespace, arrays keep their order
//   - strings and numbers exactly as JSON.stringify writes them
//   - a key whose value is undefined is left out (as JSON does); NaN, Infinity, functions, bigints throw
// No imports: it must load unchanged in a browser.

export function canonical(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonical: a number must be finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`;
  if (t === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  throw new Error(`canonical: a ${t} cannot be serialised`);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const bytesOf = (input) => (typeof input === 'string' ? new TextEncoder().encode(input) : input);

/** sha256 → lowercase hex, synchronously. Node only (the browser has no synchronous digest: use sha256HexAsync). */
export function sha256Hex(input) {
  const crypto = globalThis.process?.getBuiltinModule?.('node:crypto');
  if (!crypto) throw new Error('sha256Hex needs Node 20.16+ (in a browser use sha256HexAsync)');
  return crypto.createHash('sha256').update(bytesOf(input)).digest('hex');
}

/** sha256 → lowercase hex with WebCrypto. Works in the browser and in Node. */
export async function sha256HexAsync(input) {
  return hex(await globalThis.crypto.subtle.digest('SHA-256', bytesOf(input)));
}

/** The hash of a JSON value: sha256 over its canonical form. */
export const hashOf = (value) => sha256Hex(canonical(value));
export const hashOfAsync = (value) => sha256HexAsync(canonical(value));
