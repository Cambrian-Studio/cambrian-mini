// Plain node tests. No browser, no network: node test.mjs
import assert from "node:assert/strict";
import { LANDMARKS, HERE, EARTH_RADIUS_METRES, haversine, unlock, findCard } from "./fence.mjs";
import { postcardText } from "./postcard.mjs";

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    console.error(`FAIL ${name}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// A point `metres` due north of `from`, along the meridian.
function northOf(from, metres) {
  return { lat: from.lat + (metres / EARTH_RADIUS_METRES) * (180 / Math.PI), lng: from.lng };
}

test("there are ten landmarks and a Here card", () => {
  assert.equal(LANDMARKS.length, 10);
  assert.deepEqual(LANDMARKS.map((l) => l.number), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(HERE.name, "Here");
});

test("haversine: zero at the same point, about 800 m Big Ben to Trafalgar Square", () => {
  const ben = findCard("Big Ben");
  assert.equal(haversine(ben, ben), 0);
  const d = haversine(ben, findCard("Trafalgar Square"));
  assert.ok(d > 700 && d < 900, `got ${d}`);
});

for (const name of ["Big Ben", "Tower Bridge", "St Paul's Cathedral"]) {
  const card = findCard(name);
  test(`${name}: 150 m unlocks, 151 m does not`, () => {
    const at150 = northOf(card, 150);
    const at151 = northOf(card, 151);
    assert.ok(Math.abs(haversine(card, at150) - 150) < 1e-6);
    assert.ok(Math.abs(haversine(card, at151) - 151) < 1e-6);
    assert.equal(unlock(card, at150), true);
    assert.equal(unlock(card, at151), false);
    assert.equal(unlock(card, card), true);
    assert.equal(unlock(150), true);
    assert.equal(unlock(151), false);
  });
}

test("Here unlocks anywhere, landmarks need a position", () => {
  assert.equal(unlock(HERE, null), true);
  assert.equal(unlock(HERE, { lat: 0, lng: 0 }), true);
  assert.equal(unlock(findCard("Big Ben"), null), false);
});

test('postcard text block for "No. 3 of 10"', () => {
  const date = new Date("2026-07-14T13:05:00Z"); // 14:05 in London (BST)
  const text = postcardText("Tower Bridge", 3, date, { lat: 51.505461, lng: -0.075349 });
  assert.ok(text.includes("Tower Bridge"), text);
  assert.ok(text.includes("2026-07-14"), text);
  assert.ok(text.includes("14:05"), text);
  assert.ok(text.includes("51.50546° N"), text);
  assert.ok(text.includes("0.07535° W"), text);
  assert.ok(text.includes("No. 3 of 10"), text);
  assert.equal(text.split("\n").length, 5);
});

console.log(`${passed} passed`);
