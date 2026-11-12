// The lessons file parses, and its checks fire on the real Upread tickets the lessons came from.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLessons, lessonsBlock, lintBrief, lintTicket, BUILDER_LINE, KNOWN_CHECKS, LESSONS_HEADER } from '../../lessons/lessons.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const LESSONS_TEXT = read('lessons/lessons.json');
const { lessons, error, problems } = parseLessons(LESSONS_TEXT);
const products = JSON.parse(read('data/products.json')).products;
const RED_ID = 'upread-v1-one-word-at-a-time-reader-for';
const redTicket = JSON.parse(read(`data/runs/${RED_ID}/ticket.json`));
const greenTicket = JSON.parse(read('data/runs/upread-v1-reader-shell/ticket.json'));
const ids = (rows) => rows.map((r) => r.lesson).sort();

test('the eight lessons parse, each complete', () => {
  assert.equal(error, null);
  assert.deepEqual(problems, []);
  assert.equal(lessons.length, 8);
  for (const l of lessons) {
    assert.ok(l.rule.length >= 20 && l.failure.length >= 20, l.id);
    assert.ok(l.check === null || KNOWN_CHECKS.includes(l.check), `${l.id}: ${l.check}`);
    assert.deepEqual(l.fired, []);
  }
  const raw = JSON.parse(LESSONS_TEXT);
  assert.equal(Object.keys(raw._meta).length, 2);
  for (const l of raw.lessons) {
    assert.deepEqual(Object.keys(l),
      ['id', 'learned', 'from_run', 'from_product', 'applies_to', 'rule', 'failure', 'check', 'fix', 'fired']);
  }
});

test('a malformed entry is skipped and named; an unreadable file gives an error, not a throw', () => {
  const doc = JSON.parse(LESSONS_TEXT);
  doc.lessons.push({ id: 'Bad Id', rule: 'A rule long enough to be a sentence.', applies_to: ['brief'] });
  doc.lessons.push({ id: 'too-short', rule: 'short', applies_to: ['brief'] });
  doc.lessons.push({ id: 'no-scope', rule: 'A rule long enough to be a sentence.', applies_to: ['nowhere'] });
  doc.lessons.push({ id: 'one-feature-per-ticket', rule: 'A rule long enough to be a sentence.', applies_to: ['brief'] });
  const r = parseLessons(JSON.stringify(doc));
  assert.equal(r.error, null);
  assert.equal(r.lessons.length, 8);
  assert.equal(r.problems.length, 4);
  assert.match(r.problems[0], /lessons\[8\]: id must be/);
  assert.match(r.problems[1], /too-short.*rule must be a sentence/);
  assert.match(r.problems[2], /no-scope.*applies_to/);
  assert.match(r.problems[3], /appears twice/);
  assert.equal(parseLessons('{nope').lessons.length, 0);
  assert.match(parseLessons('{nope').error, /not JSON/);
  assert.match(parseLessons('{"v":2,"lessons":[]}').error, /v must be 1/);
  assert.equal(parseLessons('').error, 'empty');
});

test('the prompt block lists the rules of the asked scope, and is null when none apply', () => {
  const block = lessonsBlock(lessons, ['brief']);
  assert.ok(block.startsWith(LESSONS_HEADER));
  assert.match(block, /- \[one-feature-per-ticket\]/);
  assert.equal(block.split('\n').length, 1 + lessons.filter((l) => l.applies_to.includes('brief')).length);
  assert.equal(lessonsBlock(lessons, ['brief']), block);
  const chat = lessonsBlock(lessons, ['chat']);
  assert.match(chat, /a-product-starts-with-an-approved-brief/);
  assert.doesNotMatch(chat, /write-files-early/);
  assert.equal(lessonsBlock([], ['brief']), null);
});

test('the real RED ticket is fixed and refused by exactly the lessons that came from it', () => {
  const fromRed = lessons.filter((l) => l.from_run === RED_ID).map((l) => l.id).sort();
  assert.deepEqual(fromRed, ['checks-must-be-passable', 'no-dependency-auditing', 'one-feature-per-ticket', 'write-files-early']);
  const before = JSON.stringify(redTicket);
  const r = lintBrief(redTicket, { lessons, products, existing: [] });
  assert.equal(JSON.stringify(redTicket), before, 'the input is not changed');
  assert.deepEqual(ids(r.refused), ['one-feature-per-ticket']);
  assert.match(r.refused[0].why, /large \(\d+ characters, 6 checks\).*out of scope/);
  assert.deepEqual(ids(r.applied), ['checks-must-be-passable', 'no-dependency-auditing', 'write-files-early']);
  assert.deepEqual([...new Set([...ids(r.refused), ...ids(r.applied)])].sort(), fromRed);
  // the fix: the check that could not pass is gone, the others stay, the task gained the builder line
  assert.ok(redTicket.green.some((c) => c.kind === 'no_external_hosts'));
  assert.ok(!r.brief.green.some((c) => c.kind === 'no_external_hosts'));
  assert.equal(r.brief.green.length, redTicket.green.length - 1);
  assert.ok(r.brief.task.endsWith(BUILDER_LINE));
  assert.ok(r.brief.task.startsWith(redTicket.task));
  assert.deepEqual(r.notes, []);
});

