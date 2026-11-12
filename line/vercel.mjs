// vercel.mjs — the preview. After GREEN the line deploys the build's static output to Vercel with the
// REST API, makes the deployment viewable without a sign-in, waits until it is READY, and then proves it by
// reading the address with NO credential and expecting 200. Only then is the preview reported:
//   { state:'success', url, deployment_id, public:true }
// Anything else is { state:'failed', why } and never fails the build (the run ends "green-no-preview").
//
// Endpoints used (Vercel REST API):
//   POST  /v11/projects                 make the project `cambrian-<product>` (409 = it exists already)
//   PATCH /v9/projects/{name}           ssoProtection:null, passwordProtection:null — deployment protection off
//   POST  /v13/deployments              the files, inlined as base64; no framework, nothing to build
//   GET   /v13/deployments/{id}         readyState until READY
// The token is read from its file (mode 600) at use, sent only as a bearer header to cfg.vercel_api, and
// scrubbed from anything returned. All network goes through the injected fetchImpl.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tokenState } from './github.mjs';

export const OUTPUT_KEEP_BYTES = 2 * 1024 * 1024; // what is copied beside the run record
const DEPLOY_MAX_BYTES = 8 * 1024 * 1024; // what one inline upload may carry
export const projectName = (product) => `cambrian-${product}`;

/**
 * The static output of a built clone: `dist/` if it exists, else the repository root. Dotfiles, node_modules
 * and symbolic links are left out. → {root: 'dist'|'.', files: [{rel, abs, size}], bytes}
 */
export function outputFiles(buildDir) {
  const root = existsSync(join(buildDir, 'dist')) && lstatSync(join(buildDir, 'dist')).isDirectory() ? 'dist' : '.';
  const top = root === '.' ? buildDir : join(buildDir, root);
  const files = [];
  const walk = (dir, rel) => {
    for (const n of readdirSync(dir).sort()) {
      if (n.startsWith('.') || n === 'node_modules') continue;
      const abs = join(dir, n), r = rel ? `${rel}/${n}` : n;
      const st = lstatSync(abs);
      if (st.isDirectory()) walk(abs, r);
      else if (st.isFile()) files.push({ rel: r, abs, size: st.size });
    }
  };
  walk(top, '');
  return { root, files, bytes: files.reduce((s, f) => s + f.size, 0) };
}

