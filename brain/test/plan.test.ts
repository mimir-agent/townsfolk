// Slice 3: the overnight planner and its validator. Every request and response here goes through
// helpers.ts, so each /v1/plan response is also checked against protocol/plan-response.schema.json.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST, pairKey } from "../src/cast.ts";
import { fakeAdapter, type ModelAdapter } from "../src/model.ts";
import { scheduleSignature, checkSchedule, type World } from "../src/validate.ts";
import { newFact, emptyTown } from "../src/town.ts";
import { assertValid, withServer, type Client } from "./helpers.ts";
import { GOOD_QUEST, GOOD_SCHEDULES, HAPPENING, FRIENDSHIP, RELATIONSHIPS, SAVE, WORLD, goal, npcsEntry, planReq, reply, spring } from "./plan-fixtures.ts";

const { v: _v, saveId: _s, ...world } = WORLD;
const W = world as World;

async function withWorld(model: ModelAdapter, fn: (c: Client, logs: string[]) => Promise<void>): Promise<void> {
  const logs: string[] = [];
  await withServer(model, async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    await fn(c, logs);
  }, (m) => logs.push(m));
}

// Moves each NPC's first stop to a different valid game time each night (up to night 20), so
// plans differ from night to night unless a test pins one NPC's schedule.
function variedSchedules(night: number, pin: Record<string, unknown> = {}): Record<string, unknown> {
  const shift = Math.floor(night / 6) * 100 + (night % 6) * 10;
  const out: Record<string, unknown> = {};
  for (const [npc, stops] of Object.entries(GOOD_SCHEDULES)) {
    out[npc] = pin[npc] ?? stops.map((s, i) => (i === 0 ? { ...s, time: s.time + shift } : s));
  }
  return out;
}

test("done-when 1: a plan with a bad location, a 0500 start, an unknown item and a 5000g reward loses exactly those four parts, with four reasons logged", async () => {
  const bad = {
    ...GOOD_SCHEDULES,
    Robin: [{ time: 800, location: "Narnia", x: 4, y: 4, facing: 2 }, ...GOOD_SCHEDULES.Robin!.slice(1)],
    Lewis: [{ ...GOOD_SCHEDULES.Lewis![0]!, time: 500 }, ...GOOD_SCHEDULES.Lewis!.slice(1)],
  };
  const quests = [
    { ...GOOD_QUEST, item: "(O)99999" },
    { ...GOOD_QUEST, reward: 5000 },
    GOOD_QUEST,
  ];
  await withWorld(fakeAdapter([reply({ npcs: npcsEntry(bad), quests })]), async (c, logs) => {
    const res = await c.post("/v1/plan", planReq(spring(6)));
    assert.equal(res.status, 200);
    const p = res.json;
    assertValid("plan-response", p);
    assert.equal(p.source, "model");

    assert.deepEqual(
      p.dropped.map((d: { part: string }) => d.part),
      // Schedules in cast order (Lewis before Robin), then the quest candidates in order.
      ["schedule Lewis", "schedule Robin", "quest 1", "quest 2"],
    );
    const reasons = Object.fromEntries(p.dropped.map((d: { part: string; reason: string }) => [d.part, d.reason]));
    assert.match(reasons["schedule Robin"], /location "Narnia" is not in the world/);
    assert.match(reasons["schedule Lewis"], /time 500 is not a game time in 610\.\.2600/);
    assert.match(reasons["quest 1"], /item "\(O\)99999" is not an item in the world/);
    assert.match(reasons["quest 2"], /reward 5000g is over the 500g cap/);

    // The rest is intact.
    assert.deepEqual(p.schedules.map((s: { npc: string }) => s.npc), ["Abigail", "Emily", "Gus", "Haley", "Pierre", "Shane"]);
    for (const s of p.schedules) assert.deepEqual(s.stops, GOOD_SCHEDULES[s.npc]);
    assert.deepEqual(p.happening, HAPPENING);
    assert.deepEqual(p.quest, { id: "townsfolk_5", ...GOOD_QUEST });
    assert.deepEqual(p.friendship, FRIENDSHIP);
    assert.deepEqual(p.relationships, RELATIONSHIPS);
    assert.equal(p.goals.length, 8);

    const dropLogs = logs.filter((l) => / dropped /.test(l));
    assert.equal(dropLogs.length, 4, dropLogs.join("\n"));
  });
});

