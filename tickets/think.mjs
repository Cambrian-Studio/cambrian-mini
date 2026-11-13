// think.mjs — Talk to Cambrian is a conversation before it is a brief.
// Cambrian discusses the idea, pushes back, asks at most two questions a turn, and proposes scope and cuts.
// Nothing is a brief until the member says it is ready; then the brief is drafted FROM the conversation, and
// each further instruction makes a new draft version with its changes listed. The ticket that goes to the
// council names the conversation by hash, so the signatures cover what shaped it.
// PURE: no I/O. The model calls are passed in.
import { canonical, sha256Hex } from '../receipts/canonical.mjs';

export const MAX_TURN = 8000;          // characters in one member message
export const MAX_MEMBER_TURNS = 40;    // member messages in one conversation
export const MAX_QUESTIONS = 2;        // questions Cambrian may ask in one turn
export const THINK_MAX_TOKENS = 4000;   // an open model's reasoning tokens count against this too; 1200 left one with no text
// characters of conversation handed to the drafter and to the intent step: room for several full-length messages, so that
// no single message is ever cut before a model reads it
export const TRANSCRIPT_MAX = 40000;

export const THINK_SYSTEM = [
  'You are Cambrian, a product studio owned by its members. A member is thinking an idea through with you before anything is built.',
  'Your job in this conversation is to make the idea smaller, sharper and buildable. You are a colleague, not a form.',
  '- Say what you think. Push back when the idea is vague, too big, or already exists in the record below.',
  `- Ask at most ${MAX_QUESTIONS} questions in a turn, and only ones whose answers change what gets built.`,
  '- Propose scope: the one thing it must do, who it is for, and what to cut from the first build.',
  '- A first build is one small feature: a static page or a tiny tool, built by an agent working alone for a few minutes with no network.',
  '- Do not write the brief, a ticket, JSON or a checklist of acceptance checks. That happens when the member says it is ready.',
  '- When the idea is clear enough to build, say so in one sentence and tell them to say "ready" or press "Draft the brief".',
  'Voice: short plain sentences, no exclamation marks, no hype, no lists longer than three items. Keep a turn under 120 words.',
].join('\n');

/** The model messages for one thinking turn: the system text with the record and the rules, then the conversation so far. */
export function thinkMessages(conversation, { record = '', lessons = [], house = '' } = {}) {
  const rules = lessons.length ? `Rules learned from earlier builds, which the brief will be checked against:\n${lessons.map((l) => `- ${l.rule}`).join('\n')}` : '';
  return [{ role: 'system', content: [THINK_SYSTEM, record, rules, house].filter(Boolean).join('\n\n') },
    ...conversation.map((m) => ({ role: m.role === 'member' ? 'user' : 'assistant', content: m.text }))];
}

/** Does this message say "draft it now"? Short messages only: a long message that contains "ready" is still thinking. */
export function isReady(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/[.!\s]+$/, '');
  return s.length <= 40 && /^(ok[, ]+)?(it'?s |it is |i'?m |i am |we'?re |that'?s )?(ready|draft it|draft the brief|write the brief|draft|go ahead|build it|send it|looks good,? draft it)( now| then| please)?$/.test(s);
}

/** sha256 over the conversation as it stood: each message's role and exact text, in order. */
export const conversationHash = (messages) => sha256Hex(canonical(messages.map((m) => ({ role: m.role, text: m.text }))));

/** The conversation as one text for the drafter, newest kept when it is long. */
export function transcript(messages, max = TRANSCRIPT_MAX) {
  const lines = messages.map((m) => `${m.role === 'member' ? 'Member' : 'Cambrian'}: ${m.text}`);
  let out = lines.join('\n\n');
  while (out.length > max && lines.length > 1) { lines.shift(); out = `(earlier turns left out)\n\n${lines.join('\n\n')}`; }
  return out.slice(-max);
}

/**
 * Lets a streamed answer through one sentence at a time and holds the voice rules as it goes: no more than
 * MAX_QUESTIONS questions in a turn (a further question sentence is dropped), and no exclamation marks.
 * push(delta) → the text to show now ('' while a sentence is still open); end() → the rest. `text` is all that was let through.
 */
export function sentenceGate(maxQuestions = MAX_QUESTIONS) {
  let open = ''; let questions = 0;
  const gate = { text: '', dropped: 0 };
  const pass = (sentence) => {
    const s = sentence.replace(/!+/g, '.');
    if (/\?\s*$/.test(s)) { if (questions >= maxQuestions) { gate.dropped++; return ''; } questions++; }
    gate.text += s; return s;
  };
  gate.push = (delta) => {
    open += String(delta ?? ''); let out = '';
    for (;;) {
      const m = /^[\s\S]*?(?:[.?!]+(?=\s)|\n+)\s*/.exec(open);
      if (!m) break;
      out += pass(m[0]); open = open.slice(m[0].length);
    }
    return out;
  };
  gate.end = () => { const rest = open; open = ''; return rest ? pass(rest) : ''; };
  return gate;
}

const same = (a, b) => canonical(a ?? null) === canonical(b ?? null);
/** What changed between two draft versions, in plain words. [] when nothing did; ['First draft.'] for the first. */
export function briefChanges(prev, next) {
  if (!prev) return ['First draft.'];
  const out = [];
  if (prev.title !== next.title) out.push(`Title: “${prev.title}” became “${next.title}”.`);
  if (!same(prev.goal, next.goal)) out.push('The goal was reworded.');
  if (!same(prev.task, next.task)) out.push(`The task was rewritten (${prev.task.length} to ${next.task.length} characters).`);
  const names = (t) => new Map((t.green ?? []).map((c) => [c.id, c]));
  const a = names(prev); const b = names(next);
  for (const [id, c] of b) if (!a.has(id)) out.push(`Check added: ${c.name}.`);
  for (const [id, c] of a) if (!b.has(id)) out.push(`Check dropped: ${c.name}.`);
  for (const [id, c] of b) if (a.has(id) && !same(a.get(id), c)) out.push(`Check changed: ${c.name}.`);
  const scope = (t) => new Set(t.out_of_scope ?? []);
  for (const s of scope(next)) if (!scope(prev).has(s)) out.push(`Now out of scope: ${s}.`);
  for (const s of scope(prev)) if (!scope(next).has(s)) out.push(`No longer out of scope: ${s}.`);
  if (!same(prev.budget, next.budget)) out.push(`Budget: $${prev.budget.usd} became $${next.budget.usd}.`);
  return out.length ? out : ['Nothing changed in the brief.'];
}
