// lessons.mjs — rules learned from earlier runs, and the checks they run over a new brief.
// lessons.json holds one entry per lesson: a rule in plain words and, where a machine can
// check it, the name of a check in this file. PURE: no I/O, no network (store.mjs does the I/O).
//   parseLessons(text)             the file's text → { lessons, error, problems };
//                                  a bad entry is skipped and named, never thrown
//   lessonsBlock(lessons, scopes)  the prompt block the model reads before it drafts a brief
//   lintBrief(brief, opts)         the checks over a drafted brief: fixes applied to a copy,
//                                  refusals named, each with the lesson that caused it
//   lintTicket(ticket, opts)       the same checks, only for lessons scoped to "ticket"

export const SCOPES = ['brief', 'ticket', 'chat'];
export const FIXES = ['replace', 'drop', 'append', 'refuse', 'say'];
export const KNOWN_CHECKS = [
  'product_from_record', 'scope_named', 'builder_line', 'checks_can_pass', 'no_money_words', 'not_a_retry', 'no_build_time_fetch',
];
// What a brief is told once a lesson with the check `no_build_time_fetch` is accepted: a build has no network, a browser does.
export const RUNTIME_LINE = 'Fetch no data while building; live data is fetched in the browser at runtime.';
const BUILD_FETCH = /\b(fetch|download|request|load|pull|retriev|quer|call)\w*\b[^.\n]{0,90}\b(at|during|while|when|as)\b[^.\n]{0,40}\b(build time|built|building|build)\b/i;
export const BUILDER_LINE = 'Write files early; do not audit dependency source.';
export const LESSON_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
export const CHECK_NAME = /^[a-z][a-z0-9_]{1,39}$/;

const OUT_OF_SCOPE = /\b(out of scope|later ticket|next ticket|second ticket|follow-up ticket|not (in|part of) this ticket)\b/i;
// A task this long, or with this many checks, has to say what it leaves out.
const SCOPE_CHARS = 800;
const SCOPE_CHECKS = 4;
const DEP_WORDS = new RegExp(
  '\\b(npm|pnpm|yarn|node_modules|bundled?|bundles|dependenc(y|ies)|vite|webpack|esbuild|rollup'
  + '|pdf\\.?js|pdfjs-dist|react|svelte|vue|tailwind)\\b', 'i');
const SPEND = /\$\s?\d[\d,]*(\.\d+)?|\b\d+(\.\d+)?\s?(USD|usd)\b/;
const MONEY_WORDS = /\b(funding|compensation|salary|salaries|cashflow|cash flow|runway|treasury|investors?|valuation|cap table|equity)\b/i;

const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const str = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * The file's text → the lessons it holds.
 * Unparseable → no lessons and `error`; a malformed entry → skipped and named in `problems`.
 */
export function parseLessons(text) {
  const none = (error) => ({ lessons: [], error, problems: [] });
  if (text == null || String(text).trim() === '') return none('empty');
  let doc;
  try { doc = JSON.parse(String(text)); } catch (e) { return none(`not JSON (${String(e.message).slice(0, 80)})`); }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return none('not a JSON object');
  if (doc.v !== 1) return none(`v must be 1 (got ${JSON.stringify(doc.v ?? null)})`);
  if (!Array.isArray(doc.lessons)) return none('lessons: a list is required');
  const lessons = [];
  const problems = [];
  const seen = new Set();
  doc.lessons.forEach((l, i) => {
    const at = `lessons[${i}]`;
    if (!l || typeof l !== 'object' || Array.isArray(l)) { problems.push(`${at}: not an object`); return; }
    const id = str(l.id, 60);
    if (!LESSON_ID.test(id)) { problems.push(`${at}: id must be a-z 0-9 -, 2..41 characters`); return; }
    if (seen.has(id)) { problems.push(`${at}: id '${id}' appears twice`); return; }
    seen.add(id);
    const rule = str(l.rule, 600);
    if (rule.length < 20) { problems.push(`${at} (${id}): rule must be a sentence (20+ characters)`); return; }
    const scopes = Array.isArray(l.applies_to) ? l.applies_to.filter((s) => SCOPES.includes(s)) : [];
    if (!scopes.length) { problems.push(`${at} (${id}): applies_to must name brief, ticket or chat`); return; }
    const check = l.check == null ? null : str(l.check, 40);
    if (check !== null && !CHECK_NAME.test(check)) {
      problems.push(`${at} (${id}): check must be a name (a-z 0-9 _) or null`);
      return;
    }
    const lesson = {
      id, rule, applies_to: scopes, check,
      fix: FIXES.includes(l.fix) ? l.fix : (check ? 'refuse' : 'say'),
      learned: str(l.learned, 10),
      from_run: str(l.from_run, 60) || null,
      from_product: str(l.from_product, 40) || null,
      failure: str(l.failure, 600),
      fired: Array.isArray(l.fired) ? l.fired.filter((f) => f && typeof f === 'object') : [],
    };
    if (typeof l.accepted_by === 'string') lesson.accepted_by = str(l.accepted_by, 40);
    lessons.push(lesson);
  });
  return { lessons, error: null, problems };
}

