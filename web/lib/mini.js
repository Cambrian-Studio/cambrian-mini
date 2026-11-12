// What both the home page and the build replay say: the seven steps, and the compounding panel's four figures.
// No browser API is used here, so the tests read the same module the screens do.

import { usd, count } from './ui.js';

// The seven steps from an idea to a live product. The watch screen tells the same seven from a recorded build.
export const STEPS = [
  ['Talk to Cambrian.', 'A member describes an idea.'],
  ['The brief.', 'Cambrian writes what it is, how it will be checked and what it may cost. '
    + 'An open model writes it inside verified hardware, so anyone can confirm which model wrote it.'],
  ['The collective decides.', 'Members sign the brief with passkeys. Nothing is built until enough of them do.'],
  ['The build.', 'AI agents build it in a sealed workspace on NEAR AI, within the budget the members signed.'],
  ['The checks.', 'Every check in the brief runs. If one fails, the build stops and Cambrian drafts a lesson.'],
  ['Live.', 'A preview link goes up, and the product ships.'],
  ['On the record.', 'What it cost, which models did the work, who signed. Recorded on NEAR, so anyone can check it.'],
];

const isGreen = (r) => /^green/.test(String(r.state));

// The compounding panel: four figures, each counted from the record and each saying what it counted.
export function compounding({ products = [], lessons = [], runs = [] }) {
  const done = runs.filter((r) => r.finished);
  const working = done.filter(isGreen);
  const first = working.filter((r) => r.attempts === 1);
  const shipped = products.filter((p) => p.live_url);
  const signed = lessons.filter((l) => l.accepted_by);
  const spent = done.reduce((sum, r) => sum + (Number(r.usd) || 0), 0);
  return [
    ['Products shipped', count(shipped.length),
      products.length === shipped.length ? 'with a public link'
        : `${count(products.length)} built, ${count(shipped.length)} with a public link`],
    ['Lessons signed', count(signed.length),
      `${count(lessons.length)} on record, ${count(signed.length)} signed by a member`],
    ['First-try pass rate', done.length ? `${Math.round((first.length / done.length) * 100)}%` : null,
      `${count(first.length)} of ${count(done.length)} recorded builds`],
    ['Cost per working build', working.length ? usd(spent / working.length) : null,
      `${usd(spent)} over ${count(working.length)} working builds, failed builds included`],
  ];
}