/** Deploy `files` ([{rel, abs}]) as the preview of <product>. Never throws. */
export async function deployPreview(
  cfg,
  { product, files, ticket = null, commit = null },
  { fetchImpl = fetch, log = () => {}, sleep = null } = {},
) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const failed = (why, extra = {}) => ({ state: 'failed', why, public: false, ...extra });
  const ts = tokenState(cfg.vercel_token_file);
  if (!ts.ok) return failed(`no usable Vercel token (${ts.why})`);
  if (!files?.length) return failed('the build left no static file to deploy');
  const bytes = files.reduce((s, f) => s + (f.size ?? 0), 0);
  if (bytes > DEPLOY_MAX_BYTES) {
    return failed(`the static output is ${bytes} bytes; more than one inline upload carries (${DEPLOY_MAX_BYTES})`);
  }
  const token = readFileSync(cfg.vercel_token_file, 'utf8').trim();
  const scrub = (s) => String(s ?? '').split(token).join('[token]').replace(/\s+/g, ' ').slice(0, 200);
  const name = projectName(product);
  const team = String(cfg.vercel_team ?? '');
  const teamQuery = team ? `${team.startsWith('team_') ? 'teamId' : 'slug'}=${encodeURIComponent(team)}` : '';
  const api = async (method, path, body) => {
    const url = `${cfg.vercel_api}${path}${teamQuery ? (path.includes('?') ? '&' : '?') + teamQuery : ''}`;
    try {
      const r = await fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
      });
      const json = await r.json().catch(() => null);
      return { status: r.status, json, why: scrub(json?.error?.message ?? `HTTP ${r.status}`) };
    } catch (e) {
      return { status: 0, json: null, why: scrub(e.cause?.code ?? e.name ?? e.message) };
    }
  };

  try {
    // 1. the project exists
    const made = await api('POST', '/v11/projects', { name, framework: null });
    if (![200, 201, 409].includes(made.status)) return failed(`Vercel did not make the project ${name}: ${made.why}`);
    // 2. deployment protection off, read back from the answer. A plan without password protection
    //    refuses that field, so the request is retried without it.
    let open = await api('PATCH', `/v9/projects/${encodeURIComponent(name)}`, { ssoProtection: null, passwordProtection: null });
    if (open.status !== 200) open = await api('PATCH', `/v9/projects/${encodeURIComponent(name)}`, { ssoProtection: null });
    if (open.status !== 200) return failed(`deployment protection could not be turned off for ${name}: ${open.why}`);
    if (open.json?.ssoProtection != null || open.json?.passwordProtection != null) {
      return failed(`Vercel answered 200 but ${name} still has deployment protection on`);
    }
    // 3. the deployment: every file inline
    const body = {
      name,
      project: name,
      projectSettings: { framework: null },
      files: files.map((f) => ({ file: f.rel, data: readFileSync(f.abs).toString('base64'), encoding: 'base64' })),
      meta: { ...(ticket ? { ticket: String(ticket) } : {}), ...(commit ? { commit: String(commit) } : {}) },
    };
    const dep = await api('POST', '/v13/deployments?skipAutoDetectionConfirmation=1', body);
    if (![200, 201].includes(dep.status) || !dep.json?.id || !dep.json?.url) {
      return failed(`Vercel did not accept the deployment: ${dep.why}`);
    }
    const id = dep.json.id;
    const host = String(dep.json.url).replace(/^https?:\/\//, '');
    if (!/^[a-z0-9][a-z0-9.-]*\.vercel\.app$/.test(host)) {
      return failed('Vercel named a host that is not a vercel.app address', { deployment_id: id });
    }
    log(`preview: deployment ${id} created for ${name} (${files.length} files, ${bytes} bytes)`);
    // 4. READY
    const t0 = Date.now();
    let state = dep.json.readyState ?? dep.json.status ?? null;
    while (state !== 'READY') {
      if (['ERROR', 'CANCELED'].includes(state)) return failed(`the deployment ended ${state}`, { deployment_id: id });
      if ((Date.now() - t0) / 1000 >= cfg.preview_wait_seconds) {
        return failed(`the deployment was still ${state ?? 'unread'} after ${cfg.preview_wait_seconds}s`, { deployment_id: id });
      }
      await wait(cfg.preview_poll_seconds * 1000);
      const look = await api('GET', `/v13/deployments/${encodeURIComponent(id)}`);
      if (look.status === 200) state = look.json?.readyState ?? look.json?.status ?? state;
      else if (look.status >= 400 && look.status < 500) {
        return failed(`the deployment could not be read: ${look.why}`, { deployment_id: id });
      }
    }
    // 5. the proof: no credential, expect 200
    const url = `https://${host}`;
    //    A deployment that has just become READY can answer 404 for a few seconds while its address spreads,
    //    so a 404 is asked again a few times. A sign-in wall (401, a redirect) is never retried into a pass.
    let anon;
    for (let look = 1; look <= 8; look++) {
      try {
        anon = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000) });
      } catch (e) {
        return failed(`the preview address could not be read: ${scrub(e.cause?.code ?? e.name ?? e.message)}`, { deployment_id: id });
      }
      if (anon.status !== 404) break;
      await wait(Math.min(cfg.preview_poll_seconds, 5) * 1000);
    }
    if (anon.status !== 200) {
      return failed(`the preview answers ${anon.status} without a sign-in, so it is not public`, { deployment_id: id });
    }
    return { state: 'success', url, deployment_id: id, public: true };
  } catch (e) {
    return failed(`the preview step stopped on an error: ${scrub(e.message)}`);
  }
}
