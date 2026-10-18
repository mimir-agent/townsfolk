// Slice A (spec v2): per-farmer memory and protocol. Every request and response here goes through
// helpers.ts, so each one is also checked against protocol/*.schema.json.

import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_ENTRIES, sectionBudget, sectionBytes, type NpcMemory, type NpcMemoryV2 } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { MAIN_FARMER, SEASONS, type DayEndRequest, type DayEvent, type DayRef, type GameDay } from "../src/protocol.ts";
import { OTHER_FARMER_SUMMARY, otherFarmerLine } from "../src/talk.ts";
import { schema, talkReq, tempStore, withServer } from "./helpers.ts";
import { GOOD_SCHEDULES, WORLD, npcsEntry, planReq, reply, spring } from "./plan-fixtures.ts";

const SAVE = "Farm_123";
const A = { farmerId: "111", farmerName: "Ash" };
const B = { farmerId: "222", farmerName: "Bea" };
const evening = (d: DayRef): GameDay => ({ ...d, time: 2200, weather: "sunny", location: "Town" });

function dayEnd(d: DayRef, events: DayEvent[], playerName = "Ash"): DayEndRequest {
  return { v: 1, saveId: SAVE, playerName, day: evening(d), events };
}

test("done-when 1: farmers A and B both talk with Abigail on one day; her file has two sections; B's prompt has B's lines, none of A's, and one line naming A", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const events: DayEvent[] = [
      { type: "talk", ...A, npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "ASH-LINE about the mines", playerChoice: "ASH-REPLY" },
      { type: "gift", ...A, npc: "Abigail", location: "Town", time: 1010, witnesses: [], item: "Amethyst", taste: "loved" },
      { type: "talk", ...B, npc: "Abigail", location: "Mountain", time: 1500, witnesses: [], npcLine: "BEA-LINE about the lake", playerChoice: "BEA-REPLY" },
    ];
    assert.equal((await c.post("/v1/day-end", dayEnd(spring(5), events))).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(5) })).json.outcome, "committed");

    const file = JSON.parse(await readFile(join(c.store.dir, SAVE, "Abigail.json"), "utf8")) as NpcMemory;
    assert.equal(file.version, 3);
    assert.deepEqual(Object.keys(file.farmers).sort(), [A.farmerId, B.farmerId]);
    assert.equal(file.farmers[A.farmerId]!.farmerName, "Ash");
    assert.equal(file.farmers[A.farmerId]!.gifts, 1);
    assert.equal(file.farmers[B.farmerId]!.gifts, 0);
    assert.doesNotMatch(JSON.stringify(file.farmers[B.farmerId]), /ASH|Amethyst/);
    assert.doesNotMatch(JSON.stringify(file.farmers[A.farmerId]), /BEA/);

    await c.post("/v1/talk", talkReq({ ...B, playerName: "Bea", day: { ...evening(spring(6)), time: 1100 } }));
    const prompt = model.calls.at(-1)!.user;
    assert.match(prompt, /BEA-LINE about the lake/);
    assert.match(prompt, /Bea answered: "BEA-REPLY"/);
    assert.match(prompt, /Talking with: Bea/);
    assert.doesNotMatch(prompt, /ASH-LINE|ASH-REPLY|Amethyst/);
    const aLines = prompt.split("\n").filter((l) => l.includes("Ash"));
    assert.equal(aLines.length, 1, `exactly one line names Ash:\n${aLines.join("\n")}`);
    assert.match(aLines[0]!, /^- Ash: 1 talk, last seen spring 5, year 1\.$/);
  });
});

