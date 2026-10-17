// Slice 2: knowledge boundaries. Facts have knowers; gossip moves shareable facts between NPCs
// who spent the day together, at most MAX_HOPS passes; each NPC's prompt shows only its own
// facts and the stats it may know.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CAST, pairKey, startingRelationships } from "../src/cast.ts";
import { dayKey, type PendingDay } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { SEASONS, type DayRef, type GameDay, type GameStats } from "../src/protocol.ts";
import { seededRng, type Rng } from "../src/rng.ts";
import { KNOWN_BY } from "../src/stats.ts";
import { knowledgeBlock } from "../src/talk.ts";
import {
  applyNight,
  emptyTown,
  gossipNight,
  MAX_HOPS,
  newFact,
  passChance,
  TEXT_MAX_BY_HOPS,
  type TownState,
} from "../src/town.ts";
import { tempStore, talkReq, withServer } from "./helpers.ts";

const SAVE = "Farm_123";
const spring1: GameDay = { season: "spring", day: 1, year: 1, time: 2200, weather: "sunny", location: "Saloon" };
const ref = (d: DayRef): DayRef => ({ season: d.season, day: d.day, year: d.year });
const always: Rng = { next: () => 0 };
const never: Rng = { next: () => 0.999 };

function canaryTown(shareable: boolean): TownState {
  const text = shareable ? "CANARY-123: Emily is sewing a secret costume for the Flower Dance." : "CANARY-123: the farmer is thinking of leaving the valley.";
  return { ...emptyTown(), facts: [newFact("canary", ref(spring1), text, shareable, { Emily: { kind: "told" } })] };
}

function night(day: GameDay, together: string[][]): PendingDay {
  return { saveId: SAVE, playerName: "Tae", day, events: [], together: together.map((npcs) => ({ location: "Town", npcs })) };
}

function dayAt(n: number): GameDay {
  return { season: SEASONS[Math.floor(n / 28) % 4]!, day: (n % 28) + 1, year: Math.floor(n / 112) + 1, time: 2200, weather: "sunny", location: "Town" };
}

test("canary, day 1: only Emily's talk prompt carries CANARY-123; after a seeded night together Haley has it as heard from Emily", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    await c.store.saveTown(SAVE, canaryTown(true));
    for (const npc of CAST) {
      const before = model.calls.length;
      assert.equal((await c.post("/v1/talk", talkReq({ npc, day: spring1 }))).status, 200);
      const prompt = model.calls[before]!.user;
      if (npc === "Emily") assert.match(prompt, /CANARY-123/);
      else assert.doesNotMatch(prompt, /CANARY-123/, `${npc} day 1`);
    }

    // The night: Emily and Haley in the same place, the day saved. The night's dice come from
    // the save id and date, so this pass is the same on every run.
    const dayEnd = { v: 1, saveId: SAVE, playerName: "Tae", day: spring1, events: [], together: [{ location: "Saloon", npcs: ["Emily", "Haley"] }] };
    assert.equal((await c.post("/v1/day-end", dayEnd)).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(spring1) })).json.outcome, "committed");

    const spring2: GameDay = { ...spring1, day: 2, time: 1000 };
    const prompts: Record<string, string> = {};
    for (const npc of CAST) {
      const before = model.calls.length;
      await c.post("/v1/talk", talkReq({ npc, day: spring2 }));
      prompts[npc] = model.calls[before]!.user;
    }
    assert.match(prompts.Haley!, /CANARY-123.*\(heard from Emily, spring 1, year 1\)/);
    for (const npc of CAST.filter((n) => n !== "Emily" && n !== "Haley")) {
      assert.doesNotMatch(prompts[npc]!, /CANARY-123/, `${npc} after night 1`);
    }
  });
});

test("canary, planner side: knowledgeBlock (the shared per-NPC block the planner will use) carries CANARY-123 for Emily only", () => {
  const town = canaryTown(true);
  for (const npc of CAST) {
    const block = knowledgeBlock(npc, {}, town);
    if (npc === "Emily") assert.match(block, /CANARY-123/);
    else assert.doesNotMatch(block, /CANARY-123/, npc);
  }
});

