// Slice 5: the year simulator. A short seeded run through the real HTTP endpoints passes its
// checks and replays byte for byte; each check fails when its condition is broken.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelAdapter } from "../src/model.ts";
import type { PlanResponse } from "../src/protocol.ts";
import type { Rng } from "../src/rng.ts";
import { fakeTownAdapter } from "../sim/fake-town.ts";
import { canaryLeak, longestIdenticalRun, recheckPlan, runSim } from "../sim/run.ts";
import { simWorld } from "../sim/world.ts";

const { v: _v, saveId: _s, ...WORLD } = simWorld("t");
const fast = { talkDeadlineMs: 5000, planDeadlineMs: 5000 };

test("a 14-day seeded run passes every check and the same seed gives the same diary", async () => {
  const a = await runSim({ days: 14, seed: 1, model: fakeTownAdapter, ...fast });
  const b = await runSim({ days: 14, seed: 1, model: fakeTownAdapter, ...fast });
  for (const c of a.checks) assert.ok(c.ok, `${c.name}: ${c.detail}`);
  assert.equal(a.diary, b.diary);
  assert.equal(a.modelCalls, b.modelCalls);
  const c = await runSim({ days: 14, seed: 2, model: fakeTownAdapter, ...fast });
  assert.notEqual(a.diary, c.diary, "another seed gives another year");
});

test("the diary has a section per day with the happening, gossip, relationships, quest and drops", async () => {
  const { diary } = await runSim({ days: 5, seed: 3, model: fakeTownAdapter, ...fast });
  const days = diary.split(/^## Day /m).slice(1);
  assert.equal(days.length, 5);
  for (const d of days) {
    for (const label of ["Plan: ", "Happening: ", "Quest: ", "Dropped by the validator: ", "Tae", "Gossip and news overnight: ", "Relationships: "]) assert.ok(d.includes(label), `day ${d.slice(0, 20)} lacks ${label}`);
  }
  assert.match(diary, /heard from \w+ \(hop 1\)/);
  assert.match(diary, /## Summary/);
});

test("a model stuck on one schedule: the brain's guard sends repeats to vanilla, so the repeat check holds", async () => {
  // Every plan is the same: one stop for everyone. The brain's guard drops repeats to vanilla,
  // so no NPC ever has an identical planned schedule on two planned days running.
  const same = JSON.stringify({ npcs: ["Abigail", "Emily", "Gus", "Haley", "Lewis", "Pierre", "Robin", "Shane"].map((npc) => ({ npc, schedule: [{ time: 900, location: "Town", x: 5, y: 5, facing: 2 }] })), happening: null });
  const talk = fakeTownAdapter;
  const model = (rng: Rng): ModelAdapter => {
    const t = talk(rng);
    return { name: "stuck", complete: (s, u, sig) => (s.startsWith("You write dialogue") ? t.complete(s, u, sig) : Promise.resolve(s.startsWith("You replan") ? '{"schedules": []}' : same)) };
  };
  const r = await runSim({ days: 6, seed: 1, model, ...fast });
  const repeat = r.checks.find((c) => c.name.startsWith("no identical"))!;
  assert.ok(repeat.ok, repeat.detail);
  assert.match(r.diary, /repeated a recent schedule and the regen gave none; vanilla/);
});

test("longestIdenticalRun counts the longest streak of equal signatures", () => {
  assert.equal(longestIdenticalRun([]), 0);
  assert.equal(longestIdenticalRun(["a", "b", "a"]), 1);
  assert.equal(longestIdenticalRun(["a", "b", "b", "b", "b", "c"]), 4);
});

test("canaryLeak allows the canary only in Emily's talk prompt and Emily's planner block", () => {
  const talk = "You write dialogue for one character";
  const plan = "You plan tomorrow in Stardew Valley";
  assert.equal(canaryLeak(talk, "Character: Emily\n...CANARY-123..."), null);
  assert.equal(canaryLeak(talk, "Character: Haley\n...CANARY-123..."), "talk prompt for Haley");
  assert.equal(canaryLeak(plan, "head\n\n## Emily\nCANARY-123\n\n## Haley\nnothing"), null);
  assert.equal(canaryLeak(plan, "head\n\n## Emily\nx\n\n## Haley\nCANARY-123"), "plan prompt, block for Haley");
  assert.equal(canaryLeak(plan, "CANARY-123 in the head\n\n## Emily\nx"), "plan prompt, shared part");
  assert.equal(canaryLeak(talk, "Character: Haley\nnothing"), null);
});

test("recheckPlan flags a plan part the validator would refuse", () => {
  const base: PlanResponse = { v: 1, day: { season: "spring", day: 2, year: 1 }, source: "model", schedules: [], goals: [], happening: null, quest: null, friendship: [], relationships: [], dropped: [] };
  assert.deepEqual(recheckPlan(base, WORLD), []);
  const bad: PlanResponse = {
    ...base,
    schedules: [{ npc: "Abigail", stops: [{ time: 900, location: "Moon", x: 1, y: 1, facing: 2 }] }],
    quest: { id: "q1", item: "(O)24", from: "Gus", reward: 100, text: "hi" },
    friendship: [{ npc: "Gus", delta: 80, reason: "too much" }],
  };
  const problems = recheckPlan(bad, WORLD);
  assert.equal(problems.length, 3, problems.join("\n"));
  assert.deepEqual(recheckPlan({ ...base, source: "festival", day: { season: "spring", day: 13, year: 1 } }, WORLD), []);
  assert.equal(recheckPlan({ ...base, day: { season: "spring", day: 13, year: 1 } }, WORLD).length, 1, "a model plan on a festival day");
});