test("done-when 2: Gus repeating one schedule 8 nights running gets a regen on night 2 onward, and runs vanilla when the regen repeats too", async () => {
  const gus = GOOD_SCHEDULES.Gus!;
  let night = 0;
  const regens: number[] = [];
  const model: ModelAdapter & { calls: string[] } = {
    name: "fake",
    calls: [],
    async complete(system) {
      if (system.startsWith("You replan")) {
        regens.push(night);
        this.calls.push("regen");
        return JSON.stringify({ schedules: [{ npc: "Gus", schedule: gus }] });
      }
      night++;
      this.calls.push("plan");
      return reply({ npcs: npcsEntry(variedSchedules(night, { Gus: gus })), happening: null });
    },
  };
  await withWorld(model, async (c) => {
    for (let n = 1; n <= 8; n++) {
      const p = (await c.post("/v1/plan", planReq(spring(n + 1)))).json;
      const planned = p.schedules.map((s: { npc: string }) => s.npc);
      const others = CAST.filter((x) => x !== "Gus");
      assert.deepEqual(planned.filter((x: string) => x !== "Gus"), others, `night ${n}: everyone else keeps a plan`);
      if (n === 1) {
        assert.ok(planned.includes("Gus"), "night 1: nothing to repeat yet");
        assert.deepEqual(p.dropped, []);
      } else {
        assert.ok(!planned.includes("Gus"), `night ${n}: Gus runs vanilla`);
        assert.deepEqual(p.dropped, [{ part: "schedule Gus", reason: "repeated a recent schedule again after one regen; vanilla" }]);
      }
    }
  });
  assert.deepEqual(regens, [2, 3, 4, 5, 6, 7, 8]);
  assert.equal(model.calls.length, 8 + 7);
});

test("a regen that gives a fresh schedule is used", async () => {
  const gus = GOOD_SCHEDULES.Gus!;
  const fresh = [{ time: 700, location: "Beach", x: 20, y: 20, facing: 1 }, { time: 1100, location: "Saloon", x: 10, y: 18, facing: 2 }];
  const model = fakeAdapter([
    reply({ npcs: npcsEntry(variedSchedules(1, { Gus: gus })) }),
    reply({ npcs: npcsEntry(variedSchedules(2, { Gus: gus })), happening: null }),
    JSON.stringify({ schedules: [{ npc: "Gus", schedule: fresh }] }),
  ]);
  await withWorld(model, async (c) => {
    await c.post("/v1/plan", planReq(spring(2)));
    const p = (await c.post("/v1/plan", planReq(spring(3)))).json;
    assert.deepEqual(p.schedules.find((s: { npc: string }) => s.npc === "Gus").stops, fresh);
    assert.deepEqual(p.dropped, []);
    assert.equal(model.calls.length, 3);
  });
});

test("done-when 3: a goal marked complete is replaced the next night by a different goal", async () => {
  const dress = "Sew a new dress for the Flower Dance";
  const replies = [
    reply({ npcs: npcsEntry(variedSchedules(1), { Emily: goal("Emily", dress, 40) }) }),
    reply({ npcs: npcsEntry(variedSchedules(2), { Emily: goal("Emily", dress, 100) }) }),
    reply({ npcs: npcsEntry(variedSchedules(3), { Emily: goal("Emily", "Start a crystal garden behind the house", 5) }) }),
  ];
  const model = fakeAdapter(replies);
  await withWorld(model, async (c) => {
    const emily = (p: { goals: { npc: string; text: string }[] }) => p.goals.find((g) => g.npc === "Emily");
    const n1 = (await c.post("/v1/plan", planReq(spring(2)))).json;
    assert.deepEqual(emily(n1), { npc: "Emily", text: dress, progress: 40, isNew: true });
    const n2 = (await c.post("/v1/plan", planReq(spring(3)))).json;
    assert.deepEqual(emily(n2), { npc: "Emily", text: dress, progress: 100, isNew: false });

    const n3 = (await c.post("/v1/plan", planReq(spring(4)))).json;
    const prompt = model.calls[2]!.user;
    const block = prompt.slice(prompt.indexOf("## Emily"), prompt.indexOf("## Gus"));
    assert.match(block, /Goal: NEW NEEDED\. Emily just finished "Sew a new dress for the Flower Dance"/);
    assert.match(block, /do not reuse: "Sew a new dress for the Flower Dance"/);
    assert.deepEqual(emily(n3), { npc: "Emily", text: "Start a crystal garden behind the house", progress: 5, isNew: true });
    assert.notEqual(emily(n3)!.text, dress);
    assert.deepEqual(n3.dropped, []);
  });
});

