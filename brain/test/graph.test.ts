// Slice S: the town social graph. Every pair of the 34 giftable villagers has a starting score;
// canon-2.md's PAIR TABLE (~/.hermes/goals/stardew/canon-2.md, Data, 2026-10-17) wins where it
// has a row, then roster.md ties, then the old cast table, then the default.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST, pairKey } from "../src/cast.ts";
import { band, DEFAULT_SEED, isRoster, PASS_CHANCE, ROSTER, SEED_LAYERS, seedRelationships, seedScore } from "../src/graph.ts";
import { checkRelationships } from "../src/validate.ts";

test("the roster is the 34 giftable villagers, the planning cast among them", () => {
  assert.equal(ROSTER.length, 34);
  assert.equal(new Set(ROSTER).size, 34);
  for (const c of CAST) assert.ok(isRoster(c), c);
  for (const n of ["Bouncer", "Mr. Qi", "Gunther", "Marlon"]) assert.ok(!isRoster(n), n);
});

test("every pair of the 34 resolves to a whole score in -100..100, the same either way round", () => {
  const rel = seedRelationships();
  assert.equal(Object.keys(rel).length, (34 * 33) / 2);
  for (const [i, a] of ROSTER.entries()) {
    for (const b of ROSTER.slice(i + 1)) {
      const s = seedScore(a, b);
      assert.ok(Number.isInteger(s) && s >= -100 && s <= 100, `${a}|${b} ${s}`);
      assert.equal(seedScore(b, a), s);
      assert.equal(rel[pairKey(a, b)], s);
    }
  }
  assert.throws(() => seedScore("Emily", "Emily"));
  assert.throws(() => seedScore("Emily", "Bouncer"));
});

test("family seeds: Abigail|Caroline and Robin|Demetrius use canon-2.md's PAIR TABLE values", () => {
  assert.equal(seedScore("Abigail", "Caroline"), 25, "canon-2: mother, worries, kitchen argument");
  assert.equal(seedScore("Robin", "Demetrius"), 65, "canon-2: married");
  assert.equal(seedScore("Dwarf", "Krobus"), -60, "roster.md: an old war");
  assert.equal(band(seedScore("Dwarf", "Krobus")), "at odds");
  assert.equal(seedScore("Jodi", "Kent"), 60, "roster.md: spouses, not in canon-2");
  assert.equal(seedScore("Clint", "Emily"), 30, "canon-2 plain score; the crush stays private");
  assert.equal(seedScore("Alex", "Wizard"), DEFAULT_SEED);
});

test("the planning cast keeps its 10 pairs canon-2 does not list, as cast.ts had them", () => {
  assert.equal(SEED_LAYERS.cast.length, 10);
  assert.equal(seedScore("Haley", "Robin"), 10);
  assert.equal(seedScore("Lewis", "Shane"), -5);
  // The cast's other 18 pairs come from canon-2 (Haley|Shane is 0 there, it was -5).
  assert.equal(seedScore("Haley", "Shane"), 0);
  const castPairs = CAST.flatMap((a, i) => CAST.slice(i + 1).map((b) => pairKey(a, b)));
  const listed = new Set([...SEED_LAYERS.canon2, ...SEED_LAYERS.cast].map(([a, b]) => pairKey(a, b)));
  for (const k of castPairs) assert.ok(listed.has(k), `${k} has an explicit seed`);
});

test("bands and pass chances match spec-v2 slice S", () => {
  assert.deepEqual([50, 49, 15, 14, -14, -15, -39, -40].map(band), ["close", "friendly", "friendly", "neutral", "neutral", "cool", "cool", "at odds"]);
  assert.deepEqual(PASS_CHANCE, { close: 0.7, friendly: 0.45, neutral: 0.25, cool: 0.1, "at odds": 0.02 });
});

test("planner shifts may name any roster pair with at least one cast member", () => {
  const r = checkRelationships([
    { a: "Emily", b: "Clint", delta: 3, reason: "a kind word at the bar" },
    { a: "Clint", b: "Willy", delta: 3, reason: "no cast member" },
    { a: "Emily", b: "Bouncer", delta: 3, reason: "not on the roster" },
  ]);
  assert.deepEqual(r.kept.map((k) => `${k.a}|${k.b}`), ["Emily|Clint"]);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["needs at least one planning cast member", "needs two different roster villagers"]);
});
