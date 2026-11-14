// webauthn.mjs — verify one passkey signature (a WebAuthn assertion, ES256) with node:crypto alone.
//
// A passkey signs  authenticatorData || sha256(clientDataJSON).  clientDataJSON carries the challenge we
// chose, so a signature is bound to exactly one challenge; authenticatorData carries a hash of the site
// (the relying party id) and a "user present" flag. We check all of it and return the first thing wrong.
// PURE: no I/O, no network, no clock.
import { createHash, createPublicKey, verify as cryptoVerify } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const unb64u = (s) => Buffer.from(String(s ?? ''), 'base64url');
const sha256 = (b) => createHash('sha256').update(b).digest();

const FLAG_USER_PRESENT = 0x01;
const FLAG_USER_VERIFIED = 0x04;

/**
 * @param {object} a
 * @param {string} a.publicKeySpki      the credential's public key, SubjectPublicKeyInfo DER, base64url
 * @param {string} a.authenticatorData  base64url
 * @param {string} a.clientDataJSON     base64url
 * @param {string} a.signature          base64url, ASN.1 DER ECDSA signature
 * @param {string} a.expectedChallenge  base64url — what we asked the passkey to sign
 * @param {string} a.rpId               the site the credential was created for (e.g. "localhost")
 * @param {string[]} a.origins          pages allowed to ask for this signature
 * @returns {{ok:boolean, why:string|null, userVerified?:boolean, signCount?:number}}
 */
export function verifyAssertion({ publicKeySpki, authenticatorData, clientDataJSON, signature, expectedChallenge, rpId, origins }) {
  const fail = (why) => ({ ok: false, why });
  const auth = unb64u(authenticatorData), clientRaw = unb64u(clientDataJSON), sig = unb64u(signature);
  if (auth.length < 37) return fail('authenticator data is too short');
  if (!sig.length) return fail('no signature');

  let client;
  try { client = JSON.parse(clientRaw.toString('utf8')); } catch { return fail('client data is not JSON'); }
  if (client.type !== 'webauthn.get') return fail(`client data type is ${JSON.stringify(client.type)}, wanted "webauthn.get"`);
  if (typeof client.challenge !== 'string' || client.challenge !== expectedChallenge) {
    return fail('the signature is over a different challenge (another ticket, or the ticket was altered)');
  }
  if (!Array.isArray(origins) || !origins.includes(client.origin)) return fail(`origin ${JSON.stringify(client.origin)} is not allowed`);

  if (!auth.subarray(0, 32).equals(sha256(Buffer.from(String(rpId), 'utf8')))) return fail('the signature was made for another site (rp id hash differs)');
  const flags = auth[32];
  if (!(flags & FLAG_USER_PRESENT)) return fail('the user-present flag is not set');
  // a touch is not enough: the authenticator must have checked who is touching it
  if (!(flags & FLAG_USER_VERIFIED)) return fail('the user-verified flag is not set: the passkey must check a fingerprint, a face or a PIN');

  let key;
  try { key = createPublicKey({ key: unb64u(publicKeySpki), format: 'der', type: 'spki' }); } catch { return fail('the stored public key cannot be read'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return fail('the stored public key is not P-256');

  const signed = Buffer.concat([auth, sha256(clientRaw)]);
  let good = false;
  try { good = cryptoVerify('sha256', signed, { key, dsaEncoding: 'der' }, sig); } catch { good = false; }
  if (!good) return fail('the signature does not verify against the member\'s public key');
  return { ok: true, why: null, userVerified: !!(flags & FLAG_USER_VERIFIED), signCount: auth.readUInt32BE(33) };
}

/** The registration half: what we keep from navigator.credentials.create(). We store the key the browser
 *  hands us (getPublicKey(), SPKI) after checking the ceremony was ours: type, challenge, origin, rp id. */
export function checkRegistration({ clientDataJSON, authenticatorData, publicKeySpki, expectedChallenge, rpId, origins }) {
  const fail = (why) => ({ ok: false, why });
  let client;
  try { client = JSON.parse(unb64u(clientDataJSON).toString('utf8')); } catch { return fail('client data is not JSON'); }
  if (client.type !== 'webauthn.create') return fail('client data type is not "webauthn.create"');
  if (client.challenge !== expectedChallenge) return fail('the enrolment answers a different invite');
  if (!origins.includes(client.origin)) return fail(`origin ${JSON.stringify(client.origin)} is not allowed`);
  const auth = unb64u(authenticatorData);
  if (auth.length < 37 || !auth.subarray(0, 32).equals(sha256(Buffer.from(String(rpId), 'utf8')))) return fail('authenticator data is for another site');
  if (!(auth[32] & FLAG_USER_PRESENT) || !(auth[32] & FLAG_USER_VERIFIED)) {
    return fail('the passkey was created without user verification: it must check a fingerprint, a face or a PIN');
  }
  let key;
  try { key = createPublicKey({ key: unb64u(publicKeySpki), format: 'der', type: 'spki' }); } catch { return fail('the public key cannot be read'); }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return fail('only ES256 (P-256) passkeys are accepted');
  return { ok: true, why: null };
}
