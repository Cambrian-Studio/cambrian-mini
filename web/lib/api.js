// The data layer. Every read is a relative GET of a JSON document under api/, so the same UI works
// from the running server and from the static replay build in any subdirectory.

let info = null;
const cache = new Map();

async function read(url) {
  let res;
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } });
  } catch {
    throw new Error(`Could not reach ${url}.`);
  }
  if (!res.ok) throw new Error(`${url} answered ${res.status}.`);
  try {
    return await res.json();
  } catch {
    throw new Error(`${url} is not JSON.`);
  }
}

// Reads api/mode.json. Until it has been read, and if it cannot be read, the app is in replay:
// nothing spends and nothing signs.
export async function init() {
  info = await read('api/mode.json');
  return info;
}

const SAFE = { mode: 'replay', can_spend: false, can_sign: false, guest_proposals: false, reasons: [] };
export const mode = () => info || SAFE;
export const isLive = () => mode().mode === 'live';

// GET a JSON document by its name under api/. Cached per page load unless `fresh` is set.
export function get(name, { fresh = false } = {}) {
  if (fresh) cache.delete(name);
  if (!cache.has(name)) {
    const p = read('api/' + name);
    cache.set(name, p);
    p.catch(() => cache.delete(name));
  }
  return cache.get(name);
}

export const forget = (...names) => names.forEach((n) => cache.delete(n));
export const forgetAll = () => cache.clear();

// POST to a live-only route. The caller checks the mode first; this refuses anyway in replay.
// A refusal throws an Error whose message is the server's reason and whose `body` is its JSON.
export async function post(name, body) {
  if (!isLive()) throw new Error('This is a replay: nothing is sent.');
  let res;
  try {
    res = await fetch('api/' + name, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } catch {
    throw new Error('The server did not answer.');
  }
  let json = null;
  try { json = await res.json(); } catch { /* an empty body is handled below */ }
  if (!res.ok) {
    const err = new Error(json?.why || json?.error || `The server answered ${res.status}.`);
    err.body = json;
    throw err;
  }
  return json || {};
}

// Subscribes to the live event stream. Returns a function that closes it.
export function events(onEvent) {
  if (!isLive() || typeof EventSource === 'undefined') return () => {};
  const es = new EventSource('api/events');
  es.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg && typeof msg.type === 'string') onEvent(msg);
    } catch { /* a line that is not JSON is ignored */ }
  };
  return () => es.close();
}
