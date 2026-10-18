// Slice E (spec v2): the game's own scenes reach every actor's memory, from its own side, in the
// watching farmer's section, and one town fact that only the actors saw. Requests and responses
// go through helpers.ts, so each is also checked against protocol/*.schema.json.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDay, emptyMemory, fileBudget, fileBytes, MAX_ENTRIES, PRIVATE_MARK, sectionFor, shareByNpc, type NpcMemory } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { MAIN_FARMER, SEASONS, type DayEvent, type DayRef, type GameDay, type SceneEvent } from "../src/protocol.ts";
import { isPrivateScene, sceneLine } from "../src/scenes.ts";
import { STORY } from "../src/story.ts";
import { emptyTown, factsFromDay, newFact, renameFarmer } from "../src/town.ts";
import { talkReq, tempStore, withServer } from "./helpers.ts";
import { WORLD } from "./plan-fixtures.ts";

const SAVE = "Farm_123";
const A = { farmerId: "111", farmerName: "Ash" };
const B = { farmerId: "222", farmerName: "Bea" };
// Shane's seven-heart scene at Marnie's (public in events.md); his four-heart one is private.
const PUBLIC_ID = "3910974";
const PRIVATE_ID = "3910674";

function dayAt(n: number): GameDay {
  return { season: SEASONS[Math.floor(n / 28) % 4]!, day: (n % 28) + 1, year: Math.floor(n / 112) + 1, time: 2200, weather: "sunny", location: "Town" };
}
const ref = (d: DayRef): DayRef => ({ season: d.season, day: d.day, year: d.year });

function scene(eventId: string, actors: string[], over: Partial<SceneEvent> = {}): SceneEvent {
  return { type: "scene", ...A, eventId, festival: false, npc: actors[0]!, witnesses: actors.slice(1), location: "AnimalShop", time: 1200, ...over };
}

function dayEnd(d: GameDay, events: DayEvent[], together: string[][] = []) {
  return { v: 1 as const, saveId: SAVE, playerName: "Ash", day: d, events, together: together.map((npcs) => ({ location: "Town", npcs })) };
}

const entriesText = (m: NpcMemory, key: string) => sectionFor(m, key).entries.map((e) => e.text).join(" ");

test("the id map is story.ts's, extended with private flags only; the two test scenes are what events.md says", () => {
  assert.ok(STORY.some((e) => e.ids.includes(PUBLIC_ID)), "public test scene is in story.ts");
  assert.equal(isPrivateScene(PUBLIC_ID), false);
  assert.equal(isPrivateScene(PRIVATE_ID), true);
  assert.equal(isPrivateScene("60367"), false, "an id events.md does not list is not private");
});

test("done-when 1: a mapped scene with Shane and Marnie for farmer A: after /v1/saved each holds its own line in A's section, Emily nothing, and the fact's knowers are exactly Shane and Marnie with source saw", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const d = dayAt(4);
    assert.equal((await c.post("/v1/day-end", dayEnd(d, [scene(PUBLIC_ID, ["Shane", "Marnie"])]))).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(d) })).json.outcome, "committed");

    const shane = await c.store.load(SAVE, "Shane");
    const marnie = await c.store.load(SAVE, "Marnie");
    assert.deepEqual(Object.keys(shane.farmers), [A.farmerId]);
    assert.deepEqual(Object.keys(marnie.farmers), [A.farmerId]);
    const shaneView = STORY.find((e) => e.ids.includes(PUBLIC_ID))!.views.Shane!.replace(/\b[Tt]he farmer\b/g, "Ash");
    assert.equal(entriesText(shane, A.farmerId), shaneView, "Shane's own view from the id map, naming the farmer");
    assert.equal(entriesText(marnie, A.farmerId), "I was part of something at the AnimalShop with Shane while Ash watched.");
    assert.equal(sectionFor(shane, A.farmerId).firstMet, null, "being in a scene is not meeting the farmer");
    assert.equal(sectionFor(shane, A.farmerId).talks, 0);

    const emily = await c.store.load(SAVE, "Emily");
    assert.deepEqual(emily.farmers, {});

    const town = await c.store.loadTown(SAVE);
    assert.equal(town.facts.length, 1);
    const fact = town.facts[0]!;
    assert.deepEqual(Object.keys(fact.knowers).sort(), ["Marnie", "Shane"]);
    assert.ok(Object.values(fact.knowers).every((k) => k.source.kind === "saw"));
    assert.deepEqual(fact.about, [A.farmerId]);
    assert.equal(fact.shareable, true);
  });
});

