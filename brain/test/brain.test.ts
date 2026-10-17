import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyDay, emptyMemory, MAX_ENTRIES, MAX_SUMMARY, MemoryStore } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter, type ModelAdapter } from "../src/model.ts";
import type { DayEvent, GameDay, TalkRequest } from "../src/protocol.ts";
import { parseTalk } from "../src/protocol.ts";
import { createBrain } from "../src/server.ts";
import { MAX_TURNS, talk, validateReply } from "../src/talk.ts";

const day: GameDay = { season: "spring", day: 5, year: 1, time: 1130, weather: "sunny", location: "Town" };

function req(over: Partial<TalkRequest> = {}): TalkRequest {
  return {
    saveId: "Farm_123",
    npc: "Abigail",
    playerName: "Tae",
    day,
    friendship: { hearts: 2, points: 500 },
    transcript: [],
    ...over,
  };
}

const quiet = { deadlineMs: 5000, log: () => {} };

async function tempStore(): Promise<MemoryStore> {
  return new MemoryStore(await mkdtemp(join(tmpdir(), "townsfolk-test-")));
}

async function withServer(model: ModelAdapter, fn: (url: string, store: MemoryStore) => Promise<void>): Promise<void> {
  const store = await tempStore();
  const server = createBrain({ store, model, talkDeadlineMs: 5000, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`, store);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function post(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
}

test("valid model reply passes through with 3 choices", async () => {
  const r = await talk(req(), emptyMemory("Abigail"), fakeAdapter([DEFAULT_FAKE_REPLY]), quiet);
  assert.equal(r.source, "model");
  assert.equal(r.choices.length, 3);
  assert.deepEqual(r.choices.map((c) => c.id), ["a", "b", "c"]);
  assert.equal(r.end, false);
});

test("invalid reply is retried once, then the valid one is used", async () => {
  const model = fakeAdapter(["not json at all", DEFAULT_FAKE_REPLY]);
  const r = await talk(req(), emptyMemory("Abigail"), model, quiet);
  assert.equal(model.calls.length, 2);
  assert.equal(r.source, "model");
});

test("two failures fall back to a canned line that ends the conversation", async () => {
  const model = fakeAdapter(["THROW", '{"line":"hi","choices":[]}']);
  const r = await talk(req(), emptyMemory("Abigail"), model, quiet);
  assert.equal(model.calls.length, 2);
  assert.equal(r.source, "fallback");
  assert.equal(r.end, true);
  assert.deepEqual(r.choices, []);
});

test("validation enforces choice count, length caps and strips dialogue command characters", () => {
  assert.throws(() => validateReply(JSON.stringify({ line: "hi", choices: [{ text: "a" }, { text: "b" }] }), false));
  assert.throws(() => validateReply(JSON.stringify({ line: "x".repeat(300), choices: [] , end: true}), false));
  assert.throws(() =>
    validateReply(JSON.stringify({ line: "hi", choices: [{ text: "same" }, { text: "Same" }, { text: "other" }] }), false),
  );
  const ok = validateReply('Sure! ```json\n{"line":"Hey $h there#","choices":[{"text":"Hi"},{"text":"Yo"},{"text":"Hm"}]}\n```', false);
  assert.equal(ok.line, "Hey h there");
  assert.equal(ok.choices.length, 3);
});

test("the turn limit forces end=true and no choices", async () => {
  const transcript = [
    { speaker: "npc" as const, text: "1" },
    { speaker: "player" as const, text: "p1" },
    { speaker: "npc" as const, text: "2" },
    { speaker: "player" as const, text: "p2" },
    { speaker: "npc" as const, text: "3" },
  ];
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  const r = await talk(req({ transcript, recentChoice: { id: "a", text: "p3" } }), emptyMemory("Abigail"), model, quiet);
  assert.equal(MAX_TURNS, 3);
  assert.equal(r.end, true);
  assert.deepEqual(r.choices, []);
  assert.match(model.calls[0]!.user, /last turn/);
});

test("prompt carries only this NPC's own memory", async () => {
  const store = await tempStore();
  const events: DayEvent[] = [
    { type: "talk", npc: "Abigail", location: "Town", time: 1000, npcLine: "Abby secret line", playerChoice: "Abby reply" },
    { type: "talk", npc: "Pierre", location: "SeedShop", time: 1100, npcLine: "Pierre secret line", playerChoice: "Pierre reply" },
  ];
  await store.recordDay("Farm_123", day, events, "Tae");
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await talk(req({ npc: "Pierre" }), await store.load("Farm_123", "Pierre"), model, quiet);
  const prompt = model.calls[0]!.user;
  assert.match(prompt, /Pierre secret line/);
  assert.doesNotMatch(prompt, /Abby/);
});

test("memory files are per NPC and never contain another NPC's conversation", async () => {
  const store = await tempStore();
  await store.recordDay(
    "Farm_123",
    day,
    [
      { type: "talk", npc: "Abigail", location: "Town", time: 1000, npcLine: "ABBY-LINE", playerChoice: "ABBY-CHOICE" },
      { type: "gift", npc: "Shane", location: "Saloon", time: 1900, item: "Beer", taste: "loved" },
    ],
    "Tae",
  );
  const files = (await readdir(join(store.dir, "Farm_123"))).sort();
  assert.deepEqual(files, ["Abigail.json", "Shane.json"]);
  const shane = await readFile(join(store.dir, "Farm_123", "Shane.json"), "utf8");
  assert.doesNotMatch(shane, /ABBY/);
  assert.match(shane, /Tae gave me Beer \(loved\)/);
});

test("memory stays bounded over two simulated years of daily talks", async () => {
  let mem = emptyMemory("Lewis");
  for (let i = 0; i < 224; i++) {
    const d: GameDay = { ...day, season: ["spring", "summer", "fall", "winter"][Math.floor(i / 28) % 4]!, day: (i % 28) + 1, year: 1 + Math.floor(i / 112) };
    mem = applyDay(mem, d, [{ type: "talk", npc: "Lewis", location: "Town", time: 900, npcLine: `Line ${i} `.padEnd(200, "x"), playerChoice: "ok" }], "Tae");
  }
  assert.equal(mem.entries.length, MAX_ENTRIES);
  assert.ok(mem.summary.length <= MAX_SUMMARY, `summary ${mem.summary.length}`);
  assert.equal(mem.talks, 224);
  assert.equal(mem.firstMet, "spring 1, year 1");
  assert.ok(JSON.stringify(mem).length < 12_000);
});

test("HTTP: talk round trip, then day-end writes memory that the next day's talk sees", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (url, store) => {
    const first = await post(`${url}/v1/talk`, req());
    assert.equal(first.status, 200);
    assert.equal(first.json.choices.length, 3);

    const end = await post(`${url}/v1/day-end`, {
      saveId: "Farm_123",
      playerName: "Tae",
      day,
      events: [{ type: "talk", npc: "Abigail", location: "Town", time: 1130, npcLine: first.json.line, playerChoice: "What are you up to?" }],
    });
    assert.equal(end.status, 200);
    assert.deepEqual(end.json.updated, ["Abigail"]);
    const st = await stat(join(store.dir, "Farm_123", "Abigail.json"));
    assert.ok(st.size > 0);

    await post(`${url}/v1/talk`, req({ day: { ...day, day: 6 } }));
    assert.match(model.calls.at(-1)!.user, /What are you up to\?/);
  });
});

test("HTTP: bad input gets 400 and path-like names are refused", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (url) => {
    assert.equal((await post(`${url}/v1/talk`, { npc: "Abigail" })).status, 400);
    assert.equal((await post(`${url}/v1/talk`, req({ npc: "../evil" }))).status, 400);
    assert.equal((await post(`${url}/v1/talk`, req({ saveId: ".." }))).status, 400);
    assert.equal((await post(`${url}/v1/nope`, {})).status, 404);
  });
  assert.throws(() => parseTalk({ ...req(), npc: "a/b" }));
});
