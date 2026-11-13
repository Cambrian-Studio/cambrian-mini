// attachments.mjs — images a member attaches to a message: at most 3, PNG or JPEG, under 5 MB each.
// They are kept beside the brief and named in it by hash. They are never sent to a model and never served.
// PURE: bytes in, verdict out.
import { createHash } from 'node:crypto';

export const MAX_ATTACHMENTS = 3;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const kindOf = (buf) => (buf.subarray(0, 8).equals(PNG) ? 'png' : (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff ? 'jpeg' : null));

/** [{name?, data: base64}] → { ok, files: [{n, type, bytes, sha256, buf}] } | { ok:false, why } */
export function readAttachments(list) {
  if (list === undefined || list === null) return { ok: true, files: [] };
  if (!Array.isArray(list)) return { ok: false, why: 'attachments must be a list' };
  if (list.length > MAX_ATTACHMENTS) return { ok: false, why: `at most ${MAX_ATTACHMENTS} images` };
  const files = [];
  for (const [i, a] of list.entries()) {
    if (!a || typeof a.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) return { ok: false, why: `image ${i + 1} is not base64 data` };
    const buf = Buffer.from(a.data, 'base64');
    if (!buf.length) return { ok: false, why: `image ${i + 1} is empty` };
    if (buf.length >= MAX_ATTACHMENT_BYTES) return { ok: false, why: `image ${i + 1} is ${(buf.length / 1048576).toFixed(1)} MB; the limit is under 5 MB` };
    const type = kindOf(buf);
    if (!type) return { ok: false, why: `image ${i + 1} is not a PNG or a JPEG` };
    files.push({ n: i + 1, type, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex'), buf });
  }
  return { ok: true, files };
}