test("a finished goal proposed again is refused, and an active goal may not be swapped or lowered", async () => {
  const dress = "Sew a new dress for the Flower Dance";
  const model = fakeAdapter([
    reply({ npcs: npcsEntry(variedSchedules(1), { Emily: goal("Emily", dress, 100 - 1), Gus: goal("Gus", "Perfect a new pie", 30) }) }),
    reply({ npcs: npcsEntry(variedSchedules(2), { Emily: goal("Emily", dress, 100), Gus: goal("Gus", "Open a food stall", 10) }) }),
    reply({ npcs: npcsEntry(variedSchedules(3), { Emily: goal("Emily", dress.toUpperCase(), 0), Gus: goal("Gus", "Perfect a new pie", 20) }) }),
  ]);
  await withWorld(model, async (c) => {
    await c.post("/v1/plan", planReq(spring(2)));
    const n2 = (await c.post("/v1/plan", planReq(spring(3)))).json;
    assert.deepEqual(n2.dropped, [{ part: "goal Gus", reason: 'the active goal "Perfect a new pie" is not finished; the text must stay the same' }]);
    const n3 = (await c.post("/v1/plan", planReq(spring(4)))).json;
    const reasons = Object.fromEntries(n3.dropped.map((d: { part: string; reason: string }) => [d.part, d.reason]));
    assert.match(reasons["goal Emily"], /was already a goal; a new one must differ/);
    assert.match(reasons["goal Gus"], /progress 20 is below the current 30/);
    assert.equal(n3.goals.find((g: { npc: string }) => g.npc === "Emily"), undefined);
    assert.deepEqual(n3.goals.find((g: { npc: string }) => g.npc === "Gus"), { npc: "Gus", text: "Perfect a new pie", progress: 30, isNew: false });
  });
});

test("done-when 4: every /v1/plan response validates against plan-response, including the fallback and festival ones", async () => {
  await withWorld(fakeAdapter(["not json", "THROW"]), async (c) => {
    const p = (await c.post("/v1/plan", planReq(spring(6)))).json;
    assert.equal(p.source, "fallback");
    assert.deepEqual(p.schedules, []);
    assert.equal(p.dropped.length, 1);
    const fest = (await c.post("/v1/plan", planReq(spring(13)))).json;
    assert.equal(fest.source, "festival");
    assert.deepEqual(fest.dropped, []);
  });
});

test("a festival day is never planned: no model call", async () => {
  const model = fakeAdapter([reply()]);
  await withWorld(model, async (c) => {
    assert.equal((await c.post("/v1/plan", planReq(spring(24)))).json.source, "festival");
    assert.equal(model.calls.length, 0);
  });
});

test("without a world snapshot /v1/plan answers 409, which the bridge treats as brain down", async () => {
  const model = fakeAdapter([reply()]);
  await withServer(model, async (c) => {
    const res = await c.postRaw("/v1/plan", planReq(spring(6)));
    assert.equal(res.status, 409);
    assert.match(res.json.error, /POST \/v1\/world/);
    assert.equal(model.calls.length, 0);
  });
});

