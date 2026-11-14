// Each council build's record carries at least two valid passkey signatures over its brief hash, by the pinned keys.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FOUNDING_COUNCIL, MIN_SIGNATURES, checkCouncilBuild, councilKeysHash } from '../../approvals/founding.mjs';
import { loadCouncil } from '../../approvals/council.mjs';

const at = (p) => fileURLToPath(new URL(`../../${p}`, import.meta.url));
const json = (p) => JSON.parse(readFileSync(at(p), 'utf8'));
const council = loadCouncil(at('data/council.json'));
const BUILDS = ['upread-mini-086cdf', 'postmark-6ee0a5'];
const load = (id) => ({ run: json(`data/runs/${id}/run.json`), ticket: json(`data/runs/${id}/ticket.json`), council });

test('the committed council file holds the pinned keys, and both council builds carry two valid signatures', () => {
  assert.equal(councilKeysHash(council), FOUNDING_COUNCIL.members_digest);
  assert.match(FOUNDING_COUNCIL.commit, /^[0-9a-f]{40}$/);
  assert.equal(MIN_SIGNATURES, 2);
  for (const id of BUILDS) {
    const v = checkCouncilBuild(load(id));
    assert.equal(v.ok, true, `${id}: ${v.why}`);
    assert.deepEqual(v.signers, ['clemens', 'michael']);
  }
});

test('a record without two valid signatures fails: one removed, one altered, one over another brief', () => {
  const { run, ticket } = load('postmark-6ee0a5');
  const one = checkCouncilBuild({ run: { ...run, approvals: run.approvals.slice(0, 1) }, ticket, council });
  assert.equal(one.ok, false);
  assert.match(one.why, /^1 valid signature\(s\) over the brief hash; at least 2 are needed/);
  assert.equal(checkCouncilBuild({ run: { ...run, approvals: [] }, ticket, council }).ok, false);
  // the same member twice is one signature
  assert.equal(checkCouncilBuild({ run: { ...run, approvals: [run.approvals[0], run.approvals[0]] }, ticket, council }).ok, false);
  // one byte of a signature changed
  const bent = JSON.parse(JSON.stringify(run.approvals));
  const field = Object.keys(bent[1]).find((k) => /signature/i.test(k));
  assert.ok(field, 'an approval carries its signature');
  bent[1][field] = bent[1][field].slice(0, -4) + (bent[1][field].endsWith('AAAA') ? 'BBBB' : 'AAAA');
  assert.equal(checkCouncilBuild({ run: { ...run, approvals: bent }, ticket, council }).ok, false);
  // signatures made over one brief do not count for another
  const other = load('upread-mini-086cdf');
  assert.equal(checkCouncilBuild({ run: { ...run, approvals: other.run.approvals }, ticket, council }).ok, false);
  // the brief beside the record was changed after signing
  const edited = checkCouncilBuild({ run, ticket: { ...ticket, ticket: { ...(ticket.ticket ?? ticket), goal: 'another goal' } }, council });
  assert.equal(edited.ok, false);
});

test('a council file with another key is not the founding council, whatever it signs', () => {
  const swapped = JSON.parse(JSON.stringify(council));
  swapped.members[0].credentials[0].public_key_spki = swapped.members[1].credentials[0].public_key_spki;
  assert.notEqual(councilKeysHash(swapped), FOUNDING_COUNCIL.members_digest);
  const v = checkCouncilBuild({ ...load('postmark-6ee0a5'), council: swapped });
  assert.equal(v.ok, false);
  assert.match(v.why, /^the council file's keys are not the ones enrolled at commit 6846e6d$/);
  // names and figures are not keys: changing them changes nothing
  const renamed = JSON.parse(JSON.stringify(council)); renamed.members[0].name = 'Someone'; renamed.label = 'x';
  assert.equal(councilKeysHash(renamed), FOUNDING_COUNCIL.members_digest);
});