test("done-when 2: a v2 memory file loads as farmers.main, moves to the host's id on a world request, and a talk from the host sees the old entries", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  const logs: string[] = [];
  await withServer(model, async (c) => {
    const v2: NpcMemoryV2 = {
      version: 2,
      npc: "Abigail",
      firstMet: "spring 2, year 1",
      talks: 3,
      gifts: 1,
      years: "",
      seasons: [],
      entries: [{ day: spring(3), text: "At Town, 10:00am, I said: \"OLD-V2-ENTRY\"." }],
    };
    await mkdir(join(c.store.dir, SAVE), { recursive: true });
    await writeFile(join(c.store.dir, SAVE, "Abigail.json"), JSON.stringify(v2));

    const loaded = await c.store.load(SAVE, "Abigail");
    assert.equal(loaded.version, 3);
    assert.deepEqual(Object.keys(loaded.farmers), [MAIN_FARMER]);
    assert.equal(loaded.farmers[MAIN_FARMER]!.talks, 3);
    assert.match(loaded.farmers[MAIN_FARMER]!.entries[0]!.text, /OLD-V2-ENTRY/);

    assert.equal((await c.post("/v1/world", { ...WORLD, hostFarmerId: "123" })).status, 200);
    const file = JSON.parse(await readFile(join(c.store.dir, SAVE, "Abigail.json"), "utf8")) as NpcMemory;
    assert.equal(file.version, 3);
    assert.deepEqual(Object.keys(file.farmers), ["123"]);
    assert.match(file.farmers["123"]!.entries[0]!.text, /OLD-V2-ENTRY/);
    assert.ok(logs.some((l) => /moved single-player memory to the host for Abigail/.test(l)), logs.join("\n"));

    // The host talks with its farmerId and sees its old history.
    await c.post("/v1/talk", talkReq({ farmerId: "123", farmerName: "Tae" }));
    assert.match(model.calls.at(-1)!.user, /OLD-V2-ENTRY/);
    assert.match(model.calls.at(-1)!.user, /First met Tae: spring 2, year 1. Talks so far: 3/);
    // A request without farmerId is the host's from now on, so it sees the same history.
    await c.post("/v1/talk", talkReq());
    assert.match(model.calls.at(-1)!.user, /OLD-V2-ENTRY/);

    // A day without farmerId after the move lands in the host's section, not a new main one.
    await c.post("/v1/day-end", dayEnd(spring(5), [{ type: "talk", npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "NEW-HOST-DAY" }], "Tae"));
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(5) });
    const after = await c.store.load(SAVE, "Abigail");
    assert.deepEqual(Object.keys(after.farmers), ["123"]);
    assert.equal(after.farmers["123"]!.entries.length, 2);

    // A second world request with the same host changes nothing.
    assert.equal((await c.post("/v1/world", { ...WORLD, hostFarmerId: "123" })).status, 200);
    assert.deepEqual(await c.store.load(SAVE, "Abigail"), after);
  }, (m) => logs.push(m));
});