test("validator: times, GOTO, married NPCs, tiles, happening presence, caps, quest id prefix", async () => {
  const s = (stops: unknown) => checkSchedule("Gus", stops, W);
  assert.ok(s(GOOD_SCHEDULES.Gus).ok);
  assert.match((s([{ time: 900, location: "Town", x: 1, y: 1, facing: 2 }, { time: 900, location: "Saloon", x: 1, y: 1, facing: 2 }]) as { reason: string }).reason, /not after 900/);
  assert.match((s([{ time: 2610, location: "Town", x: 1, y: 1, facing: 2 }]) as { reason: string }).reason, /not a game time/);
  assert.match((s([{ time: 905, location: "Town", x: 1, y: 1, facing: 2 }]) as { reason: string }).reason, /not a game time/);
  assert.match((s([{ time: 900, location: "Town", x: 120, y: 1, facing: 2 }]) as { reason: string }).reason, /outside Town \(120x110\)/);
  assert.match((s("900 Town 1 1 2/GOTO spring") as { reason: string }).reason, /must be a list/);
  assert.match((s([{ time: 900, location: "GOTO", x: 1, y: 1, facing: 2 }]) as { reason: string }).reason, /not in the world/);
  assert.match((checkSchedule("Gus", GOOD_SCHEDULES.Gus, { ...W, married: ["Gus"] }) as { reason: string }).reason, /married/);

  const late = { ...GOOD_SCHEDULES, Pierre: [GOOD_SCHEDULES.Pierre![0]!, { time: 2000, location: "Saloon", x: 25, y: 15, facing: 2 }] };
  const bigShifts = {
    friendship: [{ npc: "Emily", delta: 41, reason: "x" }, { npc: "Gus", delta: 40, reason: "fed him compliments" }, { npc: "Gus", delta: 5, reason: "again" }],
    relationships: [{ a: "Emily", b: "Haley", delta: -11, reason: "x" }, { a: "Gus", b: "Shane", delta: 10, reason: "late talk at the bar" }],
    quests: [{ ...GOOD_QUEST, from: "Krobus" }, { ...GOOD_QUEST, reward: 500 }],
  };
  await withWorld(fakeAdapter([reply({ npcs: npcsEntry(late), ...bigShifts })]), async (c) => {
    const p = (await c.post("/v1/plan", planReq(spring(6)))).json;
    const parts = Object.fromEntries(p.dropped.map((d: { part: string; reason: string }) => [d.part, d.reason]));
    assert.match(parts["happening participant Pierre"], /not scheduled at Saloon from 1900 to 2100/);
    assert.deepEqual(p.happening.participants, ["Gus", "Emily", "Shane"]);
    assert.match(parts["friendship Emily"], /over the \+-40 daily cap/);
    assert.match(parts["friendship Gus"], /second shift/);
    assert.match(parts["relationship Emily-Haley"], /over the \+-10 daily cap/);
    assert.match(parts["quest 1"], /not in the planning cast/);
    assert.equal(p.quest.reward, 500);
    assert.match(p.quest.id, /^townsfolk_\d+$/);
    assert.deepEqual(p.friendship.map((f: { npc: string }) => f.npc), ["Gus"]);
    assert.deepEqual(p.relationships.map((r: { a: string }) => r.a), ["Gus"]);
  });
});

test("a happening with fewer than 2 participants scheduled there is dropped as a whole", async () => {
  const away = { ...GOOD_SCHEDULES, Emily: GOOD_SCHEDULES.Haley, Pierre: GOOD_SCHEDULES.Lewis, Shane: GOOD_SCHEDULES.Robin };
  await withWorld(fakeAdapter([reply({ npcs: npcsEntry(away) })]), async (c) => {
    const p = (await c.post("/v1/plan", planReq(spring(6)))).json;
    assert.equal(p.happening, null);
    assert.ok(p.dropped.some((d: { part: string; reason: string }) => d.part === "happening" && /fewer than 2/.test(d.reason)));
  });
});

test("NPC relationship shifts reach the town state only when the planned day is saved", async () => {
  await withWorld(fakeAdapter([reply()]), async (c) => {
    await c.post("/v1/plan", planReq(spring(6)));
    const before = (await c.store.loadTown(SAVE)).relationships[pairKey("Emily", "Haley")];
    assert.equal(before, 50);
    const dayEnd = { v: 1, saveId: SAVE, playerName: "Tae", day: { ...spring(6), time: 2200, weather: "sunny", location: "Farm" }, events: [] };
    await c.post("/v1/day-end", dayEnd);
    assert.equal((await c.store.loadTown(SAVE)).relationships[pairKey("Emily", "Haley")], 50, "not before the save");
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(6) });
    assert.equal((await c.store.loadTown(SAVE)).relationships[pairKey("Emily", "Haley")], 55);
  });
});

