// What both the home page and the build replay say: the seven steps, and the compounding panel's four figures.
// No browser API is used here, so the tests read the same module the screens do.

import { usd, count, plural } from './ui.js';

// The seven steps from an idea to a live product. The watch screen tells the same seven from a recorded build.
export const STEPS = [
  ['Talk to Cambrian.', 'A member describes an idea.'],
  ['The brief.', 'Cambrian writes what it is, how it will be checked and what it may cost. '
    + 'An open model writes it inside verified hardware, so anyone can confirm which model wrote it.'],
  ['The collective decides.', 'Members sign the brief with passkeys. Nothing is built until enough of them do.'],
  ['The build.', 'AI agents build it in a sealed workspace, every model call going through NEAR AI, within the budget the members signed.'],
  ['The checks.', 'Every check in the brief runs. If one fails, the build stops and Cambrian drafts a lesson.'],
  ['Live.', 'A preview link goes up, and the product ships.'],
  ['On the record.', 'What it cost, which models did the work, who signed: all in one record. '
    + 'Its hash is logged on NEAR, so anyone can check the record has not changed.'],
];

const isGreen = (r) => /^green/.test(String(r.state));

// The compounding panel: four figures, counted only from builds made here, each with the screen that shows its source.
export function compounding({ lessons = [], runs = [] }) {
  const here = runs.filter((r) => r.finished && r.origin !== 'private-line');
  const ids = new Set(here.map((r) => r.id));
  const changed = lessons.filter((l) => (l.fired || []).some((f) => ids.has(f.brief) || ids.has(f.run)));
  const working = here.filter(isGreen);
  const first = working.filter((r) => r.attempts === 1);
  const spent = here.reduce((sum, r) => sum + (Number(r.usd) || 0), 0);
  return [
    ['Lessons in force', count(lessons.length), 'each new brief is checked against them', '#/lessons'],
    ['Lessons that changed a brief', here.length ? count(changed.length) : null,
      `of the ${plural(here.length, 'brief')} built here`, '#/line'],
    ['First-try passes', here.length ? `${first.length} of ${here.length}` : null, 'builds made here', '#/receipts'],
    ['Cost per working build', working.length ? usd(spent / working.length) : null,
      `${usd(spent)} over ${plural(working.length, 'build')} made here`, '#/receipts'],
  ];
}

/**
 * The learning loop on one brief: each lesson that changed it, what it changed, and the earlier build the lesson came from;
 * and, when the conversation cut the idea down by pointing at an earlier failure, that sentence and who wrote it.
 */
export function lessonsApplied(brief, lessons = []) {
  const rows = (brief?.lint?.applied || []).map((x) => {
    const l = lessons.find((y) => y.id === x.lesson) || {};
    return { lesson: x.lesson, what: x.what, rule: l.rule || null, from_run: l.from_run || null };
  });
  // the first sentence in the conversation, by either side, that points at an earlier failure
  const hit = (brief?.conversation?.messages || [])
    .flatMap((m) => String(m.text).split(/(?<=[.?!])\s+/).map((sentence) => ({ by: m.role, sentence: sentence.trim() })))
    .find((x) => /\b(timed out|ran out of time|failed|did not pass)\b/i.test(x.sentence)) || null;
  return { rows, said: hit ? hit.sentence : null, said_by: hit ? hit.by : null };
}

const REVISION = { 'design-pass': 'Design pass', fix: 'Fix', feature: 'Feature' };
/**
 * What a revision build says about itself: who asked for what, which version it made from which, and both previews.
 * Versions count the product's passing builds in the order they finished. → null for a build that revises nothing.
 */
export function revisionLine(run, runs = [], council = null) {
  const rev = run?.revision;
  if (!rev) return null;
  const name = council?.members?.find((m) => m.id === rev.by)?.name || rev.by;
  const passed = runs.filter((r) => /^green/.test(String(r.state))).sort((a, b) => String(a.finished).localeCompare(String(b.finished)));
  const from = passed.findIndex((r) => r.id === rev.of) + 1;
  const to = passed.findIndex((r) => r.id === run.id) + 1;
  const parent = runs.find((r) => r.id === rev.of) || null;
  return { text: `${REVISION[rev.kind] || 'Revision'} by ${name}`,
    versions: from && to ? `v${from} → v${to}` : (from ? `from v${from}, not passed yet` : null),
    previews: [parent?.preview_url || null, run.preview_url || null] };
}
