// Character cards: every cast member has every section, the heart tier follows friendship, the
// talk prompt and the planner prompt carry only the tier for the farmer's current hearts, and no
// card repeats known game dialogue.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST } from "../src/cast.ts";
import { fakeAdapter } from "../src/model.ts";
import { CARDS, TIERS, cardFor, planCard, talkCard, tierFor, type Card } from "../src/voices.ts";
import { CANON_LINES } from "./canon-lines.ts";
import { talkReq, withServer } from "./helpers.ts";
import { GOOD_SCHEDULES, WORLD, npcsEntry, planReq, reply, spring } from "./plan-fixtures.ts";

test("tier selection by hearts: 0-2 guarded, 3-5, 6-8, 9 and up open (spouse hearts too)", () => {
  const cases: [number, string][] = [
    [0, "0-2"], [2, "0-2"], [3, "3-5"], [5, "3-5"], [6, "6-8"], [8, "6-8"], [9, "9-10"], [10, "9-10"], [14, "9-10"],
  ];
  for (const [hearts, tier] of cases) assert.equal(tierFor(hearts), tier, `${hearts} hearts`);
});

test("every cast member has a card with every section filled, and no extra cards", () => {
  assert.deepEqual(Object.keys(CARDS).sort(), [...CAST].sort());
  for (const npc of CAST) {
    const c = cardFor(npc);
    assert.ok(c, npc);
    for (const k of ["voice", "household", "habits"] as const) assert.ok(c[k].trim().length > 20, `${npc} ${k}`);
    for (const k of ["close", "atOdds", "likes", "dislikes", "topics", "neverSays"] as const) {
      assert.ok(c[k].length >= 1 && c[k].every((s) => s.trim().length > 0), `${npc} ${k}`);
    }
    assert.deepEqual(Object.keys(c.tiers), [...TIERS], `${npc} tiers`);
    for (const t of TIERS) assert.ok(c.tiers[t].trim().length > 20, `${npc} tier ${t}`);
    assert.equal(new Set(TIERS.map((t) => c.tiers[t])).size, TIERS.length, `${npc} tiers differ`);
  }
});

function cardText(c: Card): string {
  return [c.voice, c.household, c.habits, ...c.close, ...c.atOdds, ...c.likes, ...c.dislikes, ...c.topics, ...c.neverSays, ...Object.values(c.tiers)].join("\n");
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

test("no card repeats a known canon line, or any six-word run from one", () => {
  const RUN = 6;
  for (const npc of CAST) {
    const text = ` ${words(cardText(CARDS[npc]!)).join(" ")} `;
    for (const line of CANON_LINES) {
      const w = words(line);
      for (let i = 0; i + Math.min(RUN, w.length) <= w.length; i++) {
        const run = w.slice(i, i + Math.min(RUN, w.length)).join(" ");
        assert.ok(!text.includes(` ${run} `), `${npc} card repeats "${run}" from: ${line}`);
      }
    }
  }
});

test("the guard itself catches a copied line", () => {
  const copied = ` ${words(`She says: ${CANON_LINES[1]}`).join(" ")} `;
  assert.ok(copied.includes(` ${words(CANON_LINES[1]!).slice(0, 6).join(" ")} `));
});

test("cards carry the canon facts the audit found missing", () => {
  assert.match(talkCard("Emily", 0), /Saloon/);
  assert.match(talkCard("Emily", 0), /Gus/);
  assert.match(talkCard("Emily", 0), /Haley/);
  assert.match(talkCard("Abigail", 0), /Pierre and Caroline/);
  assert.match(talkCard("Shane", 0), /Jas/);
  assert.match(talkCard("Shane", 0), /JojaMart/);
  assert.match(talkCard("Robin", 0), /Demetrius/);
  assert.match(talkCard("Pierre", 0), /Caroline/);
});

test("talk prompt: a stranger gets the guarded tier, a close friend the open one, never both", async () => {
  const model = fakeAdapter([
    JSON.stringify({ line: "What.", choices: [], end: true }),
    JSON.stringify({ line: "Hey, you.", choices: [], end: true }),
  ]);
  await withServer(model, async (c) => {
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 0, points: 0 } }));
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 10, points: 2500 } }));
  });
  const [stranger, friend] = model.calls.map((x) => x.user);
  const s = CARDS.Shane!.tiers;
  assert.ok(stranger!.includes(s["0-2"]));
  assert.ok(!stranger!.includes(s["9-10"]));
  assert.ok(friend!.includes(s["9-10"]));
  assert.ok(!friend!.includes(s["0-2"]));
  for (const p of [stranger!, friend!]) {
    assert.match(p, /Family and household: /);
    assert.match(p, /Never says: /);
  }
});

test("planner prompt: each NPC's block carries its own card at its own heart tier; missing hearts plan as guarded", async () => {
  const model = fakeAdapter([reply({ npcs: npcsEntry(GOOD_SCHEDULES) })]);
  await withServer(model, async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.equal((await c.post("/v1/plan", { ...planReq(spring(6)), hearts: { Abigail: 10, Lewis: 4 } })).status, 200);
  });
  const user = model.calls[0]!.user;
  const block = (npc: string) => {
    const i = CAST.indexOf(npc as (typeof CAST)[number]);
    return user.slice(user.indexOf(`## ${npc}`), i + 1 < CAST.length ? user.indexOf(`## ${CAST[i + 1]}`) : undefined);
  };
  assert.ok(block("Abigail").includes(planCard("Abigail", 10)));
  assert.ok(block("Abigail").includes(CARDS.Abigail!.tiers["9-10"]));
  assert.ok(block("Lewis").includes(CARDS.Lewis!.tiers["3-5"]));
  assert.ok(block("Shane").includes(CARDS.Shane!.tiers["0-2"]), "no hearts sent for Shane: guarded");
  assert.ok(!block("Abigail").includes(CARDS.Lewis!.voice), "one NPC's card never lands in another's block");
  assert.match(model.calls[0]!.system, /Never plan scenes of self-harm/);
});

test("planner request: hearts outside 0..14 are refused", async () => {
  await withServer(fakeAdapter([]), async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    const bad = await c.postRaw("/v1/plan", { ...planReq(spring(6)), hearts: { Abigail: 15 } });
    assert.equal(bad.status, 400);
  });
});
