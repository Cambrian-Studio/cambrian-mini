// server.mjs — `npm start`. One small HTTP server, no framework:
//   GET  /            the UI (web/)
//   GET  /api/*.json  the record, straight from store.snapshot() — the same JSON the static REPLAY build ships
//   POST /api/*       LIVE only (app/live.mjs): propose an idea, approve with a passkey, enrol, accept a lesson
//   GET  /api/events  LIVE only: server-sent events while a run moves through the line
// With no NEAR AI key file the app is in REPLAY: every POST answers 409 with what the button would have done.
// It listens on 127.0.0.1 only.
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appConfig } from './config.mjs';
import { snapshot } from './store.mjs';
import { TYPES, SECURITY, sendJson } from './http.mjs';

export { sendJson };

/** A file under `root`, or null when the path escapes it or names no file. */
export function safeFile(root, urlPath) {
  let rel; try { rel = decodeURIComponent(urlPath.split('?')[0]); } catch { return null; }
  if (rel.includes('\0')) return null;
  const base = resolve(root); const p = resolve(join(base, normalize(rel)));
  if (p !== base && !p.startsWith(base + sep)) return null;
  const file = existsSync(p) && statSync(p).isDirectory() ? join(p, 'index.html') : p;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

export async function makeServer(cfg = appConfig()) {
  const web = join(cfg.root, 'web');
  const live = cfg.mode === 'live' ? await (await import('./live.mjs')).makeLive(cfg) : null;

  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      // Reachable from outside: one line per page load and per POST, so a member who cannot get in leaves a trace.
      // No address, no body and no token is written: the time, the path, the status, and whether it came through the tunnel.
      if (cfg.exposed && (path === '/' || req.method === 'POST')) {
        res.on('finish', () => console.log(`${new Date().toISOString()} ${req.method} ${path} ${res.statusCode} `
          + (req.headers['tailscale-funnel-request'] ? 'from outside' : 'from this network')));
      }
      if (req.method === 'GET' && path === '/api/events') return live ? live.events(req, res) : sendJson(res, 409, { error: 'replay', why: 'No live runs in REPLAY mode.' });
      if (req.method === 'GET' && path.startsWith('/api/')) {
        const snap = snapshot(cfg, live ? live.modeExtra() : {});
        const hit = snap[path.slice(1)];
        return hit === undefined ? sendJson(res, 404, { error: 'not found' }) : sendJson(res, 200, hit);
      }
      if (req.method === 'POST' && path.startsWith('/api/')) {
        if (!live) return sendJson(res, 409, { error: 'replay', why: 'This is REPLAY mode: recorded runs only. Nothing is sent to a model and nothing is signed. Run it with a NEAR AI key file to use this.' });
        return await live.post(path, req, res);
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
      // the one serialisation file the browser shares with the server
      const file = path === '/lib/canonical.mjs' ? join(cfg.root, 'receipts', 'canonical.mjs') : safeFile(web, path === '/' ? '/index.html' : path);
      if (!file) { res.writeHead(404, { 'content-type': TYPES['.txt'], ...SECURITY }); return res.end('not found\n'); }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY });
      if (req.method === 'HEAD') return res.end();
      createReadStream(file).pipe(res);
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: 'server error', why: String(e.message).slice(0, 200) }); else res.end();
    }
  });
  return { server, cfg, live };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, cfg } = await makeServer();
  server.listen(cfg.port, cfg.host, () => {
    console.log(`Cambrian Mini — ${cfg.mode.toUpperCase()} mode${cfg.reasons.length ? ` (${cfg.reasons.join('; ')})` : ''}`);
    console.log(`open http://localhost:${cfg.port}/`);
    if (cfg.mode === 'replay') console.log('REPLAY: recorded runs only. Nothing spends, nothing signs.');
  });
}