test("canary, 3 hops: even when every pass succeeds, a chain Emily-Haley-Gus-Shane stops at Gus (2 hops)", () => {
  let town = canaryTown(true);
  // Every pair of the chain is together every night for a week, and every dice roll passes.
  const chain: [string, string][] = [
    ["Emily", "Haley"],
    ["Gus", "Haley"],
    ["Gus", "Shane"],
  ];
  for (let n = 0; n < 7; n++) town = gossipNight(town, ref(dayAt(n)), chain, always);
  const knowers = town.facts[0]!.knowers;
  assert.deepEqual(Object.keys(knowers).sort(), ["Emily", "Gus", "Haley"]);
  assert.equal(knowers.Haley!.hops, 1);
  assert.equal(knowers.Gus!.hops, MAX_HOPS);
  assert.deepEqual(knowers.Gus!.source, { kind: "heard", from: "Haley" });
  assert.doesNotMatch(knowledgeBlock("Shane", {}, town), /CANARY-123/);
  assert.match(knowledgeBlock("Gus", {}, town), /CANARY-123.*heard from Haley/);
});

test("gossip moves one hop a night and shortens the text at each hop", () => {
  const long = `CANARY-123 ${"word ".repeat(60)}`.trim();
  let town: TownState = { ...emptyTown(), facts: [newFact("f", ref(spring1), long, true, { Emily: { kind: "saw" } })] };
  const pairs: [string, string][] = [
    ["Emily", "Haley"],
    ["Gus", "Haley"],
  ];
  town = gossipNight(town, ref(spring1), pairs, always);
  assert.deepEqual(Object.keys(town.facts[0]!.knowers).sort(), ["Emily", "Haley"], "one hop on the first night");
  town = gossipNight(town, ref(dayAt(1)), pairs, always);
  const k = town.facts[0]!.knowers;
  assert.ok(k.Emily!.text.length <= TEXT_MAX_BY_HOPS[0]);
  assert.ok(k.Haley!.text.length <= TEXT_MAX_BY_HOPS[1] && k.Haley!.text.length < k.Emily!.text.length);
  assert.ok(k.Gus!.text.length <= TEXT_MAX_BY_HOPS[2] && k.Gus!.text.length < k.Haley!.text.length);
  assert.match(k.Gus!.text, /^CANARY-123/);
});

test("a non-shareable fact stays put even when it is fresh and every dice roll passes", () => {
  const town = gossipNight(canaryTown(false), ref(spring1), [["Emily", "Haley"]], always);
  assert.deepEqual(Object.keys(town.facts[0]!.knowers), ["Emily"]);
});

test("gossip needs the dice: a pair that never rolls under its chance passes nothing", () => {
  const town = gossipNight(canaryTown(true), ref(spring1), [["Emily", "Haley"]], never);
  assert.deepEqual(Object.keys(town.facts[0]!.knowers), ["Emily"]);
  assert.ok(passChance(-100) < passChance(0) && passChance(0) < passChance(100));
});

test("a non-shareable fact never spreads in a 112-day seeded run, while shareable facts do", async () => {
  const store = await tempStore();
  await store.saveTown(SAVE, canaryTown(false));
  const rng = seededRng(42);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)]!;
  for (let n = 0; n < 112; n++) {
    const d = dayAt(n);
    // Three random groups of 2 to 4 cast members a day, Emily always in one of them, and one gift
    // in front of a witness so there is shareable news to move.
    const groups = [0, 1, 2].map((g) => {
      const size = 2 + Math.floor(rng.next() * 3);
      const set = new Set<string>(g === 0 ? ["Emily"] : []);
      while (set.size < size) set.add(pick(CAST));
      return [...set];
    });
    const receiver = pick(CAST);
    const witness = pick(CAST.filter((x) => x !== receiver));
    await store.stage({
      v: 1,
      ...night(d, groups),
      events: [{ type: "gift", npc: receiver, location: "Town", time: 1200, witnesses: [witness], item: "Daffodil" }],
    });
    assert.equal((await store.commit(SAVE, ref(d))).outcome, "committed");
  }
  const town = await store.loadTown(SAVE);
  const canary = town.facts.find((f) => f.id === "canary");
  assert.ok(canary, "the confidential fact is still held");
  assert.deepEqual(Object.keys(canary.knowers), ["Emily"]);
  const heard = town.facts.flatMap((f) => Object.values(f.knowers)).filter((k) => k.source.kind === "heard");
  assert.ok(heard.length > 20, `shareable facts spread (${heard.length} heard copies)`);
  assert.ok(heard.every((k) => k.hops >= 1 && k.hops <= MAX_HOPS));
  for (const npc of CAST.filter((n) => n !== "Emily")) assert.doesNotMatch(knowledgeBlock(npc, {}, town), /CANARY-123/, npc);
  // Emily's prompt shows only her MAX_PROMPT_FACTS newest facts, so after 112 days of news the
  // confidence has aged out of her prompt. It is still in her state (checked above).
});