test('the real GREEN ticket passes clean', () => {
  const r = lintBrief(greenTicket, { lessons, products, existing: [] });
  assert.deepEqual(r.applied, []);
  assert.deepEqual(r.refused, []);
  assert.deepEqual(r.notes, []);
  assert.deepEqual(r.brief, greenTicket);
});

test('the builder line is appended once, and not at all when the task already says it', () => {
  const small = { ...greenTicket, task: 'Add a dark mode switch to the settings page.', green: greenTicket.green.slice(0, 2) };
  const r = lintBrief(small, { lessons, products });
  assert.equal(r.brief.task.split(BUILDER_LINE).length - 1, 1);
  assert.deepEqual(ids(r.applied), ['no-dependency-auditing', 'write-files-early']);
  const again = lintBrief(r.brief, { lessons, products });
  assert.deepEqual(again.applied, []);
  assert.equal(again.brief.task, r.brief.task);
});

test('money words: refused in a title or a task, allowed in the budget field', () => {
  const inTitle = lintBrief({ ...greenTicket, title: 'Upread reader for $8' }, { lessons, products });
  assert.deepEqual(ids(inTitle.refused), ['no-money-in-brief-text']);
  assert.match(inTitle.refused[0].why, /title carries "\$8"/);
  const word = lintBrief({ ...greenTicket, title: 'Upread: runway dashboard' }, { lessons, products });
  assert.deepEqual(ids(word.refused), ['no-money-in-brief-text']);
  const inTask = lintBrief({ ...greenTicket, task: `${greenTicket.task} Keep it under 15 USD.` }, { lessons, products });
  assert.match(inTask.refused[0].why, /task carries "15 USD"/);
  const inBudget = lintBrief({ ...greenTicket, budget: { usd: 5, calls: 60, minutes: 45 } }, { lessons, products });
  assert.deepEqual(inBudget.refused, []);
});

test('a retry of the same task is refused; a different, smaller task is not', () => {
  const existing = [{ id: RED_ID, title: redTicket.title, task: redTicket.task }];
  const again = { ...redTicket, id: 'upread-again', task: `  ${redTicket.task.toUpperCase()}  ` };
  const retry = lintBrief(again, { lessons, products, existing });
  assert.ok(ids(retry.refused).includes('after-red-a-smaller-ticket'));
  assert.match(retry.refused.find((x) => x.lesson === 'after-red-a-smaller-ticket').why, new RegExp(`ticket '${RED_ID}'`));
  const smaller = lintBrief(greenTicket, { lessons, products, existing });
  assert.deepEqual(smaller.refused, []);
  // a ticket is not a retry of itself
  assert.ok(!ids(lintBrief(redTicket, { lessons, products, existing }).refused).includes('after-red-a-smaller-ticket'));
});

test('the product is named by its recorded id: re-spelled is corrected, unknown is refused, no list is said', () => {
  const respelled = lintBrief({ ...greenTicket, product: 'UpRead' }, { lessons, products });
  assert.equal(respelled.brief.product, 'upread');
  assert.deepEqual(ids(respelled.applied), ['product-from-record']);
  assert.deepEqual(respelled.refused, []);
  const unknown = lintBrief({ ...greenTicket, product: 'downread' }, { lessons, products });
  assert.deepEqual(ids(unknown.refused), ['product-from-record']);
  const noList = lintBrief(greenTicket, { lessons });
  assert.deepEqual(noList.refused, []);
  assert.match(noList.notes[0], /product-from-record: no product list/);
});

test('scopes: a brief-only lesson runs in lintBrief and not in lintTicket; an unknown check stands as text', () => {
  const only = [
    { id: 'brief-only', rule: 'A rule that only applies to briefs.', applies_to: ['brief'], check: 'no_money_words', fix: 'refuse' },
    { id: 'future-check', rule: 'A rule whose check this code lacks.', applies_to: ['ticket'], check: 'not_built_yet', fix: 'refuse' }];
  const b = { ...greenTicket, title: 'Costs $3' };
  assert.deepEqual(ids(lintBrief(b, { lessons: only }).refused), ['brief-only']);
  const t = lintTicket(b, { lessons: only });
  assert.deepEqual(t.refused, []);
  assert.match(t.notes[0], /future-check: check 'not_built_yet' is not one this code knows/);
  assert.equal(t.ticket.title, 'Costs $3');
});
