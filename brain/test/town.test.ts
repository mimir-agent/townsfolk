// Slice 2: knowledge boundaries. Facts have knowers; gossip moves shareable facts between NPCs
// who spent the day together, at most MAX_HOPS passes; each NPC's prompt shows only its own
// facts and the stats it may know.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { CAST, pairKey } from "../src/cast.ts";
import { seedRelationships } from "../src/graph.ts";
import { dayKey, type PendingDay } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { MAIN_FARMER, SEASONS, type DayRef, type GameDay, type GameStats } from "../src/protocol.ts";
import { seededRng, type Rng } from "../src/rng.ts";
import { KNOWN_BY } from "../src/stats.ts";
import { knowledgeBlock } from "../src/talk.ts";
import {
  applyNight,
  CLOSE_DECAY,
  DISTANT_TEXT_MAX,
  emptyTown,
  factsFromDay,
  FRESH_DAYS,
  FRIENDLY_TEXT_MAX,
  gossipNight,
  knownFactLines,
  MAX_HOPS,
  newFact,
  OTHER_DECAY,
  passChance,
  retell,
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
    const block = knowledgeBlock(npc, {}, town, []);
    if (npc === "Emily") assert.match(block, /CANARY-123/);
    else assert.doesNotMatch(block, /CANARY-123/, npc);
  }
});

// A chain of close pairs (canon-2.md PAIR TABLE): Jodi|Vincent 75, Sam|Vincent 70,
// Sam|Sebastian 70, Abigail|Sebastian 60. Confidence stays over 0.3 for 4 close hops
// (0.8^4 = 0.41), so only MAX_HOPS stops the fourth pass.
const CLOSE_CHAIN: [string, string][] = [
  ["Jodi", "Vincent"],
  ["Sam", "Vincent"],
  ["Sam", "Sebastian"],
  ["Abigail", "Sebastian"],
];

function chainTown(shareable: boolean): TownState {
  return { ...emptyTown(), facts: [newFact("canary", ref(spring1), "CANARY-123: Jodi is planning a surprise for Sam.", shareable, { Jodi: { kind: "told" } })] };
}

test("canary, seeded chain: the fact reaches the 3-hop villager and never the 4-hop one", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    let town = chainTown(true);
    const rng = seededRng(seed);
    for (let n = 0; n < FRESH_DAYS; n++) town = gossipNight(town, ref(dayAt(n)), CLOSE_CHAIN, rng).town;
    const k = town.facts[0]!.knowers;
    assert.equal(k.Sebastian?.hops, MAX_HOPS, `seed ${seed}: Sebastian is 3 hops from Jodi`);
    assert.deepEqual(k.Sebastian!.source, { kind: "heard", from: "Sam" });
    assert.equal(k.Abigail, undefined, `seed ${seed}: Abigail is 4 hops away`);
    assert.doesNotMatch(knowledgeBlock("Abigail", {}, town, []), /CANARY-123/);
  }
  // Even when every roll passes.
  let town = chainTown(true);
  for (let n = 0; n < FRESH_DAYS; n++) town = gossipNight(town, ref(dayAt(n)), CLOSE_CHAIN, always).town;
  assert.deepEqual(Object.keys(town.facts[0]!.knowers).sort(), ["Jodi", "Sam", "Sebastian", "Vincent"]);
});

test("a non-shareable fact never moves along the chain, even when every roll passes", () => {
  let town = chainTown(false);
  for (let n = 0; n < FRESH_DAYS; n++) town = gossipNight(town, ref(dayAt(n)), CLOSE_CHAIN, always).town;
  assert.deepEqual(Object.keys(town.facts[0]!.knowers), ["Jodi"]);
  assert.deepEqual(gossipNight(canaryTown(false), ref(spring1), [["Emily", "Haley"]], always).town.facts[0]!.knowers.Haley, undefined);
});

test("confidence: 0.8 per close hop, 0.6 per other hop; a copy that would fall under 0.3 is not passed", () => {
  // Emily|Haley 50 close, Gus|Haley 10 neutral, Gus|Shane 40 friendly (canon-2.md PAIR TABLE).
  let town = canaryTown(true);
  const chain: [string, string][] = [
    ["Emily", "Haley"],
    ["Gus", "Haley"],
    ["Gus", "Shane"],
  ];
  for (let n = 0; n < 7; n++) town = gossipNight(town, ref(dayAt(n)), chain, always).town;
  const k = town.facts[0]!.knowers;
  assert.equal(k.Haley!.confidence, CLOSE_DECAY);
  assert.ok(Math.abs(k.Gus!.confidence! - CLOSE_DECAY * OTHER_DECAY) < 1e-9);
  assert.equal(k.Shane, undefined, "0.48 * 0.6 = 0.288 is under 0.3");
  assert.match(knowledgeBlock("Gus", {}, town, []), /CANARY-123.*heard from Haley.*half-remembered/);
  assert.doesNotMatch(knowledgeBlock("Haley", {}, town, []), /half-remembered/);
});

