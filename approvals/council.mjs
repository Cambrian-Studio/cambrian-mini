// council.mjs — who may approve: data/council.json. Three members, threshold 2. Each member enrols a
// passkey once through a one-time invite link; only the PUBLIC key is stored, so the file is safe to commit
// and anyone can re-check every recorded approval with it.
// Invites live outside the repository (in the app's private state dir) as sha256 hashes: the link is shown
// once, at creation, and cannot be read back from disk.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { checkRegistration } from './webauthn.mjs';

const sha256Hex = (s) => createHash('sha256').update(s).digest('hex');
const writeAtomic = (file, text, mode) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, text, mode ? { mode } : undefined); renameSync(`${file}.tmp`, file);
};
const INVITE_TTL_MS = 24 * 3600 * 1000;

export function loadCouncil(file) {
  const c = JSON.parse(readFileSync(file, 'utf8'));
  if (c.v !== 1) throw new Error('council: v must be 1');
  // N members, any threshold M with 2 <= M <= N. A threshold of 1 is never a council here: one person deciding alone
  // is a different, separately labelled case and is not read from this file.
  if (!Number.isInteger(c.threshold) || c.threshold < 2) throw new Error('council: threshold must be 2 or more');
  if (!Array.isArray(c.members) || c.members.length < c.threshold) throw new Error('council: fewer members than the threshold');
  const ids = new Set();
  for (const m of c.members) {
    if (!/^[a-z][a-z0-9-]{1,20}$/.test(String(m.id))) throw new Error(`council: bad member id ${JSON.stringify(m.id)}`);
    if (ids.has(m.id)) throw new Error(`council: member '${m.id}' appears twice`);
    ids.add(m.id); m.credentials = Array.isArray(m.credentials) ? m.credentials : [];
  }
  return c;
}
export const saveCouncil = (file, council) => writeAtomic(file, JSON.stringify(council, null, 2) + '\n');

/** What the UI may see: names, figures, how many passkeys, the public keys. (There is nothing secret in it.) */
export const publicCouncil = (c) => ({
  v: c.v, threshold: c.threshold, label: c.label ?? null, rp: c.rp, test_only: c.test_only === true,
  members: c.members.map((m) => ({ id: m.id, name: m.name, role: m.role ?? null, figure: m.figure ?? null, enrolled: m.credentials.length > 0,
    credentials: m.credentials.map((k) => ({ id: k.id, alg: k.alg, rp_id: k.rp_id, public_key_spki: k.public_key_spki, enrolled_at: k.enrolled_at })) })),
});

const readInvites = (file) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { invites: [] });

/** Make a one-time invite for a member. Returns the token ONCE; only its hash is written. */
export function createInvite({ invitesFile, council, memberId, now = Date.now() }) {
  if (!council.members.some((m) => m.id === memberId)) throw new Error(`'${memberId}' is not a council member`);
  const token = randomBytes(24).toString('base64url');
  const store = readInvites(invitesFile);
  store.invites = store.invites.filter((i) => !i.used_at && i.expires_at > now);
  store.invites.push({ member: memberId, token_sha256: sha256Hex(token), created_at: now, expires_at: now + INVITE_TTL_MS, used_at: null });
  writeAtomic(invitesFile, JSON.stringify(store, null, 2) + '\n', 0o600);
  return { token, member: memberId, expires_at: new Date(now + INVITE_TTL_MS).toISOString() };
}

/** Look an invite up by its token. → {ok, member, challenge} | {ok:false, why}. The challenge is derived from the token. */
export function findInvite({ invitesFile, token, now = Date.now() }) {
  const h = sha256Hex(String(token ?? ''));
  const inv = readInvites(invitesFile).invites.find((i) => i.token_sha256 === h);
  if (!inv) return { ok: false, why: 'this invite link is not known' };
  if (inv.used_at) return { ok: false, why: 'this invite link was already used' };
  if (inv.expires_at <= now) return { ok: false, why: 'this invite link has expired' };
  return { ok: true, member: inv.member, challenge: createHash('sha256').update(`cambrian-enrol-v1:${token}`).digest().toString('base64url') };
}

/** Finish an enrolment: check the WebAuthn registration, store the public key, burn the invite. */
export function enrol({ councilFile, invitesFile, token, registration, now = Date.now() }) {
  const inv = findInvite({ invitesFile, token, now });
  if (!inv.ok) return inv;
  const council = loadCouncil(councilFile);
  const reg = checkRegistration({
    clientDataJSON: registration.client_data_json, authenticatorData: registration.authenticator_data,
    publicKeySpki: registration.public_key_spki, expectedChallenge: inv.challenge, rpId: council.rp.id, origins: council.rp.origins,
  });
  if (!reg.ok) return reg;
  if (!/^[A-Za-z0-9_-]{8,1400}$/.test(String(registration.credential_id ?? ''))) return { ok: false, why: 'bad credential id' };
  const member = council.members.find((m) => m.id === inv.member);
  if (council.members.some((m) => m.credentials.some((k) => k.id === registration.credential_id))) return { ok: false, why: 'this passkey is already enrolled' };
  member.credentials.push({ id: registration.credential_id, alg: -7, rp_id: council.rp.id, public_key_spki: registration.public_key_spki, enrolled_at: new Date(now).toISOString() });
  saveCouncil(councilFile, council);
  const store = readInvites(invitesFile);
  for (const i of store.invites) if (i.token_sha256 === sha256Hex(token)) i.used_at = now;
  writeAtomic(invitesFile, JSON.stringify(store, null, 2) + '\n', 0o600);
  return { ok: true, member: inv.member, credential_id: registration.credential_id };
}
