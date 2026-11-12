// The three messages and how they leave: plain words, escaped values, and Telegram only when asked for.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { greenMessage, limitHit, redMessage, waitingMessage } from '../../line/messages.mjs';
import { notify, telegramTarget } from '../../line/notify.mjs';
import { scratch } from './helpers.mjs';

const ticket = { id: 'facts-page-1', product: 'facts-page', title: 'Five <facts> & more', branch: 'build/facts-page-1' };
const rec = (over = {}) => ({
  ticket: { budget: { usd: 1.5, calls: 60, minutes: 20 }, checks: ['a', 'b'] },
  main: { untouched: true },
  attempts: [{ failing: [], bridge: { computed_usd: 0.1234, forwarded: 3 }, agent: { exit: 0, seconds: 30 } }],
  ...over,
});
const INTERNAL = /\b(Writes|desk|design-pass|proposal|gateway|canon)\b/i;

test('GREEN: what happened, one labelled link, the next action, details — in text and in HTML', () => {
  const m = greenMessage({ rec: rec(), ticket, preview: { state: 'success', url: 'https://x.vercel.app/?a=1&b=2' }, commit: 'abcdef1234' });
  assert.deepEqual(m.html.split('\n').map((l) => l.split(/[ :]/)[0]), ['facts-page', '', '<a', '', 'Next', '', 'Details']);
  assert.match(m.html, /“Five &lt;facts&gt; &amp; more” passed all checks on the first attempt\./);
  assert.match(m.html, /<a href="https:\/\/x\.vercel\.app\/\?a=1&amp;b=2">Open the preview<\/a> \(public, no sign-in needed\)/);
  assert.match(m.text, /“Five <facts> & more”/);
  assert.match(m.text, /Open the preview: https:\/\/x\.vercel\.app\/\?a=1&b=2 \(public/);
  assert.match(m.text, /Next: open the receipt in the app\./);
  assert.match(m.text, /Details: build\/facts-page-1 @ abcdef1 · main untouched · \$0\.12 · 3 calls/);
  assert.ok(!m.text.includes('<a ') && !m.text.includes('&amp;'), 'no markup in the text form');
  const none = greenMessage({ rec: rec(), ticket, preview: { state: 'skipped', why: 'offline' }, commit: 'abcdef1234' });
  assert.match(none.text, /No preview was published: offline\./);
  assert.ok(!none.html.includes('<a '));
});

test("RED and WAITING: no link, the next action in the app's words, no internal vocabulary", () => {
  const twice = rec({ attempts: [{ failing: ['a'], bridge: {} }, { failing: ['a'], bridge: {} }] });
  const red = redMessage({ rec: twice, ticket, waiting: 'RED twice — the same failure both times: a.' });
  assert.match(red.text, /did not build: “Five <facts> & more” failed twice, the same way\. Nothing was pushed; main is untouched\./);
  assert.match(red.text, /Next: accept or reject the drafted lesson on the Lessons screen\./);
  assert.match(red.text, /Details: failing a · 2 attempts/);
  const push = redMessage({ rec: rec(), ticket, waiting: "RED — the push was refused: refusing to push 'main'." });
  assert.match(push.text, /passed its checks, but the push was refused\. Nothing was pushed; main is untouched\./);
  const refused = waitingMessage({
    rec: rec({ attempts: [] }),
    ticket,
    state: 'refused',
    waiting: 'not released by the council: 1 of 3 valid approvals; 2 are required. Nothing ran.',
  });
  assert.match(refused.text, /was not started: the council has not released it\. Nothing ran and nothing was pushed\./);
  assert.match(refused.text, /Next: two council members approve the ticket in the app/);
  assert.match(refused.text, /Details: not released by the council: 1 of 3 valid approvals; 2 are required\.$/);
  const blocked = waitingMessage({ rec: rec({ attempts: [] }), ticket, state: 'blocked', waiting: 'daily ceiling: … Nothing ran.' });
  assert.match(blocked.text, /stopped before the agent started\. Nothing ran and nothing was spent\./);
  for (const m of [red, push, refused, blocked]) {
    assert.ok(!m.html.includes('<a '), 'no link');
    assert.ok(!INTERNAL.test(m.text), m.text);
  }
});

test('limitHit names the limit that ended the attempts, or none', () => {
  assert.equal(limitHit(rec()), null);
  assert.equal(limitHit(rec({ attempts: [{ agent: { exit: 142 }, bridge: {} }] })).what, 'time');
  assert.equal(limitHit(rec({ attempts: [{ agent: { exit: 0 }, bridge: { forwarded: 59 } }] })).what, 'calls');
  assert.equal(limitHit(rec({ attempts: [{ agent: { exit: 0 }, bridge: { computed_usd: 1.46, forwarded: 5 } }] })).what, 'spend');
});

test('notify: returned for the record by default; printed with stdout; Telegram only when BOTH variables are set', async () => {
  const s = scratch('notify');
  try {
    const m = { text: 'plain words', html: '<b>plain</b> words' };
    const printed = [];
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return { status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    };
    const quiet = await notify({ notify: 'memory' }, 'GREEN', m, { fetchImpl, out: (l) => printed.push(l), env: {} });
    assert.deepEqual(quiet, { kind: 'GREEN', text: 'plain words', html: '<b>plain</b> words', sent: true, via: 'memory', why: null });
    assert.deepEqual([printed.length, calls.length], [0, 0]);
    await notify({ notify: 'stdout' }, 'BUDGET', '$2.50 of $5.00 today, 1 run', { fetchImpl, out: (l) => printed.push(l), env: {} });
    assert.deepEqual(printed, ['[BUDGET] BUDGET · $2.50 of $5.00 today, 1 run']);
    // one variable alone is not enough
    const tokenFile = join(s.dir, 'bot.token');
    writeFileSync(tokenFile, 'stub-bot-token\n', { mode: 0o600 });
    assert.equal(telegramTarget({ TELEGRAM_BOT_TOKEN_FILE: tokenFile }), null);
    assert.equal(telegramTarget({ TELEGRAM_CHAT_ID: '424242' }), null);
    await notify({ notify: 'memory' }, 'RED', m, { fetchImpl, env: { TELEGRAM_CHAT_ID: '424242' } });
    assert.equal(calls.length, 0);
    // both set: sent, and the token (which sits in the URL) is in nothing that comes back
    const env = { TELEGRAM_BOT_TOKEN_FILE: tokenFile, TELEGRAM_CHAT_ID: '424242' };
    const sent = await notify({ notify: 'memory', telegram_api: 'https://telegram.test' }, 'RED', m, { fetchImpl, env });
    assert.deepEqual([sent.sent, sent.via], [true, 'telegram']);
    assert.ok(!JSON.stringify(sent).includes('stub-bot-token'));
    assert.equal(calls[0].url, 'https://telegram.test/botstub-bot-token/sendMessage');
    assert.deepEqual([calls[0].body.chat_id, calls[0].body.parse_mode], ['424242', 'HTML']);
    // a failure is never silent, and never throws
    const down = await notify({ notify: 'memory', telegram_api: 'https://telegram.test' }, 'RED', m, {
      fetchImpl: async () => {
        throw new Error('offline');
      },
      env,
    });
    assert.deepEqual([down.sent, down.via], [false, 'telegram']);
    assert.match(down.why, /telegram not reached/);
    assert.ok(!down.why.includes('stub-bot-token'));
    writeFileSync(join(s.dir, 'loose.token'), 'stub-bot-token\n', { mode: 0o644 });
    const loose = await notify({ notify: 'memory' }, 'RED', m, {
      fetchImpl,
      env: { ...env, TELEGRAM_BOT_TOKEN_FILE: join(s.dir, 'loose.token') },
    });
    assert.equal(loose.sent, false);
    assert.match(loose.why, /must be 600/);
  } finally {
    s.cleanup();
  }
});
