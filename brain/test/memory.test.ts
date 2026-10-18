// Slice 1: witnessed memory, save-safe commit, tiered bounded memory.

import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { applyDay, emptyMemory, fileBytes, MAX_ENTRIES, MAX_FILE_BYTES, shareByNpc, type NpcMemoryV1 } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { SEASONS, type DayEndRequest, type DayEvent, type DayRef, type GameDay } from "../src/protocol.ts";
import { NO_CONTEXT, talk } from "../src/talk.ts";
import { emptyTown } from "../src/town.ts";
import { talkReq, tempStore, withServer } from "./helpers.ts";

const SAVE = "Farm_123";
const spring5: GameDay = { season: "spring", day: 5, year: 1, time: 2400, weather: "sunny", location: "FarmHouse" };
const ref = (d: GameDay): DayRef => ({ season: d.season, day: d.day, year: d.year });

function dayEnd(d: GameDay, events: DayEvent[]): DayEndRequest {
  return { v: 1, saveId: SAVE, playerName: "Tae", day: d, events };
}

const giftToEmily: DayEvent = {
  type: "gift",
  npc: "Emily",
  location: "SeedShop",
  time: 1030,
  witnesses: ["Pierre"],
  item: "Amethyst",
  taste: "loved",
};

async function memoryText(dir: string, npc: string): Promise<string | null> {
  try {
    return await readFile(join(dir, SAVE, `${npc}.json`), "utf8");
  } catch {
    return null;
  }
}

test("done-when 1: Pierre witnesses a gift to Emily, Shane is elsewhere; after saved, Pierre and Emily remember, Shane does not", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const shaneElsewhere: DayEvent = { type: "talk", npc: "Shane", location: "Saloon", time: 2000, witnesses: ["Gus"], npcLine: "Long day.", playerChoice: "Same here." };
    const end = await c.post("/v1/day-end", dayEnd(spring5, [giftToEmily, shaneElsewhere]));
    assert.equal(end.status, 200);
    assert.deepEqual(end.json.pending.sort(), ["Emily", "Gus", "Pierre", "Shane"]);

    // Nothing is in memory before the save finishes.
    assert.equal(await memoryText(c.store.dir, "Emily"), null);
    assert.equal(await memoryText(c.store.dir, "Pierre"), null);

    const saved = await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(spring5) });
    assert.equal(saved.json.outcome, "committed");

    const emily = await memoryText(c.store.dir, "Emily");
    const pierre = await memoryText(c.store.dir, "Pierre");
    const shane = await memoryText(c.store.dir, "Shane");
    assert.match(emily ?? "", /Tae gave me Amethyst \(loved\) at SeedShop/);
    assert.match(pierre ?? "", /I saw Tae give Emily Amethyst at SeedShop/);
    // A witness sees the gift, not how the receiver felt about it.
    assert.doesNotMatch(pierre ?? "", /loved/);
    assert.ok(shane !== null, "Shane has his own memory of the Saloon talk");
    assert.doesNotMatch(shane, /Amethyst|Emily/);

    // Witnessing is not meeting: Pierre has not spoken with the player yet.
    const pierreMem = await c.store.load(SAVE, "Pierre");
    assert.equal(pierreMem.firstMet, null);
    assert.equal(pierreMem.gifts, 0);
    const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
    await talk(talkReq({ npc: "Pierre" }), pierreMem, emptyTown(), NO_CONTEXT, model, { deadlineMs: 5000, log: () => {} });
    assert.match(model.calls[0]!.user, /never spoken with Tae/);
    assert.match(model.calls[0]!.user, /I saw Tae give Emily Amethyst/);
  });
});

test("done-when 2: a day-end with no saved, then a new day-end for the same date; only the second is committed", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const unsaved: DayEvent = { type: "talk", npc: "Abigail", location: "Town", time: 1100, witnesses: [], npcLine: "UNSAVED-LINE", playerChoice: "ok" };
    const replayed: DayEvent = { type: "talk", npc: "Abigail", location: "Town", time: 1200, witnesses: [], npcLine: "REPLAYED-LINE", playerChoice: "ok" };

    await c.post("/v1/day-end", dayEnd(spring5, [unsaved]));
    // The player quits without saving, reloads the morning of spring 5 and plays it again.
    await c.post("/v1/day-end", dayEnd(spring5, [replayed]));
    const saved = await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(spring5) });
    assert.deepEqual(saved.json.committed, ["Abigail"]);

    const abigail = await c.store.load(SAVE, "Abigail");
    assert.equal(abigail.entries.length, 1);
    assert.equal(abigail.talks, 1);
    assert.match(abigail.entries[0]!.text, /REPLAYED-LINE/);
    assert.doesNotMatch(JSON.stringify(abigail), /UNSAVED-LINE/);

    // A second saved for the same day finds nothing pending and changes nothing.
    const again = await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(spring5) });
    assert.equal(again.json.outcome, "nothing-pending");
    assert.equal((await c.store.load(SAVE, "Abigail")).entries.length, 1);
  });
});