test("done-when 2: in a 112-day seeded run a private scene never moves; a public one reaches Emily only as heard", async () => {
  const store = await tempStore();
  for (let n = 0; n < 112; n++) {
    const d = dayAt(n);
    const events: DayEvent[] = n === 0 ? [scene(PRIVATE_ID, ["Shane", "Marnie"]), scene(PUBLIC_ID, ["Shane", "Marnie"])] : [];
    // Shane and Marnie spend every day with Emily, so anything that can move, moves.
    await store.stage(dayEnd(d, events, [["Shane", "Marnie", "Emily"], ["Emily", "Haley", "Gus"]]));
    assert.equal((await store.commit(SAVE, ref(d))).outcome, "committed");
  }
  const town = await store.loadTown(SAVE);
  const scenes = town.facts.filter((f) => f.created.day === 1 && f.created.season === "spring" && f.created.year === 1);
  assert.equal(scenes.length, 2);
  const priv = scenes.find((f) => !f.shareable)!;
  const pub = scenes.find((f) => f.shareable)!;
  assert.deepEqual(Object.keys(priv.knowers).sort(), ["Marnie", "Shane"], "the private scene stayed with its actors");
  assert.ok(pub.knowers.Emily, "the public scene reached Emily");
  assert.equal(pub.knowers.Emily.source.kind, "heard");
  for (const [npc, k] of Object.entries(pub.knowers)) {
    assert.equal(k.source.kind, ["Shane", "Marnie"].includes(npc) ? "saw" : "heard", npc);
  }
  // Gossip lives in town facts only: Emily's own memory never gets the scene.
  assert.doesNotMatch(JSON.stringify(await store.load(SAVE, "Emily")), /AnimalShop|Ash watched/);
});

test("done-when 3a: an unknown event id gets the generic line, built from the actors and the location", () => {
  const e = scene("60367", ["Pierre", "Abigail", "Caroline"], { location: "SeedShop" });
  assert.equal(sceneLine(e, "Abigail", "Ash"), "I was part of something at the SeedShop with Pierre and Caroline while Ash watched.");
  assert.equal(sceneLine(scene("60367", ["Linus"], { location: "Mountain" }), "Linus", "Ash"), "I was part of something at the Mountain while Ash watched.");
});

test("done-when 3b: a festival scene with 30 actors keeps every actor (at most 40), names the festival, and stays inside the memory budget", async () => {
  const thirty = ["Lewis", "Abigail", "Alex", "Caroline", "Clint", "Demetrius", "Elliott", "Emily", "Evelyn", "George", "Gus", "Haley", "Harvey", "Jas",
    "Jodi", "Leah", "Linus", "Marnie", "Maru", "Pam", "Penny", "Pierre", "Robin", "Sam", "Sebastian", "Shane", "Vincent", "Willy", "Kent", "Wizard"];
  assert.equal(thirty.length, 30);
  const egg = dayAt(12); // spring 13, the Egg Festival in the fixture calendar
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    const fest = scene("festival_spring13", thirty, { festival: true, location: "Town" });
    assert.equal((await c.post("/v1/day-end", dayEnd(egg, [fest]))).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(egg) })).json.outcome, "committed");
    for (const npc of thirty) {
      assert.equal(entriesText(await c.store.load(SAVE, npc), A.farmerId), "I was at the Egg Festival with Ash.", npc);
    }
    const fact = (await c.store.loadTown(SAVE)).facts[0]!;
    assert.equal(Object.keys(fact.knowers).length, 30);
    assert.match(fact.knowers.Lewis!.text, /^Ash was at the Egg Festival with Lewis, Abigail/);

    // 41 actors is over the protocol's witness cap: the whole day is refused, as for any event.
    const tooMany = scene("festival_spring13", [...thirty, ...Array.from({ length: 11 }, (_, i) => `Extra${i}`)], { festival: true });
    assert.equal(tooMany.witnesses.length, 40);
    assert.equal((await c.postRaw("/v1/day-end", dayEnd(egg, [{ ...tooMany, witnesses: [...tooMany.witnesses, "Extra99"] }]))).status, 400);
  });

  // A festival scene with 40 witnesses every day for two years never pushes a file past budget.
  const actors = [...thirty, ...Array.from({ length: 11 }, (_, i) => `Extra${i}`)];
  let mem = emptyMemory("Lewis");
  for (let n = 0; n < 224; n++) {
    const e = scene(`f${n}`, actors, { festival: true, location: "Town" });
    mem = applyDay(mem, ref(dayAt(n)), shareByNpc([e]).get("Lewis")!, "Ash", MAIN_FARMER, "Egg Festival");
  }
  assert.ok(fileBytes(mem) <= fileBudget(1), `${fileBytes(mem)} bytes`);
});