test("fidelity by band: close whole, friendly 120, neutral 70 and hedged, cool drops time and place and hedges", () => {
  const long = `Emily ${"stitched a costume ".repeat(12)}at the Saloon on Friday.`;
  assert.equal(retell(long, "close", "Saloon"), long);
  assert.ok(retell(long, "friendly", "Saloon").length <= FRIENDLY_TEXT_MAX);
  const neutral = retell(long, "neutral", "Saloon");
  assert.ok(neutral.startsWith("apparently ") && neutral.length <= DISTANT_TEXT_MAX + "apparently ".length);
  const short = "Haley gave Gus a Daffodil at the Saloon on Friday at 7pm.";
  assert.equal(retell(short, "cool", "Saloon"), "apparently Haley gave Gus a Daffodil.");
  assert.equal(retell(short, "at odds", "Saloon"), "apparently Haley gave Gus a Daffodil.");
  assert.equal(retell(retell(short, "neutral", "Saloon"), "neutral", "Saloon"), retell(short, "neutral", "Saloon"), "hedged once");
});

test("1,000 seeded hops never produce a capitalized word absent from the source text", () => {
  const rng = seededRng(99);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rng.next() * xs.length)]!;
  const names = ["Emily", "Clint", "Haley", "Gus", "Krobus", "Pierre"];
  const places = ["Saloon", "Pelican Town", "Pierre's", "Beach", "Mountain"];
  const items = ["Amethyst", "Daffodil", "Pale Ale", "Cave Carrot"];
  const tails = ["", " on Friday", " at 7pm", " tomorrow", " this spring", " in the evening"];
  const bands = ["close", "friendly", "neutral", "cool", "at odds"] as const;
  const words = (s: string) => new Set(s.match(/[A-Za-z']+/g) ?? []);
  for (let i = 0; i < 1000; i++) {
    const place = pick(places);
    const source = `${pick(names)} said ${pick(names)} wants a ${pick(items)} near the ${place}${pick(tails)}, and ${"more words ".repeat(Math.floor(rng.next() * 12))}that is all.`;
    let text = source;
    for (let h = 0; h < 1 + Math.floor(rng.next() * MAX_HOPS); h++) text = retell(text, pick(bands), place);
    const have = words(source);
    for (const w of text.match(/\b[A-Z][A-Za-z']*/g) ?? []) assert.ok(have.has(w), `hop ${i}: "${w}" is not in "${source}" (got "${text}")`);
  }
});

test("pass chance by band over 10,000 seeded trials: close 0.65..0.75, at odds at most 0.04", () => {
  const rate = (a: string, b: string, seed: number) => {
    const rng = seededRng(seed);
    const town: TownState = { ...emptyTown(), facts: [newFact("f", ref(spring1), "Fresh news.", true, { [a]: { kind: "told" } })] };
    let passed = 0;
    for (let i = 0; i < 10_000; i++) if (gossipNight(town, ref(spring1), [[a, b]], rng).town.facts[0]!.knowers[b] !== undefined) passed++;
    return passed / 10_000;
  };
  const close = rate("Jodi", "Vincent", 11); // 75 in canon-2.md PAIR TABLE
  const odds = rate("Dwarf", "Krobus", 12); // -60 from roster.md (old war), spec-v2 slice S
  assert.ok(close >= 0.65 && close <= 0.75, `close ${close}`);
  assert.ok(odds <= 0.04, `at odds ${odds}`);
});

test("non-cast gossip: Clint learns Emily's shareable fact after a night together at the Saloon", async () => {
  const store = await tempStore();
  const text = "CANARY-777: Emily is sewing a costume for the Flower Dance.";
  await store.saveTown(SAVE, { ...emptyTown(), facts: [newFact("canary", ref(spring1), text, true, { Emily: { kind: "told" } })] });
  await store.stage({ v: 1, ...night(spring1, []), together: [{ location: "Saloon", npcs: ["Clint", "Emily"] }] });
  assert.equal((await store.commit(SAVE, ref(spring1))).outcome, "committed");
  const town = await store.loadTown(SAVE);
  // Clint|Emily is 30 (canon-2.md PAIR TABLE): friendly, so the copy is whole under 120 chars.
  assert.deepEqual(town.facts[0]!.knowers.Clint, { source: { kind: "heard", from: "Emily" }, hops: 1, text, learned: spring1, confidence: OTHER_DECAY });
  assert.match(knowledgeBlock("Clint", {}, town, []), /CANARY-777.*heard from Emily/);
  assert.deepEqual(town.lastNightLog!.hops, [{ fact: "canary", from: "Emily", to: "Clint", hops: 1, confidence: OTHER_DECAY }]);
});

test("gossip needs the dice: a pair that never rolls under its chance passes nothing", () => {
  const town = gossipNight(canaryTown(true), ref(spring1), [["Emily", "Haley"]], never).town;
  assert.deepEqual(Object.keys(town.facts[0]!.knowers), ["Emily"]);
  assert.ok(passChance(-100) < passChance(0) && passChance(0) < passChance(100));
});

test("drift: together 14 nights in a row gains exactly +6; then 56 nights apart moves 8 back toward the seed", () => {
  const pair = pairKey("Clint", "Emily"); // seed 30, canon-2.md PAIR TABLE
  const together = (n: number) => ({ ...night(dayAt(n), [["Clint", "Emily"]]) });
  let town = emptyTown();
  for (let n = 0; n < 14; n++) town = applyNight(town, together(n), never);
  assert.equal(town.relationships[pair], 30 + 6);
  assert.deepEqual(town.lastNightLog!.changes, [], "the 14th night is over the 3-per-7-nights cap");

  // With a planner shift on top, the pair sits 16 over its seed, so 56 nights apart shows all 8 moves.
  town = emptyTown();
  for (let n = 0; n < 14; n++) town = applyNight(town, together(n), never, n === 0 ? [{ a: "Clint", b: "Emily", delta: 10, reason: "x" }] : []);
  assert.equal(town.relationships[pair], 46);
  for (let n = 14; n < 13 + 56; n++) town = applyNight(town, night(dayAt(n), []), never);
  assert.equal(town.relationships[pair], 46 - 7, "55 nights apart: 7 weeks");
  town = applyNight(town, night(dayAt(13 + 56), []), never);
  assert.equal(town.relationships[pair], 46 - 8, "56 nights apart: 8 weeks");
  assert.deepEqual(town.lastNightLog!.changes, [{ a: "Clint", b: "Emily", from: 39, to: 38, why: ["apart"] }]);

  // Nearer the seed than 8, it stops at the seed.
  town = emptyTown();
  for (let n = 0; n < 14; n++) town = applyNight(town, together(n), never);
  for (let n = 14; n < 14 + 70; n++) town = applyNight(town, night(dayAt(n), []), never);
  assert.equal(town.relationships[pair], 30);
});

test("facts carry the farmer they are about; the prompt says 'about you' only to that farmer", () => {
  // DayEvent.farmerId arrives with slice A's protocol change; until then it is added past the type.
  const gift: PendingDay["events"][number] = { type: "gift", npc: "Emily", location: "Saloon", time: 1200, witnesses: [], item: "Amethyst" };
  const withFarmer = { ...gift, farmerId: "111" };
  assert.deepEqual(factsFromDay({ ...night(spring1, []), events: [withFarmer] })[0]!.about, ["111"]);
  assert.deepEqual(factsFromDay({ ...night(spring1, []), events: [gift] })[0]!.about, [MAIN_FARMER]);

  const town: TownState = { ...emptyTown(), facts: [newFact("f", ref(spring1), "Ana gave Emily an Amethyst.", true, { Emily: { kind: "told" } }, ["111"])] };
  const passed = gossipNight(town, ref(spring1), [["Emily", "Haley"]], always).town;
  const names = { "111": "Ana", "222": "Bo" };
  const forB = knownFactLines(passed, "Haley", { farmerId: "222", names });
  assert.equal(forB.length, 1);
  assert.match(forB[0]!, /about Ana/);
  assert.doesNotMatch(forB[0]!, /about you/);
  assert.match(knownFactLines(passed, "Haley", { farmerId: "111", names })[0]!, /about you/);
  assert.doesNotMatch(knownFactLines(passed, "Haley")[0]!, /about/, "no farmer view, no label (talk.ts until slice A/E wires it)");
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
  for (const npc of CAST.filter((n) => n !== "Emily")) assert.doesNotMatch(knowledgeBlock(npc, {}, town, []), /CANARY-123/, npc);
  // Emily's prompt shows only her MAX_PROMPT_FACTS newest facts, so after 112 days of news the
  // confidence has aged out of her prompt. It is still in her state (checked above).
});

test("a confidence is labelled in the teller's own prompt so the model does not repeat it", () => {
  assert.match(knowledgeBlock("Emily", {}, canaryTown(false), []), /CANARY-123.*in confidence; do not repeat it/);
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

test("NPC relationships: every roster pair has a starting score, stored with the town state", async () => {
  const rel = seedRelationships();
  const store = await tempStore();
  await store.stage({ v: 1, ...night(spring1, []) });
  await store.commit(SAVE, ref(spring1));
  const onDisk = JSON.parse(await readFile(join(store.dir, SAVE, "_town.json"), "utf8")) as TownState;
  assert.deepEqual(onDisk.relationships, rel);
});