test("a saved call for a different date discards the pending day instead of committing it", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    await c.post("/v1/day-end", dayEnd(spring5, [giftToEmily]));
    const saved = await c.post("/v1/saved", { v: 1, saveId: SAVE, day: { season: "spring", day: 6, year: 1 } });
    assert.deepEqual(saved.json, { v: 1, ok: true, outcome: "stale-discarded", committed: [] });
    assert.equal(await memoryText(c.store.dir, "Emily"), null);
    assert.equal(await c.store.pending(SAVE), null);
  });
});

test("done-when 3: 224 committed days for one NPC; the file never exceeds 32 KB and keeps a summary for each season", async () => {
  const store = await tempStore();
  const seasonsSeen = new Set<string>();
  let maxBytes = 0;
  for (let i = 0; i < 224; i++) {
    const season = SEASONS[Math.floor(i / 28) % 4]!;
    const year = 1 + Math.floor(i / 112);
    const d: GameDay = { season, day: (i % 28) + 1, year, time: 2400, weather: "sunny", location: "FarmHouse" };
    seasonsSeen.add(`${season} ${year}`);
    // Heavy days: several long talks, a gift, and quotes and non-ASCII to stress bytes vs chars.
    const events: DayEvent[] = [
      ...[900, 1300, 1700].map(
        (time, k): DayEvent => ({ type: "talk", npc: "Lewis", location: "Town", time, witnesses: ["Pierre"], npcLine: `Day ${i} talk ${k}: "the café" ${"é".repeat(150)}`, playerChoice: `Reply ${k} ${"x".repeat(150)}` }),
      ),
      { type: "gift", npc: "Lewis", location: "ManorHouse", time: 1500, witnesses: [], item: "Hot Pepper", taste: "liked" },
    ];
    await store.stage(dayEnd(d, events));
    const r = await store.commit(SAVE, ref(d));
    assert.equal(r.outcome, "committed");
    const bytes = (await stat(join(store.dir, SAVE, "Lewis.json"))).size;
    maxBytes = Math.max(maxBytes, bytes);
    assert.ok(bytes <= MAX_FILE_BYTES, `day ${i}: Lewis.json is ${bytes} bytes`);
  }
  const mem = await store.load(SAVE, "Lewis");
  // These days are heavy and two-byte, so the byte guard rolls a raw day or two early.
  assert.ok(mem.entries.length >= MAX_ENTRIES - 3 && mem.entries.length <= MAX_ENTRIES, `entries ${mem.entries.length}`);
  assert.equal(mem.talks, 224 * 3);
  assert.equal(mem.gifts, 224);
  assert.equal(mem.firstMet, "spring 1, year 1");
  // 224 days are 8 seasons, and each one has its own season summary (the last 14 days are
  // also still raw, but winter of year 2 began rolling into its summary on its 15th day).
  const summarized = mem.seasons.map((s) => `${s.season} ${s.year}`);
  assert.equal(seasonsSeen.size, 8);
  assert.deepEqual(summarized, [...seasonsSeen]);
  for (const s of mem.seasons) assert.ok(s.text.length > 0, `empty summary for ${s.season} ${s.year}`);
  assert.ok(maxBytes > 8 * 1024, `test is meaningful only if files grow: max ${maxBytes}`);
});

