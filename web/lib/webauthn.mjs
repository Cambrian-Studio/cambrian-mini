// WebAuthn in the browser: the same checks as the server's verifier, made with WebCrypto,
// and the two ceremonies (sign, enrol). The checks are pure and also run in Node.

const enc = new TextEncoder();
const subtle = () => globalThis.crypto.subtle;

export function b64urlToBytes(text) {
  const s = String(text ?? '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const x of b) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256(bytes) {
  return new Uint8Array(await subtle().digest('SHA-256', bytes));
}

// The challenge a passkey signs: base64url(sha256("cambrian-<purpose>-v1:" + subject hash)).
const challengeFor = async (purpose, hash) => bytesToB64url(await sha256(enc.encode(`cambrian-${purpose}-v1:${hash}`)));
export const approvalChallenge = (ticketSha256) => challengeFor('approval', ticketSha256);
export const lessonChallenge = (lessonSha256) => challengeFor('lesson', lessonSha256);
// Proposing an idea is its own purpose: the subject is sha256 (hex) of the idea's exact utf8 text.
export const ideaChallenge = (ideaSha256) => challengeFor('idea', ideaSha256);
const hex = (bytes) => [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
// With images attached the proposer signs the text and each image's sha256, one per line.
export async function ideaHash(idea, attachmentShas = []) {
  return hex(await sha256(enc.encode(attachmentShas.length ? `${String(idea)}\n${attachmentShas.join('\n')}` : String(idea))));
}
// An approval signs the brief's hash, or with a taste note the hash of that hash and the note's hash.
export async function approvalSubject(ticketSha256, note) {
  if (typeof note !== 'string' || !note) return ticketSha256;
  return hex(await sha256(enc.encode(`${ticketSha256}\n${hex(await sha256(enc.encode(note)))}`)));
}
export const sha256Hex = async (bytes) => hex(await sha256(bytes));

// An ES256 signature arrives DER-encoded; WebCrypto wants r||s, 32 bytes each.
export function derToRaw(der) {
  let p = 0;
  const fail = () => { throw new Error('signature is not a DER ECDSA signature'); };
  if (der[p++] !== 0x30) fail();
  if (der[p] & 0x80) p += 1 + (der[p] & 0x7f); else p += 1;
  const out = new Uint8Array(64);
  for (const offset of [0, 32]) {
    if (der[p++] !== 0x02) fail();
    const len = der[p++];
    let int = der.subarray(p, p + len);
    p += len;
    while (int.length > 32 && int[0] === 0) int = int.subarray(1);
    if (int.length > 32 || int.length === 0) fail();
    out.set(int, offset + 32 - int.length);
  }
  return out;
}

const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

// One assertion against one public key. Returns { ok, why } with the first thing that is wrong.
// The argument names are the server verifier's.
export async function verifyAssertion({
  publicKeySpki, authenticatorData, clientDataJSON, signature, expectedChallenge, rpId, origins,
}) {
  const fail = (why) => ({ ok: false, why });
  let auth; let clientRaw; let sig;
  try {
    auth = b64urlToBytes(authenticatorData);
    clientRaw = b64urlToBytes(clientDataJSON);
    sig = b64urlToBytes(signature);
  } catch {
    return fail('the assertion is not base64url');
  }
  if (auth.length < 37) return fail('authenticator data is too short');
  if (!sig.length) return fail('no signature');

  let client;
  try { client = JSON.parse(new TextDecoder().decode(clientRaw)); } catch { return fail('client data is not JSON'); }
  if (client.type !== 'webauthn.get') return fail('client data type is not "webauthn.get"');
  if (typeof client.challenge !== 'string' || client.challenge !== expectedChallenge) {
    return fail('the signature is over a different challenge (another ticket, or the ticket was altered)');
  }
  if (!Array.isArray(origins) || !origins.includes(client.origin)) return fail(`origin ${JSON.stringify(client.origin)} is not allowed`);

  if (!same(auth.subarray(0, 32), await sha256(enc.encode(String(rpId))))) {
    return fail('the signature was made for another site (rp id hash differs)');
  }
  if (!(auth[32] & 0x01)) return fail('the user-present flag is not set');

  let key;
  try {
    key = await subtle().importKey('spki', b64urlToBytes(publicKeySpki), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return fail('the stored public key is not a readable P-256 key');
  }
  const clientHash = await sha256(clientRaw);
  const signed = new Uint8Array(auth.length + clientHash.length);
  signed.set(auth, 0);
  signed.set(clientHash, auth.length);
  let good = false;
  try {
    good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, derToRaw(sig), signed);
  } catch {
    good = false;
  }
  if (!good) return fail('the signature does not verify against the member\'s public key');
  return { ok: true, why: null, userVerified: Boolean(auth[32] & 0x04) };
}

// One member's signature over one subject hash, against the council record as served.
//   purpose: 'approval' | 'lesson' | 'idea'.  Returns { ok, member, why }.
export async function verifyMemberSignature({ purpose, subjectHash, approval, council }) {
  const memberId = String(approval?.member ?? '');
  if (!/^[0-9a-f]{64}$/.test(String(subjectHash ?? ''))) return { ok: false, member: memberId, why: 'no subject hash' };
  const member = (council?.members ?? []).find((m) => m.id === memberId);
  if (!member) return { ok: false, member: memberId, why: `'${memberId}' is not a council member` };
  const cred = (member.credentials ?? []).find((c) => c.id === approval?.credential_id);
  if (!cred) return { ok: false, member: memberId, why: `${memberId} has no enrolled passkey with that id` };
  const r = await verifyAssertion({
    publicKeySpki: cred.public_key_spki,
    authenticatorData: approval.authenticator_data,
    clientDataJSON: approval.client_data_json,
    signature: approval.signature,
    expectedChallenge: await challengeFor(purpose, subjectHash),
    rpId: cred.rp_id ?? council.rp?.id,
    origins: council.rp?.origins ?? [],
  });
  return { ok: r.ok, member: memberId, why: r.why };
}

// ---- ceremonies (browser only) --------------------------------------------------------------

export const passkeysAvailable = () =>
  typeof navigator !== 'undefined' && !!navigator.credentials && typeof PublicKeyCredential !== 'undefined';

// Asks the device for an assertion. `options` is the server's answer to an options request.
// The header shows a member's menu (Approvals, notifications) on a device that has used a passkey here.
function rememberMember() {
  try { localStorage.setItem('cambrian.member', '1'); } catch { /* no storage: nothing to remember */ }
}

export async function getAssertion(options) {
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rpId: options.rpId,
      allowCredentials: (options.allowCredentials || []).map((c) => ({ type: 'public-key', id: b64urlToBytes(c.id) })),
      userVerification: options.userVerification || 'preferred',
      ...(options.timeout ? { timeout: options.timeout } : {}),
    },
  });
  if (!cred) throw new Error('no passkey was used');
  rememberMember();
  return {
    credential_id: bytesToB64url(cred.rawId),
    authenticator_data: bytesToB64url(cred.response.authenticatorData),
    client_data_json: bytesToB64url(cred.response.clientDataJSON),
    signature: bytesToB64url(cred.response.signature),
  };
}

// Creates an ES256 passkey from the server's enrolment options. Only ES256 is ever asked for.
export async function createPasskey(options) {
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: b64urlToBytes(options.challenge),
      rp: options.rp,
      user: { id: b64urlToBytes(options.user.id), name: options.user.name, displayName: options.user.displayName },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: options.authenticatorSelection || { residentKey: 'preferred', userVerification: 'preferred' },
      attestation: 'none',
      ...(options.timeout ? { timeout: options.timeout } : {}),
    },
  });
  if (!cred) throw new Error('no passkey was created');
  rememberMember();
  const spki = cred.response.getPublicKey?.();
  if (!spki) throw new Error('this browser did not return the public key');
  if (cred.response.getPublicKeyAlgorithm?.() !== -7) throw new Error('the passkey is not ES256');
  return {
    credential_id: bytesToB64url(cred.rawId),
    public_key_spki: bytesToB64url(spki),
    authenticator_data: bytesToB64url(cred.response.getAuthenticatorData()),
    client_data_json: bytesToB64url(cred.response.clientDataJSON),
  };
}
