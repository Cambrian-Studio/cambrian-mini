// store.mjs — the lessons file on disk. Append-only: a write only ever adds a lesson or adds
// to a lesson's `fired` list. Every write goes to a temporary file and is renamed into place,
// so a reader never sees half a file.
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { parseLessons, LESSON_ID } from './lessons.mjs';

const readDoc = (file) => {
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (!doc || doc.v !== 1 || !Array.isArray(doc.lessons)) throw new Error(`${file}: not a lessons file (v 1, lessons list)`);
  return doc;
};

function writeDoc(file, doc) {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n');
  renameSync(tmp, file);
}

/** Read and parse the lessons file → { lessons, error, problems } (never throws). */
export function loadLessons(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return { lessons: [], error: `cannot read ${file} (${e.code ?? e.message})`, problems: [] };
  }
  return parseLessons(text);
}

/**
 * Append one accepted lesson. `acceptance` = { member, approval }: the caller has ALREADY verified the
 * council member's passkey signature; it is stored with the lesson so a reader can see who accepted it.
 * Refuses a malformed draft, an id that exists, or a missing acceptance. Earlier lessons are untouched.
 * → the lesson as stored.
 */
export function acceptLesson(file, draft, acceptance) {
  const member = typeof acceptance?.member === 'string' ? acceptance.member.trim() : '';
  if (!member) throw new Error('acceptLesson: acceptance.member is required (the council member who accepted)');
  if (!acceptance.approval || typeof acceptance.approval !== 'object') {
    throw new Error('acceptLesson: acceptance.approval is required (the verified passkey approval)');
  }
  if (!draft || typeof draft !== 'object' || !LESSON_ID.test(String(draft.id ?? ''))) {
    throw new Error('acceptLesson: the draft needs an id (a-z 0-9 -, 2..41 characters)');
  }
  const doc = readDoc(file);
  if (doc.lessons.some((l) => l && l.id === draft.id)) throw new Error(`acceptLesson: a lesson '${draft.id}' already exists`);
  const lesson = {
    id: draft.id,
    learned: draft.learned ?? new Date().toISOString().slice(0, 10),
    from_run: draft.from_run ?? null,
    from_product: draft.from_product ?? null,
    applies_to: draft.applies_to,
    rule: draft.rule,
    failure: draft.failure ?? '',
    check: draft.check ?? null,
    fix: draft.fix ?? (draft.check ? 'refuse' : 'say'),
    fired: [],
    accepted_by: member,
    acceptance: { member, approval: acceptance.approval, at: acceptance.at ?? new Date().toISOString() },
  };
  // The draft must parse as a lesson on its own before it may join the file.
  const probe = parseLessons(JSON.stringify({ v: 1, lessons: [lesson] }));
  if (probe.lessons.length !== 1) throw new Error(`acceptLesson: the draft is not a valid lesson — ${probe.problems.join('; ')}`);
  const before = JSON.stringify(doc.lessons);
  const next = { ...doc, lessons: [...doc.lessons, lesson] };
  if (JSON.stringify(next.lessons.slice(0, -1)) !== before) throw new Error('acceptLesson: an earlier lesson would change');
  writeDoc(file, next);
  return lesson;
}

/**
 * Note that a lesson fired: append { at, what, run?, brief? } to that lesson's `fired` list.
 * Nothing else in the file changes. → the entry as stored.
 */
export function recordFired(file, lessonId, { run = null, brief = null, at = new Date().toISOString(), what = '' } = {}) {
  const doc = readDoc(file);
  const l = doc.lessons.find((x) => x && x.id === lessonId);
  if (!l) throw new Error(`recordFired: no lesson '${lessonId}'`);
  if (!run && !brief) throw new Error('recordFired: name the run or the brief the lesson fired on');
  const entry = { at, what: String(what).slice(0, 300) };
  if (run) entry.run = String(run);
  if (brief) entry.brief = String(brief);
  l.fired = [...(Array.isArray(l.fired) ? l.fired : []), entry];
  writeDoc(file, doc);
  return entry;
}