test("a confidence is labelled in the teller's own prompt so the model does not repeat it", () => {
  assert.match(knowledgeBlock("Emily", {}, canaryTown(false)), /CANARY-123.*in confidence; do not repeat it/);
});

test("the same seed gives the same town; a repeated commit of the same night changes nothing", () => {
  const pairs = night(spring1, [["Emily", "Haley", "Gus", "Shane", "Pierre"]]);
  const a = applyNight(canaryTown(true), pairs, seededRng(7));
  const b = applyNight(canaryTown(true), pairs, seededRng(7));
  assert.deepEqual(a, b);
  assert.equal(a.lastNight, dayKey(spring1));
  assert.equal(applyNight(a, pairs, always), a);
});

const STATS: GameStats = {
  farmName: "Starfruit Hollow",
  daysPlayed: 37,
  communityCenterRooms: 3,
  deepestMineLevel: 45,
  farmBuildings: ["Coop", "Silo"],
  money: 98765,
};

test("known stats: Pierre gets the farm name but not the money; Lewis gets community center progress, Shane does not", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const prompts: Record<string, string> = {};
    for (const npc of CAST) {
      const before = model.calls.length;
      await c.post("/v1/talk", talkReq({ npc, stats: STATS }));
      prompts[npc] = model.calls[before]!.user;
    }
    assert.match(prompts.Pierre!, /Starfruit Hollow/);
    assert.doesNotMatch(prompts.Pierre!, /98765/);
    assert.match(prompts.Lewis!, /Community center rooms restored: 3 of 6/);
    assert.doesNotMatch(prompts.Shane!, /[Cc]ommunity center/);
    assert.match(prompts.Abigail!, /mine level.*45/);
    assert.match(prompts.Robin!, /Coop, Silo/);
    for (const npc of CAST) {
      assert.match(prompts[npc]!, /Starfruit Hollow/, `${npc} knows the farm name`);
      assert.match(prompts[npc]!, /37 days/, `${npc} knows days in the valley`);
      assert.doesNotMatch(prompts[npc]!, /98765/, `${npc} never sees money`);
    }
  });
});

test("no NPC is allowed to know money, and unknown stat keys from the bridge are dropped", async () => {
  for (const keys of Object.values(KNOWN_BY)) assert.ok(!keys.includes("money"));
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const body = { ...talkReq({ npc: "Lewis" }), stats: { farmName: "Starfruit Hollow", secretThing: "LEAK-999" } };
    assert.equal((await c.post("/v1/talk", body)).status, 200);
    assert.doesNotMatch(model.calls[0]!.user, /LEAK-999/);
  });
});

test("NPC relationships: every cast pair has a starting score in -100..100, stored with the town state", async () => {
  const rel = startingRelationships();
  const pairs = CAST.flatMap((a, i) => CAST.slice(i + 1).map((b) => pairKey(a, b)));
  assert.deepEqual(Object.keys(rel).sort(), pairs.sort());
  for (const s of Object.values(rel)) assert.ok(Number.isInteger(s) && s >= -100 && s <= 100);
  const store = await tempStore();
  await store.stage({ v: 1, ...night(spring1, []) });
  await store.commit(SAVE, ref(spring1));
  const onDisk = JSON.parse(await readFile(join(store.dir, SAVE, "_town.json"), "utf8")) as TownState;
  assert.deepEqual(onDisk.relationships, rel);
});

