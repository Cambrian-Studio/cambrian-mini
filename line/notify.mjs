// notify.mjs — how a message leaves the line. Every notification is RETURNED, so the caller writes it
// into the run record and the app can show it as a toast and in its list.
//   memory   (default) nothing else happens
//   stdout   the text is also printed
//   telegram only when TELEGRAM_BOT_TOKEN_FILE and TELEGRAM_CHAT_ID are both set in the environment; off by default
// A notification that could not be sent is never silent: it comes back {sent:false, why}. Telegram's API puts
// the bot token in the request URL, so no URL is ever logged or returned.
import { readFileSync, statSync } from 'node:fs';

const readMode600 = (p, what) => {
  let st;
  try {
    st = statSync(p);
  } catch {
    throw new Error(`${what} is not placed at ${p}`);
  }
  if ((st.mode & 0o777) !== 0o600) throw new Error(`${what} at ${p} is mode ${(st.mode & 0o777).toString(8)}, must be 600`);
  const t = readFileSync(p, 'utf8').trim();
  if (!t) throw new Error(`${what} at ${p} is empty`);
  if (/[^\x21-\x7e]/.test(t)) throw new Error(`${what} at ${p} holds non-printing bytes`);
  return t;
};

/** The Telegram target from the environment, or null when it is not fully configured. */
export function telegramTarget(env = process.env) {
  const file = env.TELEGRAM_BOT_TOKEN_FILE, chat = env.TELEGRAM_CHAT_ID;
  if (!file || !chat) return null;
  return { tokenFile: file, chat: String(chat) };
}

/**
 * kind: 'GREEN' | 'RED' | 'WAITING' | 'BUDGET'. message: {text, html} (messages.mjs) or a plain string.
 * → {kind, text, html, sent, via, why}. Never throws.
 */
export async function notify(cfg, kind, message, { fetchImpl = fetch, out = console.log, env = process.env } = {}) {
  const scrub = (s) => String(s ?? '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ').slice(0, 3500);
  const plain = typeof message === 'string';
  const text = scrub(plain ? `${kind} · ${message}` : message.text);
  const html = scrub(plain ? `${kind} · ${message}`.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') : message.html);
  const base = { kind, text, html };
  if ((cfg.notify ?? 'memory') === 'stdout') out(`[${kind}] ${text}`);
  const tg = telegramTarget(env);
  if (!tg) return { ...base, sent: true, via: cfg.notify ?? 'memory', why: null };
  let token;
  try {
    token = readMode600(tg.tokenFile, 'the bot token');
    if (!/^-?\d{3,20}$/.test(tg.chat)) throw new Error('TELEGRAM_CHAT_ID is not a chat id (a number)');
  } catch (e) {
    return { ...base, sent: false, via: 'telegram', why: String(e.message) };
  }
  try {
    const r = await fetchImpl(`${cfg.telegram_api}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: tg.chat, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!j.ok) {
      return {
        ...base,
        sent: false,
        via: 'telegram',
        why: `telegram answered ${r.status}: ${String(j.description ?? 'no description').slice(0, 160)}`,
      };
    }
    return { ...base, sent: true, via: 'telegram', why: null };
  } catch (e) {
    return {
      ...base,
      sent: false,
      via: 'telegram',
      why: `telegram not reached: ${String(e.cause?.code ?? e.name ?? e.message).slice(0, 80)}`,
    };
  }
}