test("memory tiers: days roll into season summaries, the oldest seasons fold into the years summary", () => {
  let mem = emptyMemory("Gus");
  for (let i = 0; i < 112 * 3; i++) {
    const d: DayRef = { season: SEASONS[Math.floor(i / 28) % 4]!, day: (i % 28) + 1, year: 1 + Math.floor(i / 112) };
    mem = applyDay(mem, d, [{ event: { type: "talk", npc: "Gus", location: "Saloon", time: 1900, witnesses: [], npcLine: `Night ${i}.` }, role: "participant" }], "Tae");
  }
  assert.equal(mem.entries.length, MAX_ENTRIES);
  // Three years: the last 8 seasons keep their own summary, year 1 lives in the years summary.
  assert.deepEqual(mem.seasons.map((s) => `${s.season} ${s.year}`), [
    "spring 2", "summer 2", "fall 2", "winter 2", "spring 3", "summer 3", "fall 3", "winter 3",
  ]);
  for (const s of SEASONS) assert.match(mem.years, new RegExp(`${s} year 1:`));
  assert.ok(mem.years.length <= 1000);
  assert.ok(fileBytes(mem) < MAX_FILE_BYTES);
});

test("a witness who saw several turns of one conversation remembers it once", () => {
  const turns: DayEvent[] = [1000, 1001, 1002].map((time) => ({ type: "talk", npc: "Haley", location: "Town", time, witnesses: ["Emily"], npcLine: `turn ${time}` }));
  const share = shareByNpc(turns);
  assert.equal(share.get("Haley")!.length, 3);
  const emily = applyDay(emptyMemory("Emily"), { season: "spring", day: 1, year: 1 }, share.get("Emily")!, "Tae");
  assert.equal(emily.entries[0]!.text.match(/I saw Tae talking with Haley/g)!.length, 1);
  assert.doesNotMatch(emily.entries[0]!.text, /turn 1000/);
});

test("a v1 memory file from the tonight slice is read and kept", async () => {
  const store = await tempStore();
  const v1: NpcMemoryV1 = {
    version: 1,
    npc: "Abigail",
    firstMet: "spring 3, year 1",
    talks: 2,
    gifts: 1,
    summary: "spring 1, year 1: OLD-SUMMARY.",
    entries: [{ date: "spring 3, year 1", text: "At Town, 10:00am, I said: \"V1-ENTRY\"." }],
  };
  await mkdir(join(store.dir, SAVE), { recursive: true });
  await writeFile(join(store.dir, SAVE, "Abigail.json"), JSON.stringify(v1));
  const mem = await store.load(SAVE, "Abigail");
  assert.equal(mem.version, 2);
  assert.equal(mem.talks, 2);
  assert.deepEqual(mem.entries[0]!.day, { season: "spring", day: 3, year: 1 });
  assert.match(mem.years, /OLD-SUMMARY/);

  await store.stage(dayEnd(spring5, [giftToEmily, { type: "talk", npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "NEW" }]));
  await store.commit(SAVE, ref(spring5));
  const after = await store.load(SAVE, "Abigail");
  assert.equal(after.entries.length, 2);
  assert.equal(after.talks, 3);
  assert.deepEqual((await readdir(join(store.dir, SAVE))).sort(), ["Abigail.json", "Emily.json", "Pierre.json", "_town.json"]);
});

test("a vanilla chat (the game's own dialogue) is remembered as a meeting, counts as a talk, and leaves no game words", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const met: DayEvent = { type: "chat", npc: "Shane", location: "AnimalShop", time: 900, witnesses: ["Marnie"], reason: "first-meeting" };
    assert.equal((await c.post("/v1/day-end", dayEnd(spring5, [met]))).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: ref(spring5) })).json.outcome, "committed");
    const shane = await c.store.load(SAVE, "Shane");
    assert.equal(shane.firstMet, "spring 5, year 1");
    assert.equal(shane.talks, 1);
    assert.match(shane.entries[0]!.text, /Tae and I met for the first time at AnimalShop, 9:00am/);
    const marnie = await c.store.load(SAVE, "Marnie");
    assert.match(marnie.entries[0]!.text, /I saw Tae talking with Shane at AnimalShop/);
    assert.equal(marnie.firstMet, null);
    // The next talk prompt no longer treats the farmer as a stranger.
    const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
    await talk(talkReq({ npc: "Shane" }), shane, emptyTown(), NO_CONTEXT, model, { deadlineMs: 5000, log: () => {} });
    assert.match(model.calls[0]!.user, /First met Tae: spring 5, year 1/);
  });
});

test("a chat with an unknown reason is refused", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const bad = { type: "chat", npc: "Shane", location: "Town", time: 900, witnesses: [], reason: "small-talk" };
    const res = await c.postRaw("/v1/day-end", dayEnd(spring5, [bad as unknown as DayEvent]));
    assert.equal(res.status, 400);
    assert.match(res.json.error, /reason must be one of first-meeting, quest, birthday, story/);
  });
});
