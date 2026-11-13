// brief.mjs — "Talk to Cambrian": an idea in a sentence becomes a BRIEF the council can approve.
// The model drafts; this code decides. Whatever the model writes is parsed as a ticket (tickets/ticket.mjs),
// clamped to the budget rules and linted against every lesson learned so far (lessons/lessons.mjs).
// A draft the rules refuse is redrafted once with the reasons; if it is refused again the member is told why.
// Nothing here starts a build: a brief only becomes a ticket on the line after 2 of 3 council signatures.
import { parseTicket } from './ticket.mjs';

export const MAX_IDEA = 600;
// The brief is written by an open model that NEAR AI hosts inside a TEE, so its answer can be signed there.
export const BRIEF_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017';
export const BRIEF_MAX_TOKENS = 4000;   // the model's reasoning tokens count against this too
const HEX64 = /^[0-9a-f]{64}$/;
const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'idea';

export const BRIEF_SYSTEM = [
  'You are Cambrian, a collective\'s product line. A member gives you an idea. You answer with ONE build brief as a JSON object and nothing else.',
  'The brief is for a small autonomous coding agent working alone for a few minutes, with no network except the npm registry.',
  'Keep it to ONE small feature: a static web page or a tiny tool that builds with no dependencies unless truly needed.',
  'Fields:',
  '  "product": short id, a-z 0-9 - (reuse an existing product id when the idea extends that product)',
  '  "title": at most 72 characters, no money figures',
  '  "goal": one sentence a member would recognise as their idea',
  '  "task": the instructions for the builder, concrete, 3 to 10 sentences, naming the files to produce; say what is out of scope',
  '  "out_of_scope": list of 1 to 5 short strings',
  '  "green": 2 to 5 acceptance checks. Each is one of',
  '     {"id","kind":"file","path":"index.html","contains":["exact text"],"name":"plain words"}',
  '     {"id","kind":"run","run":"node test.mjs","name":"plain words"}   (exit 0, no network)',
  '     {"id","kind":"file","path":"index.html","not_matches":["https?://"],"name":"plain words"}  (a regex the file must not match)',
  '     {"id","kind":"no_external_hosts","dir":"dist","name":"plain words"} (a built subdirectory only; never "." )',
  '  "budget": {"usd": number up to 2, "calls": integer up to 40, "minutes": integer up to 15}',
  'Checks must be things the built files can actually satisfy. Output JSON only: no prose, no code fence.',
].join('\n');

/** Pull the first JSON object out of a model answer (it may arrive fenced or with a stray sentence). */
export function extractJson(text) {
  const s = String(text ?? ''); const start = s.indexOf('{'); const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('the model answered without a JSON object');
  return JSON.parse(s.slice(start, end + 1));
}

/** Model draft → a ticket-shaped brief with an id of ours. Throws naming the first thing wrong. */
export function shapeBrief(draft, { idSuffix, capUsd = 5, revision = null, conversation = null }) {
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) throw new Error('the draft is not an object');
  // a revision stays on its parent's product, whatever the model wrote
  const product = revision ? revision.product : slug(draft.product);
  const id = `${product}-${idSuffix}`.slice(0, 40).replace(/-+$/, '');
  const budget = { usd: Math.min(Number(draft.budget?.usd) || 1, 2, capUsd), calls: Math.min(Math.trunc(Number(draft.budget?.calls)) || 30, 40),
    minutes: Math.min(Math.trunc(Number(draft.budget?.minutes)) || 10, 15) };
  return parseTicket({ kind: 'build-ticket', v: 1, id, product, title: String(draft.title ?? '').slice(0, 72), goal: draft.goal, task: draft.task,
    out_of_scope: draft.out_of_scope, green: draft.green, budget, ...(revision ? { revision } : {}),
    ...(conversation ? { conversation } : {}) });
}

/** What the model is told when the message revises a product: the build it revises, and that the notes become checks. */
export function revisionBlock({ kind, product, parent }) {
  const t = parent?.ticket ?? {};
  return [`This message is a ${kind.replace('-', ' ')} on the existing product "${product.id}"${product.tagline ? ` (${product.tagline})` : ''}.`,
    `It revises the build ${t.id ?? parent?.id}: "${t.title ?? parent?.title ?? ''}". The files of that build are already in the working directory.`,
    'Write a REVISION brief: "product" must be exactly "' + product.id + '". The task changes what exists and keeps everything else working.',
    'Each note in the member\'s message becomes one acceptance check in "green", named in the member\'s own words.',
    Array.isArray(t.checks) && t.checks.length ? `The parent build was checked by: ${t.checks.join(', ')}.` : null].filter(Boolean).join('\n');
}