test("planner prompt: each NPC's block holds only its own memory and facts, plus goals, relationships, calendar and a 7-night digest", async () => {
  const model = fakeAdapter(Array.from({ length: 10 }, (_, i) => reply({ npcs: npcsEntry(variedSchedules(i + 1)) })));
  await withWorld(model, async (c) => {
    const town = { ...emptyTown(), facts: [newFact("canary", spring(1), "CANARY-123: Emily is sewing a secret costume.", true, { Emily: { kind: "told" } })] };
    await c.store.saveTown(SAVE, town);
    // Tonight's day is pending (not saved): the planner still sees it, for the NPC who was there.
    const dayEnd = {
      v: 1, saveId: SAVE, playerName: "Tae", day: { ...spring(1), time: 2200, weather: "sunny", location: "Farm" },
      events: [{ type: "talk", npc: "Shane", location: "Saloon", time: 2000, witnesses: [], npcLine: "SHANE-LINE-77", playerChoice: "Rough day?" }],
    };
    await c.post("/v1/day-end", dayEnd);
    for (let n = 2; n <= 10; n++) await c.post("/v1/plan", planReq(spring(n)));
    const first = model.calls[0]!.user;
    const blocks = Object.fromEntries(CAST.map((npc, i) => [npc, first.slice(first.indexOf(`## ${npc}`), i + 1 < CAST.length ? first.indexOf(`## ${CAST[i + 1]}`) : undefined)]));
    assert.match(blocks.Emily!, /CANARY-123/);
    assert.match(blocks.Shane!, /SHANE-LINE-77/);
    for (const npc of CAST) {
      if (npc !== "Emily") assert.doesNotMatch(blocks[npc]!, /CANARY-123/, npc);
      if (npc !== "Shane") assert.doesNotMatch(blocks[npc]!, /SHANE-LINE-77/, npc);
      assert.match(blocks[npc]!, /Feelings toward the others/);
      assert.match(blocks[npc]!, /Goal: /);
    }
    assert.match(blocks.Haley!, /Shane -25/);
    assert.doesNotMatch(first, /CANARY-123[\s\S]*CANARY-123/, "the canary appears once, in Emily's block");
    assert.match(first, /Festivals in the next two weeks: spring 13, year 1: Egg Festival/);
    assert.match(first, /No earlier plans\./);
    const last = model.calls.at(-1)!.user;
    const digest = last.slice(last.indexOf("Recent plans"), last.indexOf("Plan tomorrow"));
    assert.equal(digest.match(/^- spring/gm)?.length, 7, "digest holds the last 7 nights only");
    assert.doesNotMatch(digest, /spring 2, year 1/);
    assert.match(digest, /spring 9, year 1/);
    assert.match(digest, /Gus: \d+ Saloon/);
  });
});

test("the plan state stays bounded and replanning a date replaces it", async () => {
  const model = fakeAdapter(Array.from({ length: 20 }, (_, i) => reply({ npcs: npcsEntry(variedSchedules((i % 6) + 1)) })));
  await withWorld(model, async (c) => {
    for (let n = 2; n <= 14; n++) await c.post("/v1/plan", planReq(spring(n)));
    await c.post("/v1/plan", planReq(spring(10)));
    const state = await c.store.loadPlans(SAVE);
    assert.ok(state.nights.length <= 8);
    assert.equal(state.nights.at(-1)!.day.day, 10, "a replan of an earlier date drops the later nights");
    assert.ok(state.nights.every((n, i, all) => i === 0 || n.day.day > all[i - 1]!.day.day));
  });
});

test("schedule signature ignores tile and facing", () => {
  const a = GOOD_SCHEDULES.Gus!;
  const b = a.map((s) => ({ ...s, x: s.x + 1, facing: 0 }));
  assert.equal(scheduleSignature(a), scheduleSignature(b));
});
