import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { emptyMemory } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import type { DayEndRequest } from "../src/protocol.ts";
import { parseTalk } from "../src/protocol.ts";
import { MAX_TURNS, talk, validateReply } from "../src/talk.ts";
import { assertValid, day, talkReq as req, tempStore, withServer } from "./helpers.ts";

const quiet = { deadlineMs: 5000, log: () => {} };

test("valid model reply passes through with 3 choices", async () => {
  const r = await talk(req(), emptyMemory("Abigail"), fakeAdapter([DEFAULT_FAKE_REPLY]), quiet);
  assertValid("talk-response", r);
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
  assertValid("talk-response", r);
  assert.equal(model.calls.length, 2);
  assert.equal(r.source, "fallback");
  assert.equal(r.end, true);
  assert.deepEqual(r.choices, []);
});

test("validation enforces choice count, length caps and strips dialogue command characters", () => {
  assert.throws(() => validateReply(JSON.stringify({ line: "hi", choices: [{ text: "a" }, { text: "b" }] }), false));
  assert.throws(() => validateReply(JSON.stringify({ line: "x".repeat(300), choices: [], end: true }), false));
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
  const talkRequest = req({ transcript, recentChoice: { id: "a", text: "p3" } });
  assertValid("talk-request", talkRequest);
  const r = await talk(talkRequest, emptyMemory("Abigail"), model, quiet);
  assert.equal(MAX_TURNS, 3);
  assert.equal(r.end, true);
  assert.deepEqual(r.choices, []);
  assert.match(model.calls[0]!.user, /last turn/);
});

function dayEnd(events: DayEndRequest["events"]): DayEndRequest {
  return { v: 1, saveId: "Farm_123", playerName: "Tae", day, events };
}

test("prompt carries only this NPC's own memory", async () => {
  const store = await tempStore();
  await store.stage(
    dayEnd([
      { type: "talk", npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "Abby secret line", playerChoice: "Abby reply" },
      { type: "talk", npc: "Pierre", location: "SeedShop", time: 1100, witnesses: [], npcLine: "Pierre secret line", playerChoice: "Pierre reply" },
    ]),
  );
  await store.commit("Farm_123", day);
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await talk(req({ npc: "Pierre" }), await store.load("Farm_123", "Pierre"), model, quiet);
  const prompt = model.calls[0]!.user;
  assert.match(prompt, /Pierre secret line/);
  assert.doesNotMatch(prompt, /Abby/);
});

test("memory files are per NPC and never contain another NPC's conversation", async () => {
  const store = await tempStore();
  await store.stage(
    dayEnd([
      { type: "talk", npc: "Abigail", location: "Town", time: 1000, witnesses: [], npcLine: "ABBY-LINE", playerChoice: "ABBY-CHOICE" },
      { type: "gift", npc: "Shane", location: "Saloon", time: 1900, witnesses: [], item: "Beer", taste: "loved" },
    ]),
  );
  await store.commit("Farm_123", day);
  const files = (await readdir(join(store.dir, "Farm_123"))).sort();
  assert.deepEqual(files, ["Abigail.json", "Shane.json"]);
  const shane = await readFile(join(store.dir, "Farm_123", "Shane.json"), "utf8");
  assert.doesNotMatch(shane, /ABBY/);
  assert.match(shane, /Tae gave me Beer \(loved\)/);
});

test("HTTP: talk round trip, then day-end and saved write memory that the next day's talk sees", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await withServer(model, async (c) => {
    const health = await c.get("/v1/health");
    assert.equal(health.status, 200);

    const first = await c.post("/v1/talk", req());
    assert.equal(first.status, 200);
    assert.equal(first.json.choices.length, 3);

    const end = await c.post(
      "/v1/day-end",
      dayEnd([{ type: "talk", npc: "Abigail", location: "Town", time: 1130, witnesses: [], npcLine: first.json.line, playerChoice: "What are you up to?" }]),
    );
    assert.equal(end.status, 200);
    assert.deepEqual(end.json.pending, ["Abigail"]);

    const saved = await c.post("/v1/saved", { v: 1, saveId: "Farm_123", day: { season: "spring", day: 5, year: 1 } });
    assert.deepEqual(saved.json, { v: 1, ok: true, outcome: "committed", committed: ["Abigail"] });

    await c.post("/v1/talk", req({ day: { ...day, day: 6 } }));
    assert.match(model.calls.at(-1)!.user, /What are you up to\?/);
  });
});

test("HTTP: bad input gets 400 and path-like names are refused", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    assert.equal((await c.postRaw("/v1/talk", { v: 1, npc: "Abigail" })).status, 400);
    assert.equal((await c.postRaw("/v1/talk", req({ npc: "../evil" }))).status, 400);
    assert.equal((await c.postRaw("/v1/talk", req({ saveId: ".." }))).status, 400);
    assert.equal((await c.postRaw("/v1/nope", {})).status, 404);
  });
  assert.throws(() => parseTalk({ ...req(), npc: "a/b" }));
});