test("done-when 3: 4 farmers x 224 committed days for one NPC: file at most 64 KB, every section at most 16 KB, a season summary per season in each", async () => {
  const store = await tempStore();
  const farmers = ["1", "2", "3", "4"].map((id) => ({ farmerId: id, farmerName: `Farmer${id}` }));
  assert.equal(sectionBudget(4), 16 * 1024);
  const seasonsSeen: string[] = [];
  let maxFile = 0;
  for (let i = 0; i < 224; i++) {
    const d: DayRef = { season: SEASONS[Math.floor(i / 28) % 4]!, day: (i % 28) + 1, year: 1 + Math.floor(i / 112) };
    const label = `${d.season} ${d.year}`;
    if (!seasonsSeen.includes(label)) seasonsSeen.push(label);
    // The same heavy, two-byte days as the single-player budget test, once per farmer.
    const events: DayEvent[] = farmers.flatMap((f): DayEvent[] => [
      ...[900, 1300, 1700].map(
        (time, k): DayEvent => ({ type: "talk", ...f, npc: "Lewis", location: "Town", time, witnesses: ["Pierre"], npcLine: `Day ${i} talk ${k} with ${f.farmerName}: "the café" ${"é".repeat(150)}`, playerChoice: `Reply ${k} ${"x".repeat(150)}` }),
      ),
      { type: "gift", ...f, npc: "Lewis", location: "ManorHouse", time: 1500, witnesses: [], item: "Hot Pepper", taste: "liked" },
    ]);
    await store.stage(dayEnd(d, events));
    assert.equal((await store.commit(SAVE, d)).outcome, "committed");
    const bytes = (await stat(join(store.dir, SAVE, "Lewis.json"))).size;
    maxFile = Math.max(maxFile, bytes);
    assert.ok(bytes <= 64 * 1024, `day ${i}: Lewis.json is ${bytes} bytes`);
  }
  const mem = await store.load(SAVE, "Lewis");
  assert.deepEqual(Object.keys(mem.farmers).sort(), ["1", "2", "3", "4"]);
  assert.equal(seasonsSeen.length, 8);
  for (const f of farmers) {
    const sec = mem.farmers[f.farmerId]!;
    const bytes = sectionBytes(mem, f.farmerId);
    assert.ok(bytes <= 16 * 1024, `${f.farmerName} section is ${bytes} bytes`);
    assert.deepEqual(sec.seasons.map((s) => `${s.season} ${s.year}`), seasonsSeen, f.farmerName);
    for (const s of sec.seasons) assert.ok(s.text.length > 0, `${f.farmerName}: empty summary for ${s.season} ${s.year}`);
    assert.ok(sec.entries.length > 0 && sec.entries.length <= MAX_ENTRIES, `${f.farmerName} entries ${sec.entries.length}`);
    assert.equal(sec.talks, 224 * 3);
    assert.equal(sec.gifts, 224);
    // Each section holds only its own farmer's lines.
    for (const other of farmers.filter((o) => o !== f)) assert.doesNotMatch(JSON.stringify(sec), new RegExp(`with ${other.farmerName}:`));
  }
  assert.ok(maxFile > 48 * 1024, `test is meaningful only if the file nears its budget: max ${maxFile}`);
});