/**
 * idea → { ok, brief, lint, usd, calls, model, attempts, call } | { ok:false, why, lint?, usd }
 * @param {object} deps  chat({messages,max_tokens}) → {ok, content, usd, model, id, request_sha256, response_sha256,
 *                       request_body, response_body}; lessons: [..]; lintBrief; lessonsBlock; products; existing; idSuffix
 *
 * `call` describes the ONE model call whose answer became the brief (the accepted draft, not a refused one):
 * { model, completion_id, request_sha256, response_sha256, request_body, response_body }. Its first four
 * fields are also written into the brief as `drafted`, so the ticket hash the council signs covers the hash
 * of that exact model response.
 *
 * What that binding says: this ticket names, by hash, the model response it was made from.
 * What it does NOT say: that the ticket is that response byte for byte. The ticket is DERIVED from it by
 * this code: the JSON is pulled out of the answer, the id is ours, the budget is clamped, and a lesson may
 * append a line to the task. The raw response is kept beside the ticket so anyone can compare the two.
 * A chat that reports no completion id or hashes gives a brief with no `drafted` and `call: null`.
 */
export async function draftBrief(idea, deps) {
  const text = String(idea ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ').trim();
  if (text.length < 8) return { ok: false, why: 'Say a little more: one or two sentences about what should exist.', usd: 0 };
  const { chat, lessons = [], lintBrief, lessonsBlock, products = [], existing = [], idSuffix, capUsd, revision = null, house = null,
    conversation = null, maxIdea = MAX_IDEA } = deps;
  if (text.length > maxIdea) return { ok: false, why: `Keep the idea under ${maxIdea} characters; a brief is one small feature.`, usd: 0 };
  const block = lessonsBlock ? lessonsBlock(lessons, ['brief', 'ticket']) : null;
  const known = products.length ? `Existing products: ${products.map((p) => p.id).join(', ')}.` : 'There are no products yet.';
  // revision: { kind, product, parent, by, attachments } from the intent step; its ticket field is built here, not by the model
  const rev = revision ? { of: revision.parent?.ticket?.id ?? revision.parent?.id, kind: revision.kind, by: revision.by, product: revision.product.id,
    ...(revision.attachments?.length ? { attachments: revision.attachments } : {}) } : null;
  const fromTalk = conversation ? 'The user message is a conversation between a member and Cambrian. Draft the brief they converged on: '
    + 'what it is, who it is for, the one thing it must do, the checks and the budget. The latest instructions win over earlier turns.' : null;
  const messages = [{ role: 'system', content: [BRIEF_SYSTEM, known, fromTalk, revision ? revisionBlock(revision) : null, house, block].filter(Boolean).join('\n\n') },
    { role: 'user', content: text }];
  let usd = 0, model = null, lint = null, why = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await chat({ messages, max_tokens: BRIEF_MAX_TOKENS });
    usd += r.usd ?? 0; model = r.model ?? model;
    if (!r.ok) return { ok: false, why: `The model did not answer (${String(r.why ?? r.status ?? 'no detail').slice(0, 120)}).`, usd, model };
    let brief;
    try { brief = shapeBrief(extractJson(r.content), { idSuffix, capUsd, revision: rev, conversation }); } catch (e) {
      why = `the draft was not a valid brief: ${e.message}`;
      messages.push({ role: 'assistant', content: String(r.content).slice(0, 4000) }, { role: 'user', content: `That was refused: ${why}. Send the corrected JSON only.` });
      continue;
    }
    // A brief may start a NEW product (a product begins with an approved brief). A near-miss of a recorded id
    // ("Up-Read" for "upread") is not new: it is checked against the record and corrected or refused there.
    const flat = (x) => String(x ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const isNew = !products.some((p) => flat(p.id) === flat(brief.product) || flat(p.name) === flat(brief.product));
    const known = isNew ? [...products, { id: brief.product, name: brief.product, proposed: true }] : products;
    lint = lintBrief ? lintBrief(brief, { lessons, products: known, existing }) : { brief, applied: [], refused: [], notes: [] };
    if (isNew) lint.notes = [...(lint.notes ?? []), `'${brief.product}' would be a new product; it is recorded when this brief is approved and built`];

    if (!lint.refused.length) {
      const bound = typeof r.id === 'string' && r.id && HEX64.test(String(r.request_sha256)) && HEX64.test(String(r.response_sha256));
      // the model id that was asked for is the one the TEE signs; the answer's own model field is only a fallback
      const drafted = bound ? { model: String(r.requested_model ?? r.model ?? model), completion_id: r.id,
        request_sha256: r.request_sha256, response_sha256: r.response_sha256 } : null;
      // a lesson may have changed the draft, and `drafted` is added: it must still be a valid ticket
      const fixed = parseTicket(drafted ? { ...lint.brief, drafted } : lint.brief);
      const call = drafted ? { ...drafted, request_body: r.request_body ?? null, response_body: r.response_body ?? null } : null;
      return { ok: true, new_product: isNew, brief: fixed, lint: { applied: lint.applied, refused: [], notes: lint.notes ?? [] },
        usd, model, attempts: attempt, call };
    }
    why = lint.refused.map((x) => x.why).join(' | ');
    messages.push({ role: 'assistant', content: String(r.content).slice(0, 4000) },
      { role: 'user', content: `That brief breaks rules learned from earlier runs: ${why}. Send a corrected, smaller JSON brief only.` });
  }
  return { ok: false, why: `Cambrian could not draft a brief that passes its own rules: ${why}`, lint, usd, model };
}
