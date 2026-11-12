// http.mjs — the few HTTP helpers the server and the LIVE handlers share.
export const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8' };
export const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-opener-policy': 'same-origin' };

export const sendJson = (res, status, body) => { res.writeHead(status, { 'content-type': TYPES['.json'], 'cache-control': 'no-store', ...SECURITY }); res.end(JSON.stringify(body)); };
