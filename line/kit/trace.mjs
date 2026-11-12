#!/usr/bin/env node
// trace.mjs — one readable per-step trace of an attempt, merged by time from the bridge's line per model
// call and OpenCode's own event stream (one event per tool step). Names, sizes, exit codes and the first
// 100 characters of a command or path — no file contents, no message text.
// Usage: trace.mjs <bridge-trace.jsonl> <opencode-events.jsonl>
import { existsSync, readFileSync } from 'node:fs';

const [bridgeFile, eventsFile] = process.argv.slice(2);
const rows = [];
const parse = (l) => {
  try {
    return JSON.parse(l);
  } catch {
    return null;
  }
};
const lines = (f) => (f && existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean).map(parse).filter(Boolean) : []);
const cut = (s, n = 100) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

for (const b of lines(bridgeFile)) {
  const t = Date.parse(b.t);
  if (b.kind === 'model' && b.refused) rows.push([t, 'bridge', `REFUSED ${b.status}: ${b.refused}`]);
  else if (b.kind === 'model') {
    const asks = b.tool_calls?.length
      ? ', asks ' + b.tool_calls.map((c) => `${c.name}(${c.hint ?? c.arg_bytes + ' bytes'})`).join(' + ')
      : '';
    const cached = b.usage?.prompt_tokens_details?.cached_tokens ? ' cached ' + b.usage.prompt_tokens_details.cached_tokens : '';
    rows.push([
      t,
      'model',
      `call ${b.seq}: ${b.status} ${b.model_served ?? b.model_asked} ${b.ms} ms, ${b.messages} messages, ` +
      `${b.tools_offered} tools offered → finish ${b.finish}${asks}${b.text_chars ? `, ${b.text_chars} chars of text` : ''}; ` +
      `tokens in ${b.usage?.prompt_tokens ?? '?'} out ${b.usage?.completion_tokens ?? '?'}${cached}; ` +
      `$${(b.usd ?? 0).toFixed(4)} (run $${(b.spent_usd ?? 0).toFixed(4)})${b.unpriced ? ' UNPRICED' : ''}${
        b.error ? ' ERROR ' + b.error : ''
      }`,
    ]);
  } else if (b.kind === 'egress') {
    rows.push([t, 'tunnel', `${b.method} ${b.target} → ${b.allowed ? `allowed (${b.up} up, ${b.down} down)` : 'REFUSED'}`]);
  } else if (b.kind === 'bridge') {
    rows.push([
      t,
      'bridge',
      b.event === 'up'
        ? `up: session ${b.session}, budget ${b.max_calls} calls / $${b.max_usd}`
        : `down: ${b.forwarded} forwarded, ${b.refused} refused, computed $${b.computed_usd}`,
    ]);
  }
}
for (const e of lines(eventsFile)) {
  const p = e.part ?? {};
  if (e.type === 'tool_use') {
    const s = p.state ?? {};
    const i = s.input ?? {};
    const what = i.command ?? i.filePath ?? i.file_path ?? i.path ?? i.pattern ?? i.description ?? '';
    const exit = s.metadata?.exit !== undefined ? ' exit ' + s.metadata.exit : '';
    const took = s.time ? ` ${s.time.end - s.time.start} ms` : '';
    rows.push([
      s.time?.end ?? e.timestamp,
      'tool',
      `${p.tool}(${cut(what)}) → ${s.status}${exit}${took}${s.status === 'error' ? ' — ' + cut(s.error, 120) : ''}`,
    ]);
  } else if (e.type === 'text') rows.push([e.timestamp, 'agent', `says ${String(p.text ?? '').length} chars`]);
  else if (e.type === 'step_finish') rows.push([e.timestamp, 'step', `finish ${p.reason}`]);
  else if (e.type === 'error') rows.push([e.timestamp, 'agent', `ERROR ${cut(JSON.stringify(e.error ?? e), 200)}`]);
}
rows.sort((a, b) => a[0] - b[0]);
for (const [t, kind, text] of rows) console.log(`${new Date(t).toISOString().slice(11, 23)}Z  ${kind.padEnd(6)} ${text}`);