test("done-when 4: farmer B's talk prompt for Shane does not show A's private scene, and never as about you", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const d = dayAt(4);
    await c.post("/v1/day-end", dayEnd(d, [scene(PRIVATE_ID, ["Shane", "Marnie"])]));
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(d) });
    const aLine = entriesText(await c.store.load(SAVE, "Shane"), A.farmerId);
    assert.ok(aLine.startsWith(`${PRIVATE_MARK} `), aLine);

    await c.post("/v1/talk", talkReq({ npc: "Shane", ...B, playerName: "Bea", day: { ...dayAt(5), time: 1100 } }));
    const forB = model.calls.at(-1)!.user;
    assert.doesNotMatch(forB, /about you/);
    assert.ok(!forB.includes(aLine), "A's scene line is not in B's prompt");
    assert.ok(!forB.includes(PRIVATE_MARK));

    await c.post("/v1/talk", talkReq({ npc: "Shane", ...A, playerName: "Ash", day: { ...dayAt(5), time: 1200 } }));
    assert.ok(model.calls.at(-1)!.user.includes(aLine), "A's own prompt for Shane has it");
  });
});

test("a private scene keeps its mark after its day rolls out of the raw entries into the season summary", () => {
  let mem = emptyMemory("Shane");
  const e = scene(PRIVATE_ID, ["Shane", "Marnie"]);
  mem = applyDay(mem, ref(dayAt(0)), shareByNpc([e]).get("Shane")!, "Ash");
  const talk: DayEvent = { type: "talk", ...A, npc: "Shane", location: "Town", time: 1000, witnesses: [], npcLine: "Hey." };
  for (let n = 1; n <= MAX_ENTRIES; n++) mem = applyDay(mem, ref(dayAt(n)), shareByNpc([talk]).get("Shane")!, "Ash");
  const sec = sectionFor(mem, A.farmerId);
  assert.ok(!sec.entries.some((x) => x.text.includes(PRIVATE_MARK)), "the scene day has rolled out of entries");
  assert.ok(sec.seasons[0]!.text.startsWith(`1: ${PRIVATE_MARK}`), sec.seasons[0]!.text);
});

test("a heard scene fact about farmer A reads 'about Ash' in Emily's prompt for B and 'about you' for A", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    // Emily knows both farmers by name from a talk each; then she hears Shane's public scene.
    const d = dayAt(4);
    const talk = (f: typeof A, time: number): DayEvent => ({ type: "talk", ...f, npc: "Emily", location: "Town", time, witnesses: [], npcLine: "Hi." });
    await c.post("/v1/day-end", dayEnd(d, [talk(A, 900), talk(B, 1000)]));
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(d) });
    const town = await c.store.loadTown(SAVE);
    const fact = newFact("s", ref(d), "Ash saw something happen at the AnimalShop with Shane and Marnie.", true, { Emily: { kind: "heard", from: "Shane" } }, [A.farmerId]);
    await c.store.saveTown(SAVE, { ...town, facts: [...town.facts, fact] });

    await c.post("/v1/talk", talkReq({ npc: "Emily", ...B, playerName: "Bea", day: { ...dayAt(5), time: 1100 } }));
    const forB = model.calls.at(-1)!.user.split("\n").find((l) => l.includes("AnimalShop"))!;
    assert.match(forB, /heard from Shane.*about Ash/);
    assert.doesNotMatch(forB, /about you/);
    await c.post("/v1/talk", talkReq({ npc: "Emily", ...A, playerName: "Ash", day: { ...dayAt(5), time: 1200 } }));
    assert.match(model.calls.at(-1)!.user.split("\n").find((l) => l.includes("AnimalShop"))!, /about you/);
  });
});

test("a scene without farmerId lands in the host's section and its fact is about the host; naming the host moves old facts too", async () => {
  const store = await tempStore();
  await store.setHost(SAVE, "123");
  const d = dayAt(2);
  const { farmerId: _i, farmerName: _n, ...noFarmer } = scene(PUBLIC_ID, ["Shane", "Marnie"]);
  await store.stage(dayEnd(d, [noFarmer as SceneEvent]));
  await store.commit(SAVE, ref(d));
  assert.deepEqual(Object.keys((await store.load(SAVE, "Shane")).farmers), ["123"]);
  assert.deepEqual((await store.loadTown(SAVE)).facts[0]!.about, ["123"]);

  // A town written before the host was named holds facts about MAIN_FARMER; setHost moves them.
  const old = await tempStore();
  await old.saveTown(SAVE, { ...emptyTown(), facts: [newFact("f", ref(d), "Tae gave Emily a Daffodil.", true, { Emily: { kind: "saw" } })] });
  await old.setHost(SAVE, "123");
  assert.deepEqual((await old.loadTown(SAVE)).facts[0]!.about, ["123"]);
  const t = emptyTown();
  assert.equal(renameFarmer(t, MAIN_FARMER, "123"), t, "nothing to move, same town");
  assert.deepEqual(factsFromDay({ saveId: SAVE, playerName: "Tae", day: d, events: [noFarmer as SceneEvent] }, "123")[0]!.about, ["123"]);
});