export const LESSONS_HEADER = 'LESSONS FROM EARLIER RUNS';
/**
 * The block the model reads before drafting: the rules in the named scopes, one line each.
 * Byte-stable for one lessons file, so it can sit in a cached prompt prefix. null when no lesson applies.
 */
export function lessonsBlock(lessons, scopes = SCOPES) {
  const want = new Set(scopes);
  const rows = (Array.isArray(lessons) ? lessons : []).filter((l) => l.applies_to.some((s) => want.has(s)));
  if (!rows.length) return null;
  const head = `${LESSONS_HEADER} — read before drafting a brief. Each line is a rule learned from a run that went wrong. `
    + 'The line checks what a machine can check and FIXES or REFUSES a draft that breaks a rule, naming the lesson: '
    + 'correct your own draft first, and say which lessons changed it. Cite a lesson by its id.';
  return [head, ...rows.map((l) => `- [${l.id}] (${l.applies_to.join(', ')}) ${l.rule}`)].join('\n');
}

const around = (s, m) => {
  const a = Math.max(0, m.index - 20);
  const z = Math.min(s.length, m.index + m[0].length + 20);
  return `${a > 0 ? '…' : ''}${s.slice(a, z)}${z < s.length ? '…' : ''}`;
};

function lint(input, { lessons = [], products = null, existing = [] } = {}, scopes) {
  const b = { ...input, green: Array.isArray(input?.green) ? [...input.green] : [] };
  const applied = [];
  const refused = [];
  const notes = [];
  const task = () => String(b.task ?? '');
  const title = () => String(b.title ?? '');
  let builderLine = null;   // null: not looked at yet; 'present' | 'appended' after the first builder_line lesson
  for (const l of lessons) {
    if (!l.check || !l.applies_to.some((s) => scopes.includes(s))) continue;
    const refuse = (why) => refused.push({ lesson: l.id, why: `${why}. The rule: ${l.rule}` });
    switch (l.check) {
      // The product is named by its recorded id. A different spelling of a known product is corrected;
      // an unknown product is refused. Without a product list the check says it could not run.
      case 'product_from_record': {
        const list = Array.isArray(products) ? products.filter((p) => p && typeof p.id === 'string') : null;
        const got = String(b.product ?? '');
        if (!list) { notes.push(`${l.id}: no product list was given — the product id could not be checked`); break; }
        if (list.some((p) => p.id === got)) break;
        const loose = (s) => norm(s).replace(/[^a-z0-9]/g, '');
        const near = list.find((p) => loose(p.id) === loose(got) || (p.name && loose(p.name) === loose(got)));
        if (near && loose(got)) {
          b.product = near.id;
          applied.push({ lesson: l.id, what: `product '${got}' → '${near.id}' (the recorded id)` });
          break;
        }
        refuse(`product '${got}' is not a recorded product id (${list.map((p) => p.id).join(', ') || 'none recorded'})`);
        break;
      }
      case 'scope_named': {
        const big = task().length >= SCOPE_CHARS || b.green.length >= SCOPE_CHECKS;
        if (big && !OUT_OF_SCOPE.test(task()) && !(Array.isArray(b.out_of_scope) && b.out_of_scope.length)) {
          refuse(`this ticket is large (${task().length} characters, ${b.green.length} checks) and names nothing `
            + 'as out of scope — split it, or say what a later ticket takes');
        }
        break;
      }
      // Several lessons share this check. The line is appended once; each of them is named.
      case 'builder_line': {
        if (builderLine === null) {
          const has = /write files early/i.test(task()) && /\b(do not|don't|never)\b[^.]{0,40}\baudit/i.test(task());
          if (has) builderLine = 'present';
          else {
            b.task = task().replace(/\s+$/, '') + '\n\n' + BUILDER_LINE;
            builderLine = 'appended';
            applied.push({ lesson: l.id, what: `task ends with "${BUILDER_LINE}"` });
          }
        } else if (builderLine === 'appended') {
          applied.push({ lesson: l.id, what: `covered by the same closing line, "${BUILDER_LINE}"` });
        }
        break;
      }
      case 'checks_can_pass': {
        const installs = b.green.some((c) => c && c.kind === 'run' && c.network === 'registry') || DEP_WORDS.test(task());
        const nx = b.green.filter((c) => c && c.kind === 'no_external_hosts');
        if (installs && nx.length) {
          b.green = b.green.filter((c) => !(c && c.kind === 'no_external_hosts'));
          const names = nx.map((c) => `'${c.id ?? 'no_external_hosts'}'`).join(', ');
          applied.push({
            lesson: l.id,
            what: `dropped ${names}: a no_external_hosts check cannot pass on a build that installs or bundles a library`,
          });
          if (!b.green.length) refuse('every check was dropped — name a check that can pass (a file check on the built page, a run)');
        }
        break;
      }
      // Title and task only. The budget field is where money belongs and is never read here.
      case 'no_money_words': {
        for (const [where, text] of [['title', title()], ['task', task()]]) {
          const m = SPEND.exec(text) || (where === 'title' ? MONEY_WORDS.exec(text) : null);
          if (m) {
            refuse(`${where} carries "${m[0]}" (${around(text, m)}) — the title and the task are shown on the public brief card; `
              + 'the budget has its own field');
            break;
          }
        }
        break;
      }
      case 'not_a_retry': {
        const t = norm(task());
        const ti = norm(title());
        const same = (Array.isArray(existing) ? existing : [])
          .find((e) => e && e.id !== b.id && ((t && norm(e.task) === t) || (ti && norm(e.title) === ti)));
        if (same) {
          refuse(`the same ${norm(same.task) === t ? 'task' : 'title'} as ticket '${same.id}', which already exists — `
            + 'after RED, a smaller ticket, not a retry');
        }
        break;
      }
      // A build has no network beyond the package registry, so a brief that asks for data to be fetched while building cannot pass.
      // With the fix "refuse" such a brief is refused. In every other brief the task is told where live data comes from.
      case 'no_build_time_fetch': {
        const where = [['title', title()], ['goal', String(b.goal ?? '')], ['task', task().replace(RUNTIME_LINE, '')]]
          .map(([name, text]) => [name, text, BUILD_FETCH.exec(text)]).find((x) => x[2]);
        if (where && l.fix === 'refuse') {
          refuse(`the ${where[0]} asks for data to be fetched while building (${around(where[1], where[2])}) — a build has no network; `
            + 'fetch it in the browser at runtime');
          break;
        }
        if (!task().includes(RUNTIME_LINE)) {
          b.task = task().replace(/\s+$/, '') + '\n\n' + RUNTIME_LINE;
          applied.push({ lesson: l.id, what: `task says "${RUNTIME_LINE}"` });
        }
        break;
      }
      default:
        notes.push(`${l.id}: check '${l.check}' is not one this code knows — the rule stands as text only`);
    }
  }
  return { brief: b, applied, refused, notes };
}

/**
 * The checks over a drafted brief (the Ticket shape before approval).
 *   lessons    from parseLessons
 *   products   [{id, name}] the recorded products, or null when not known
 *   existing   [{id, title, task}] the tickets that already exist
 * → { brief (fixed copy; the input is not changed), applied: [{lesson, what}], refused: [{lesson, why}], notes: [] }
 * A refusal names its rule; the caller stops on any and redrafts.
 */
export function lintBrief(brief, opts = {}) {
  return lint(brief, opts, ['brief', 'ticket']);
}

/** The same checks for a ticket about to be approved: only lessons scoped to "ticket" run. */
export function lintTicket(ticket, opts = {}) {
  const r = lint(ticket, opts, ['ticket']);
  return { ticket: r.brief, ...r };
}
