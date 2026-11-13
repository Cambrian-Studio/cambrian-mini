// intent.mjs — "Talk to Cambrian" has no modes: one message, and Cambrian works out what it is.
// The brief model reads the message with the built products and their runs as context and names ONE intent:
// a new product, a revision of an existing product (design pass, fix or feature), or a question.
// The model proposes; this code decides. A revision must name a product that is in the record, or the member
// gets one short question back instead of a brief. Nothing here starts a build.
export const INTENTS = ['new', 'revision', 'question'];
export const REVISION_KINDS = ['design-pass', 'fix', 'feature'];
export const INTENT_MAX_TOKENS = 1200;
const flat = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

export const INTENT_SYSTEM = [
  'You are Cambrian, a collective\'s product studio. A member wrote one message. Say what it is, as ONE JSON object and nothing else.',
  'Fields:',
  '  "intent": "new" (an idea for a product that does not exist yet), "revision" (a change to a product in the list below:',
  '            a design pass, a fix or a feature), "question" (they ask something and want an answer, not a build),',
  '            or "unclear" (you cannot tell which)',
  '  "product": for a revision, the product they mean, as they wrote it or as its id; otherwise null',
  '  "kind": for a revision, "design-pass" (how it looks or feels), "fix" (something is wrong) or "feature" (something new in it)',
  '  "answer": for a question, one plain sentence answering from the facts below, or saying it is not in the record',
  '  "ask": for unclear, one short question that would settle it',
  'Use only the facts below. Never invent a product, a number or a link.',
].join('\n');

/** The record as the model sees it: each product with its builds, oldest first. Plain text, no private fields. */
export function recordContext(products = [], runs = []) {
  if (!products.length) return 'There are no products yet.';
  return ['Products and their builds:', ...products.map((p) => {
    const mine = runs.filter((r) => (r.product ?? r.ticket?.product) === p.id);
    const told = mine.map((r) => `${r.id ?? r.ticket?.id} "${r.title ?? r.ticket?.title ?? ''}" ${/^green/.test(String(r.state)) ? 'passed' : 'failed'}`);
    return `- ${p.id}${p.name && p.name !== p.id ? ` (${p.name})` : ''}: ${p.tagline ?? 'no description'}. `
      + (told.length ? `Builds: ${told.join('; ')}.` : 'No builds.');
  })].join('\n');
}

/** One line in the house voice: no exclamation marks, no dashes used as punctuation, no line breaks. */
export function plainLine(text, max = 240) {
  const s = String(text ?? '').replace(/\s+/g, ' ').replace(/!+/g, '.').replace(/\s*[—–]\s*/g, ', ').replace(/\.{2,}/g, '.').trim();
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;
}

const KIND_WORDS = { 'design-pass': 'A design pass', fix: 'A fix', feature: 'A feature' };
/** What Cambrian says once a brief is drafted. Past tense, one line. */
export function replyLine({ intent, kind, productName, title }) {
  if (intent === 'revision') return `${KIND_WORDS[kind] ?? 'A revision'} on ${productName}. I drafted a revision brief from your notes.`;
  return plainLine(`A new product${title ? `, ${title}` : ''}. I drafted a brief from your idea.`);
}

function pull(text) {
  const s = String(text ?? ''); const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

/**
 * message → { ok:true, intent:'new' }
 *         | { ok:true, intent:'revision', kind, product, parent }   product is from the record; parent is its latest passing build (or latest build)
 *         | { ok:true, intent:'question', answer }                  one plain line
 *         | { ok:true, intent:'ask', ask }                          unclear, or a revision of a product that is not in the record
 *         | { ok:false, why }                                       the model did not answer
 * Always carries usd and model. deps: chat({messages,max_tokens}), products, runs (run summaries).
 */
export async function classifyIntent(message, { chat, products = [], runs = [] }) {
  const text = String(message ?? '').trim();
  const messages = [{ role: 'system', content: `${INTENT_SYSTEM}\n\n${recordContext(products, runs)}` }, { role: 'user', content: text }];
  const r = await chat({ messages, max_tokens: INTENT_MAX_TOKENS });
  const meta = { usd: r.usd ?? 0, model: r.model ?? null };
  if (!r.ok) return { ok: false, why: `The model did not answer (${String(r.why ?? r.status ?? 'no detail').slice(0, 120)}).`, ...meta };
  const j = pull(r.content);
  const intent = INTENTS.includes(j?.intent) ? j.intent : 'unclear';
  if (intent === 'new') return { ok: true, intent: 'new', ...meta };
  if (intent === 'question') {
    const answer = plainLine(j.answer);
    return answer ? { ok: true, intent: 'question', answer, ...meta } : { ok: true, intent: 'ask', ask: 'What would you like to know?', ...meta };
  }
  if (intent === 'revision') {
    const product = products.find((p) => flat(p.id) === flat(j.product) || flat(p.name) === flat(j.product));
    if (!product) {
      const known = products.map((p) => p.name ?? p.id);
      const named = plainLine(j.product, 40);
      return { ok: true, intent: 'ask', ...meta, ask: known.length
        ? `I have no product called ${named || 'that'} on record. Did you mean ${known.join(' or ')}, or is this a new product?`
        : 'There is no product on record to revise yet. Is this a new product?' };
    }
    const mine = runs.filter((x) => (x.product ?? x.ticket?.product) === product.id)
      .sort((a, b) => String(a.finished ?? a.started ?? '').localeCompare(String(b.finished ?? b.started ?? '')));
    const parent = mine.filter((x) => /^green/.test(String(x.state))).at(-1) ?? mine.at(-1) ?? null;
    if (!parent) return { ok: true, intent: 'ask', ...meta, ask: `${product.name ?? product.id} has no build on record to revise. Should this be its first build?` };
    return { ok: true, intent: 'revision', kind: REVISION_KINDS.includes(j.kind) ? j.kind : 'feature', product, parent, ...meta };
  }
  return { ok: true, intent: 'ask', ask: plainLine(j?.ask) || 'Is this a new product, a change to an existing one, or a question?', ...meta };
}