test("done-when 4: a plan friendship shift for an unknown farmerId is dropped with a logged reason; one for a known farmer passes", async () => {
  const friendship = [
    { npc: "Emily", delta: 20, reason: "the farmhand brought her a crystal", farmerId: "456" },
    { npc: "Shane", delta: -10, reason: "a farmer who is not here", farmerId: "999" },
    { npc: "Emily", delta: 5, reason: "the host waved hello" },
  ];
  const logs: string[] = [];
  await withServer(fakeAdapter([reply({ npcs: npcsEntry(GOOD_SCHEDULES), friendship })]), async (c) => {
    assert.equal((await c.post("/v1/world", { ...WORLD, hostFarmerId: "123" })).status, 200);
    const farmers = [
      { farmerId: "123", farmerName: "Tae", hearts: { Emily: 2 } },
      { farmerId: "456", farmerName: "Bria", hearts: { Emily: 5 } },
    ];
    const res = await c.post("/v1/plan", { ...planReq(spring(6)), farmers });
    assert.equal(res.status, 200);
    // Kept shifts come per farmer, in the order each farmer first appears in the model's reply.
    assert.deepEqual(res.json.friendship, [
      { npc: "Emily", delta: 20, reason: "the farmhand brought her a crystal", farmerId: "456" },
      { npc: "Emily", delta: 5, reason: "the host waved hello" },
    ]);
    assert.deepEqual(res.json.dropped, [{ part: "friendship Shane", reason: "farmerId \"999\" is not one of tonight's farmers" }]);
    assert.ok(logs.some((l) => /dropped friendship Shane: farmerId "999" is not one of tonight's farmers/.test(l)), logs.join("\n"));
  }, (m) => logs.push(m));
});

test("plan: a shift naming the host's own farmerId is the host's; the plan prompt names the other farmers only in multiplayer", async () => {
  const model = fakeAdapter([reply({ friendship: [{ npc: "Emily", delta: 5, reason: "the host waved hello", farmerId: "123" }] })]);
  await withServer(model, async (c) => {
    assert.equal((await c.post("/v1/world", { ...WORLD, hostFarmerId: "123" })).status, 200);
    const res = await c.post("/v1/plan", { ...planReq(spring(6)), farmers: [{ farmerId: "123", farmerName: "Tae", hearts: {} }, { farmerId: "456", farmerName: "Bria", hearts: {} }] });
    assert.deepEqual(res.json.friendship, [{ npc: "Emily", delta: 5, reason: "the host waved hello" }]);
    assert.match(model.calls[0]!.user, /Other farmers in town .*: Bria = 456\./);
    assert.doesNotMatch(model.calls[0]!.user, /Tae = 123/);
  });
  const single = fakeAdapter([reply()]);
  await withServer(single, async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.equal((await c.post("/v1/plan", planReq(spring(6)))).status, 200);
    assert.doesNotMatch(single.calls[0]!.user, /Other farmers in town/);
  });
});

test("another farmer's line carries name, talks, last day and at most 150 chars of the latest season summary, never entries", () => {
  const summary = `${"s".repeat(OTHER_FARMER_SUMMARY)}TAIL-NOT-SHOWN`;
  const line = otherFarmerLine({
    farmerName: "Ash",
    firstMet: "spring 1, year 1",
    talks: 7,
    gifts: 2,
    years: "YEARS-NOT-SHOWN",
    seasons: [{ season: "spring", year: 1, text: summary }],
    entries: [{ day: spring(20), text: "ENTRY-NOT-SHOWN" }],
  });
  assert.equal(line, `- Ash: 7 talks, last seen spring 20, year 1. Latest season: ${"s".repeat(OTHER_FARMER_SUMMARY)}`);
});

test("protocol: farmerId and farmerName come together, farmerId is decimal, and the schemas agree", async () => {
  const base = { v: 1, saveId: SAVE, playerName: "Ash", day: evening(spring(5)) };
  const event = { type: "gift", npc: "Emily", location: "SeedShop", time: 1030, witnesses: [], item: "Amethyst" };
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const bad: [string, unknown][] = [
      ["/v1/talk", { ...talkReq(), farmerId: "111" }],
      ["/v1/talk", { ...talkReq(), farmerName: "Ash" }],
      ["/v1/talk", { ...talkReq(), farmerId: "12a", farmerName: "Ash" }],
      ["/v1/day-end", { ...base, events: [{ ...event, farmerId: "111" }] }],
      ["/v1/world", { ...WORLD, hostFarmerId: "host" }],
      ["/v1/plan", { ...planReq(spring(6)), farmers: [{ farmerId: "1", farmerName: "A", hearts: {} }, { farmerId: "1", farmerName: "B", hearts: {} }] }],
    ];
    for (const [path, body] of bad) assert.equal((await c.postRaw(path, body)).status, 400, `${path} ${JSON.stringify(body)}`);
    assert.equal((await c.post("/v1/day-end", { ...base, events: [{ ...event, ...A }] })).status, 200);
    assert.equal((await c.post("/v1/talk", talkReq({ ...A, playerName: "Ash" }))).status, 200);
  });
  assert.equal(schema("talk-request")({ ...talkReq(), farmerId: "111" }), false);
  assert.equal(schema("talk-request")({ ...talkReq(), farmerId: "x1", farmerName: "Ash" }), false);
  assert.equal(schema("day-end-request")({ ...base, events: [{ ...event, farmerName: "Ash" }] }), false);
  assert.equal(schema("world-request")({ ...WORLD, hostFarmerId: "host" }), false);
  assert.equal(schema("plan-request")({ ...planReq(spring(6)), farmers: [{ farmerId: "1", farmerName: "A" }] }), false);
  assert.equal(schema("plan-response")({ v: 1, day: spring(6), source: "model", schedules: [], goals: [], happening: null, quest: null, friendship: [{ npc: "Emily", delta: 5, reason: "x", farmerId: "me" }], relationships: [], dropped: [] }), false);
});

test("a world request without hostFarmerId leaves the single-player section where it is", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    await c.post("/v1/day-end", dayEnd(spring(5), [{ type: "talk", npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "hi" }], "Tae"));
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(5) });
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.deepEqual(Object.keys((await c.store.load(SAVE, "Abigail")).farmers), [MAIN_FARMER]);
  });
});
