// v0.1.1: each talk turn carries the whole conversation and the game's own lines from today, every
// reply ends with the brain's fixed goodbye, a walked-away chat resumes from its stored transcript,
// and each player has a model session of their own.

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMemory } from "../src/memory.ts";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { BYE_ID, CLOSINGS, GOODBYES, NO_CONTEXT, talk, talkSession } from "../src/talk.ts";
import { emptyTown } from "../src/town.ts";
import type { DayEndRequest } from "../src/protocol.ts";
import { day, talkReq, withServer } from "./helpers.ts";

const dayEnd = (events: DayEndRequest["events"]): DayEndRequest => ({ v: 1, saveId: "Farm_123", playerName: "Tae", day, events });

const quiet = { deadlineMs: 5000, log: () => {} };
const VANILLA = "Oh, hello! You must be the new farmer. I'm Abigail.";

test("turn 3's prompt holds turns 1 and 2 of the transcript and a line the game said today", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  const transcript = [
    { speaker: "npc" as const, text: "TURN-ONE-NPC" },
    { speaker: "player" as const, text: "TURN-ONE-PLAYER" },
    { speaker: "npc" as const, text: "TURN-TWO-NPC" },
    { speaker: "player" as const, text: "TURN-TWO-PLAYER" },
  ];
  await talk(
    talkReq({ transcript, recentChoice: { id: "a", text: "TURN-THREE-PLAYER" }, gameLines: [VANILLA] }),
    emptyMemory("Abigail"),
    emptyTown(),
    NO_CONTEXT,
    model,
    quiet,
  );
  const user = model.calls[0]!.user;
  for (const part of ["TURN-ONE-NPC", "TURN-ONE-PLAYER", "TURN-TWO-NPC", "TURN-TWO-PLAYER", "TURN-THREE-PLAYER", VANILLA]) {
    assert.ok(user.includes(part), `prompt lacks ${part}`);
  }
  assert.match(user, /the game itself already had Abigail say/);
});

test("over HTTP: a game line sent as a 'said' event is in the NPC's memory the next day", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const ev = { type: "said", npc: "Abigail", location: "Town", time: 1000, witnesses: [], line: VANILLA };
    assert.equal((await c.post("/v1/day-end", dayEnd([ev]))).status, 200);
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: "Farm_123", day: { season: day.season, day: day.day, year: day.year } })).status, 200);
    const next = { ...day, day: day.day + 1 };
    const t = await c.post("/v1/talk", talkReq({ day: next }));
    assert.equal(t.status, 200);
    const mem = await c.store.load("Farm_123", "Abigail");
    const text = JSON.stringify(mem);
    assert.ok(text.includes("(game line)") && text.includes(VANILLA), text);
  });
});

test("every reply that continues ends with the brain's fixed goodbye; the same turn always shows the same words", async () => {
  const a = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, fakeAdapter([DEFAULT_FAKE_REPLY]), quiet);
  const b = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, fakeAdapter([DEFAULT_FAKE_REPLY]), quiet);
  const bye = a.choices.at(-1)!;
  assert.equal(a.choices.length, 4);
  assert.equal(bye.id, BYE_ID);
  assert.equal(bye.bye, true);
  assert.equal(bye.delta, 0);
  assert.ok((GOODBYES as readonly string[]).includes(bye.text));
  assert.ok((CLOSINGS as readonly string[]).includes(bye.closing ?? ""));
  assert.deepEqual(b.choices.at(-1), bye);
  assert.equal(a.choices.filter((c) => c.bye).length, 1);
});

test("the goodbye is added even when the model gives four choices, and the model's own text never replaces it", async () => {
  const four = JSON.stringify({
    line: "Hi.",
    choices: [
      { text: "One", delta: 0 },
      { text: "Two", delta: 0 },
      { text: "Three", delta: 0 },
      { text: "Bye then!", delta: 0 },
    ],
    end: false,
  });
  const r = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, fakeAdapter([four]), quiet);
  assert.deepEqual(r.choices.map((c) => c.id), ["a", "b", "c", "d"]);
  assert.deepEqual(r.choices.slice(0, 3).map((c) => c.text), ["One", "Two", "Three"]);
  assert.equal(r.choices[3]!.bye, true);
});

test("a final reply has no goodbye choice, and the fallback has none either", async () => {
  const last = await talk(
    talkReq({ transcript: [{ speaker: "npc", text: "1" }, { speaker: "player", text: "p1" }, { speaker: "npc", text: "2" }, { speaker: "player", text: "p2" }], recentChoice: { id: "a", text: "p3" } }),
    emptyMemory("Abigail"),
    emptyTown(),
    NO_CONTEXT,
    fakeAdapter([JSON.stringify({ line: "Goodbye!", choices: [], end: true })]),
    quiet,
  );
  assert.deepEqual(last.choices, []);
  const down = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, fakeAdapter(["THROW"]), quiet);
  assert.equal(down.source, "fallback");
  assert.deepEqual(down.choices, []);
});

test("resuming: a talk request with a stored transcript and no new pick tells the model the chat is being picked back up", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  const transcript = [
    { speaker: "npc" as const, text: "EARLIER-LINE" },
    { speaker: "player" as const, text: "EARLIER-PICK" },
    { speaker: "npc" as const, text: "LAST-NPC-LINE" },
  ];
  await talk(talkReq({ transcript }), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, quiet);
  const user = model.calls[0]!.user;
  assert.ok(user.includes("EARLIER-LINE") && user.includes("LAST-NPC-LINE"));
  assert.match(user, /walked away mid-conversation and has come back/);
});

test("each player has a model session of their own, and NPCs share only their player's", async () => {
  const model = fakeAdapter([DEFAULT_FAKE_REPLY]);
  await talk(talkReq({ npc: "Abigail", farmerId: "111", farmerName: "Ash" }), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, quiet);
  await talk(talkReq({ npc: "Pierre", farmerId: "111", farmerName: "Ash" }), emptyMemory("Pierre"), emptyTown(), NO_CONTEXT, model, quiet);
  await talk(talkReq({ npc: "Abigail", farmerId: "222", farmerName: "Bea" }), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, quiet);
  const [a, p, b] = model.calls.map((c) => c.session);
  assert.equal(a, talkSession("Farm_123", "111"));
  assert.equal(a, p, "one player, one process, whichever NPC");
  assert.notEqual(a, b, "another player never shares it");
});

test("the timing line is logged for a successful call", async () => {
  const logs: string[] = [];
  await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, fakeAdapter([DEFAULT_FAKE_REPLY]), { deadlineMs: 5000, log: (m) => logs.push(m) });
  assert.ok(logs.some((l) => /talk Abigail model answered in \d+ms/.test(l)), logs.join("\n"));
});
