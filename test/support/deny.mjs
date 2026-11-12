// deny.mjs — what must never appear in anything this repository publishes.
// The list here is generic: machine paths, private addresses, ids and credential shapes. A publisher can add
// terms of their own (names of private systems, people, hosts) without publishing them: point
// CAMBRIAN_EXTRA_DENY at a JSON file of [label, regex source, flags, sample] rows kept outside the repository.
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';

// [what it is, the pattern, a sample that must be caught]
export const DENY = [
  ['a home directory path', /\/(Users|home)\/[a-z][a-z0-9_-]+\//i, '/Users/someone/project'],
  ['a system install path', /\/opt\/[a-z][a-z0-9_-]+\//i, '/opt/acme/bin/tool'],
  ['a private scratch path', /\/private\/(tmp|var)\//, '/private/tmp/x/y'],
  ['a unix socket', /[\w./-]+\.sock\b/, '/run/app/gw.sock'],
  ['a tailnet host', /\b[a-z0-9-]+\.ts\.net\b/i, 'box.tail1234.ts.net'],
  ['an address', /\b(?!127\.0\.0\.1\b)(?!1\.1\.1\.1\b)(?:\d{1,3}\.){3}\d{1,3}\b/, 'http://100.64.0.7:8080'],
  ['a uuid', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i, 'id 0a1b2c3d-aaaa-4bbb-8ccc-0123456789ab'],
  ['an email address', /\b[\w.+-]+@[\w-]+(\.[\w-]+)*\.[a-z]{2,}\b/i, 'someone@example.org'],
  ['a share-link token', /_vercel_share=/, 'https://x.vercel.app/?_vercel_share=abc'],
  ['a GitHub token', /\b(github_pat_|gh[pousr]_)[A-Za-z0-9_]{20,}/, 'ghp_' + 'a'.repeat(36)],
  ['an API key', /\bsk-[A-Za-z0-9_-]{20,}/, 'sk-' + 'b'.repeat(40)],
  ['a private key block', /-----BEGIN [A-Z ]*PRIVATE KEY-----/, '-----BEGIN ' + 'PRIVATE KEY-----'],
  ['a process or message id field', /"(pid|message_id|chat_id_telegram)"\s*:/, '"pid": 123'],
];
const host = hostname().split('.')[0];
if (host.length > 3 && host.toLowerCase() !== 'localhost') {
  DENY.push(["this machine's name", new RegExp(host.replace(/[^a-z0-9]/gi, '.'), 'i'), host]);
}
const extra = process.env.CAMBRIAN_EXTRA_DENY;
if (extra && existsSync(extra)) {
  for (const [what, source, flags, sample] of JSON.parse(readFileSync(extra, 'utf8'))) DENY.push([what, new RegExp(source, flags), sample]);
}

/** Every deny rule this text trips → ["what: match"]. */
export function faults(text) {
  return DENY.filter(([, re]) => re.test(text)).map(([what, re]) => `${what}: ${text.match(re)[0]}`);
}
