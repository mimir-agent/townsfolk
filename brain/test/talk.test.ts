// Slice 4: conversations with consequences. Talk context carries the NPC's goal and today's
// happening; each choice carries a capped friendship delta and an optional fact; a talk during a
// happening offers one join choice. Every request and response here goes through helpers.ts, so
// it is also checked against protocol/*.schema.json.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST } from "../src/cast.ts";
import { dayKey, shareByNpc } from "../src/memory.ts";
import { fakeAdapter } from "../src/model.ts";
import { memoriesTonight } from "../src/plan.ts";
import { MAIN_FARMER, type DayEvent, type GameDay } from "../src/protocol.ts";
import { CHOICE_DELTA_MAX, JOIN_GAIN, JOIN_TEXT, LINE_MAX, NO_CONTEXT, fitLine, talk, validateReply } from "../src/talk.ts";
import { emptyTown } from "../src/town.ts";
import { emptyMemory } from "../src/memory.ts";
import { talkReq, withServer, type Client } from "./helpers.ts";
import { HAPPENING, SAVE, WORLD, planReq, reply, spring } from "./plan-fixtures.ts";

const quiet = { deadlineMs: 5000, log: () => {} };

// HAPPENING (plan-fixtures.ts): Saloon, 1900 to 2100, Gus, Emily, Pierre and Shane, all
// scheduled there by GOOD_SCHEDULES.
const atSaloon: GameDay = { season: "spring", day: 6, year: 1, time: 1930, weather: "sunny", location: "Saloon" };

function talkReply(choices: Record<string, unknown>[], line = "Oh! Come sit, the stew is almost ready."): string {
  return JSON.stringify({ line, choices, end: false });
}

const PLAIN = [
  { text: "Smells great in here.", delta: 3 },
  { text: "I can't stay long.", delta: -2 },
  { text: "What's the occasion?", delta: 1 },
];

// Planning spring 6 stores the night, including its validated happening.
async function planSpring6(c: Client): Promise<void> {
  assert.equal((await c.post("/v1/world", WORLD)).status, 200);
  const p = await c.post("/v1/plan", planReq(spring(6)));
  assert.equal(p.status, 200);
  assert.deepEqual(p.json.happening, HAPPENING);
}

test("done-when 1: a talk with Emily during the happening offers a join choice; picking it puts a witnessed fact in every participant's pending memory and no one else's", async () => {
  const model = fakeAdapter([
    reply(),
    talkReply([...PLAIN.slice(0, 2), { text: "Can I help taste it?", delta: 4, join: true }, PLAIN[2]!]),
  ]);
  await withServer(model, async (c) => {
    await planSpring6(c);

    const t = await c.post("/v1/talk", talkReq({ npc: "Emily", day: atSaloon }));
    assert.equal(t.status, 200);
    assert.equal(t.json.source, "model");
    const joins = t.json.choices.filter((ch: { join?: true }) => ch.join === true);
    assert.equal(joins.length, 1, "exactly one join choice");
    assert.equal(joins[0].text, "Can I help taste it?");
    assert.equal(joins[0].delta, JOIN_GAIN, "the join gain is the brain's, not the model's 4");
    assert.deepEqual(t.json.happening, { location: "Saloon", topic: HAPPENING.topic, participants: HAPPENING.participants });
    const prompt = model.calls.at(-1)!.user;
    assert.match(prompt, /Today Emily is part of this, at Saloon from 1900 to 2100/);
    assert.match(prompt, /Exactly one choice must be Tae asking to join in/);

    // The bridge on pick: a talk event as before, plus one join event whose witnesses are the
    // other participants from the response, nobody else. Haley is at the Saloon too.
    const h = t.json.happening;
    const events: DayEvent[] = [
      { type: "talk", npc: "Emily", location: "Saloon", time: 1930, witnesses: ["Gus", "Haley", "Pierre", "Shane"], npcLine: t.json.line, playerChoice: joins[0].text },
      { type: "join", npc: "Emily", location: h.location, time: 1930, witnesses: h.participants.filter((p: string) => p !== "Emily"), topic: h.topic },
    ];
    const end = await c.post("/v1/day-end", { v: 1, saveId: SAVE, playerName: "Tae", day: { ...atSaloon, time: 2200 }, events });
    assert.equal(end.status, 200);

    // Pending memory: what each NPC would remember tonight (memoriesTonight is what the planner
    // reads before the save). The join line is in every participant's and no one else's.
    const pending = (await c.store.pending(SAVE))!;
    const stored = new Map(CAST.map((n) => [n, emptyMemory(n)]));
    const tonight = memoriesTonight(stored, pending, spring(7));
    const share = shareByNpc(pending.events);
    for (const npc of CAST) {
      const text = (tonight.get(npc)!.farmers[MAIN_FARMER]?.entries ?? []).map((e) => e.text).join(" ");
      const hasJoin = (share.get(npc) ?? []).some((w) => w.event.type === "join");
      if (HAPPENING.participants.includes(npc)) {
        assert.ok(hasJoin, `${npc} has the join in its share`);
        assert.match(text, /Tae joined us at Saloon, 7:30pm: Gus tries out a new stew recipe\./, npc);
      } else {
        assert.ok(!hasJoin, `${npc} has no join in its share`);
        assert.doesNotMatch(text, /joined us/, npc);
      }
    }
    // Haley saw Emily talking with the player, but not the join.
    assert.match(tonight.get("Haley")!.farmers[MAIN_FARMER]!.entries[0]!.text, /I saw Tae talking with Emily/);

    // After the save the join is a town fact every participant saw, and only they know.
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(6) });
    const town = await c.store.loadTown(SAVE);
    const fact = town.facts.find((f) => /joined in at Saloon/.test(Object.values(f.knowers)[0]!.text));
    assert.ok(fact, "join fact exists");
    assert.ok(fact.shareable);
    const sawIt = Object.entries(fact.knowers).filter(([, k]) => k.source.kind === "saw").map(([n]) => n).sort();
    assert.deepEqual(sawIt, [...HAPPENING.participants].sort());
    // Haley did not see it. She was at the Saloon with them, so the seeded night (fixed by save
    // and date) passes it to her as gossip: heard, one hop, never saw.
    const haley = fact.knowers.Haley!;
    assert.equal(haley.source.kind, "heard");
    assert.equal(haley.hops, 1);
  });
});

test("the join choice is offered only at the happening's place, inside its window, to a participant, once a day, and not on the last turn", async () => {
  const model = fakeAdapter([reply(), talkReply(PLAIN)]);
  await withServer(model, async (c) => {
    await planSpring6(c);
    const offered = async (over: Parameters<typeof talkReq>[0]) => (await c.post("/v1/talk", talkReq(over))).json.happening !== undefined;
    assert.equal(await offered({ npc: "Emily", day: atSaloon }), true);
    assert.equal(await offered({ npc: "Emily", day: { ...atSaloon, time: 1850 } }), false, "before the window");
    assert.equal(await offered({ npc: "Emily", day: { ...atSaloon, time: 2100 } }), false, "at the end time");
    assert.equal(await offered({ npc: "Emily", day: { ...atSaloon, location: "Town" } }), false, "elsewhere");
    assert.equal(await offered({ npc: "Haley", day: atSaloon }), false, "not a participant");
    assert.equal(await offered({ npc: "Emily", day: { ...atSaloon, day: 7 } }), false, "another day");
    assert.equal(await offered({ npc: "Emily", day: atSaloon, joined: true }), false, "already joined today");
    const lastTurn = {
      transcript: [
        { speaker: "npc" as const, text: "1" },
        { speaker: "player" as const, text: "p1" },
        { speaker: "npc" as const, text: "2" },
        { speaker: "player" as const, text: "p2" },
      ],
      recentChoice: { id: "a", text: "p3" },
    };
    assert.equal(await offered({ npc: "Emily", day: atSaloon, ...lastTurn }), false, "last turn");

    // Haley's prompt says nothing about the happening she is not in.
    await c.post("/v1/talk", talkReq({ npc: "Haley", day: atSaloon }));
    assert.doesNotMatch(model.calls.at(-1)!.user, /stew/);
  });
});

test("a join offered but not marked by the model is added by the brain; two marked joins are a bad reply", () => {
  const offer = { location: "Saloon", topic: HAPPENING.topic, participants: HAPPENING.participants };
  const three = validateReply(talkReply(PLAIN), false, offer);
  assert.equal(three.choices.length, 4);
  assert.deepEqual(three.choices.at(-1), { id: "d", text: JOIN_TEXT, delta: JOIN_GAIN, join: true });
  const four = validateReply(talkReply([...PLAIN, { text: "Bye.", delta: 0 }]), false, offer);
  assert.equal(four.choices.length, 4);
  assert.deepEqual(four.choices.map((c) => c.id), ["a", "b", "c", "d"]);
  assert.equal(four.choices.filter((c) => c.join).length, 1);
  assert.throws(() => validateReply(talkReply([...PLAIN.slice(0, 2), { ...PLAIN[2]!, join: true }, { text: "Me too!", join: true }]), false, offer), /2 choices are marked/);
  // Without an offer, a join flag from the model is dropped.
  const none = validateReply(talkReply([{ ...PLAIN[0]!, join: true }, ...PLAIN.slice(1)]), false, null);
  assert.ok(none.choices.every((c) => c.join === undefined));
  assert.equal(none.happening, undefined);
});

test("done-when 2: a promise picked in talk is in Robin's memory after /v1/saved and in tomorrow's planner prompt for Robin only", async () => {
  const promise = "The farmer promised to bring me 20 hardwood by Friday.";
  const model = fakeAdapter([
    talkReply([
      { text: "I'll bring you hardwood by Friday.", delta: 6, fact: { text: promise, shareable: true } },
      { text: "Good luck with it.", delta: 1 },
      { text: "Sounds like a lot of work.", delta: 0 },
    ], "I need hardwood for the new bridge and I'm short."),
    reply(),
  ]);
  await withServer(model, async (c) => {
    const robinDay: GameDay = { season: "spring", day: 5, year: 1, time: 1100, weather: "sunny", location: "ScienceHouse" };
    const t = await c.post("/v1/talk", talkReq({ npc: "Robin", day: robinDay }));
    const picked = t.json.choices[0];
    assert.deepEqual(picked.fact, { text: promise, shareable: true });
    assert.equal(picked.delta, 6);

    // The bridge reports the pick with its fact at day end.
    const events: DayEvent[] = [
      { type: "talk", npc: "Robin", location: "ScienceHouse", time: 1100, witnesses: ["Abigail"], npcLine: t.json.line, playerChoice: picked.text, fact: picked.fact },
    ];
    await c.post("/v1/day-end", { v: 1, saveId: SAVE, playerName: "Tae", day: { ...robinDay, time: 2200 }, events });
    assert.equal((await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(5) })).json.outcome, "committed");

    const robin = await c.store.load(SAVE, "Robin");
    assert.match(robin.farmers[MAIN_FARMER]!.entries.at(-1)!.text, /I will remember: The farmer promised to bring me 20 hardwood by Friday\./);
    // Abigail saw the talk but did not hear the promise.
    const abigail = await c.store.load(SAVE, "Abigail");
    assert.doesNotMatch(JSON.stringify(abigail), /hardwood/);
    // The promise is a fact Robin was told, shareable, so it feeds gossip: Abigail spent the day
    // with Robin, and with this save and date the seeded night passes it to her, as heard.
    const town = await c.store.loadTown(SAVE);
    const fact = town.facts.find((f) => f.knowers.Robin?.text === promise);
    assert.ok(fact);
    assert.equal(fact.knowers.Robin!.source.kind, "told");
    assert.deepEqual(Object.keys(fact.knowers).sort(), ["Abigail", "Robin"]);
    assert.deepEqual(fact.knowers.Abigail!.source, { kind: "heard", from: "Robin" });

    // Tomorrow's plan: the promise is in Robin's block as told to Robin, in Abigail's only as
    // heard from Robin, and in nobody else's.
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.equal((await c.post("/v1/plan", planReq(spring(6)))).status, 200);
    const prompt = model.calls.at(-1)!.user;
    const blocks = Object.fromEntries(prompt.split(/^## /m).slice(1).map((b) => [b.split("\n")[0]!, b]));
    assert.deepEqual(Object.keys(blocks), [...CAST]);
    assert.match(blocks.Robin!, /20 hardwood by Friday/);
    assert.match(blocks.Robin!, /I will remember: The farmer promised/);
    assert.match(blocks.Abigail!, /hardwood.*\(heard from Robin/);
    for (const npc of CAST.filter((n) => n !== "Robin" && n !== "Abigail")) assert.doesNotMatch(blocks[npc]!, /hardwood/, npc);
  });
});

test("a fact told in confidence is remembered but never gossiped", async () => {
  const secret = "The farmer told me they are scared of the dark mines.";
  await withServer(fakeAdapter([JSON.stringify({ line: "x" })]), async (c) => {
    const d: GameDay = { season: "spring", day: 5, year: 1, time: 1100, weather: "sunny", location: "Town" };
    const events: DayEvent[] = [{ type: "talk", npc: "Abigail", location: "Town", time: 1100, witnesses: [], npcLine: "You can tell me.", playerChoice: "Promise not to tell?", fact: { text: secret, shareable: false } }];
    // Abigail spends the day with Emily, so a shareable fact could pass.
    await c.post("/v1/day-end", { v: 1, saveId: SAVE, playerName: "Tae", day: d, events, together: [{ location: "Town", npcs: ["Abigail", "Emily"] }] });
    await c.post("/v1/saved", { v: 1, saveId: SAVE, day: spring(5) });
    const fact = (await c.store.loadTown(SAVE)).facts.find((f) => f.knowers.Abigail?.text === secret)!;
    assert.equal(fact.shareable, false);
    assert.deepEqual(Object.keys(fact.knowers), ["Abigail"]);
    assert.match((await c.store.load(SAVE, "Abigail")).farmers[MAIN_FARMER]!.entries[0]!.text, /\(told in confidence\)/);
  });
});

test("done-when 3: deltas outside the cap are clamped", () => {
  const r = validateReply(
    talkReply([
      { text: "You're amazing.", delta: 99 },
      { text: "Whatever.", delta: -50 },
      { text: "Okay.", delta: 2.6 },
      { text: "Hm.", },
    ]),
    false,
  );
  assert.deepEqual(r.choices.map((c) => c.delta), [CHOICE_DELTA_MAX, -CHOICE_DELTA_MAX, 3, 0]);
  assert.equal(CHOICE_DELTA_MAX, 15);
  assert.throws(() => validateReply(talkReply([{ text: "a", delta: "lots" }, ...PLAIN.slice(1)]), false), /delta is not a number/);
});

test("done-when 3: 2 choices, then 5 choices: one retry, then the canned fallback", async () => {
  const two = talkReply(PLAIN.slice(0, 2));
  const five = talkReply([...PLAIN, { text: "d", delta: 0 }, { text: "e", delta: 0 }]);
  const model = fakeAdapter([two, five]);
  const logs: string[] = [];
  const r = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, { ...quiet, log: (m) => logs.push(m) });
  assert.equal(model.calls.length, 2, "one retry");
  assert.equal(r.source, "fallback");
  assert.equal(r.end, true);
  assert.deepEqual(r.choices, []);
  assert.equal(logs.filter((l) => /need 3 or 4 choices/.test(l)).length, 2);
});

test("a line a few characters over the cap is cut at its last sentence end inside the cap, not failed", async () => {
  // Over the cap by a few characters, as in the smoke test: the last sentence crosses the cap.
  const keep = "Oh, it's you! I was just thinking about you, honestly. Mr. Qi came by the salon earlier and asked the strangest questions about the old mines, and I had no idea what he meant.";
  const over = `${keep} You should come by the Saloon tonight for a drink?`;
  assert.ok(keep.length <= LINE_MAX && over.length > LINE_MAX, `${keep.length} / ${over.length}`);
  assert.equal(fitLine(over), keep);
  // "Mr." is not a sentence end.
  assert.equal(fitLine(`${"a".repeat(205)}. Ask Mr. Qi about it.`), `${"a".repeat(205)}.`);
  // A closing quote stays with its sentence.
  assert.equal(fitLine(`She said "go home!" ${"b".repeat(215)}`), 'She said "go home!"');
  // Within the cap nothing changes; with no sentence end inside the cap the line still fails.
  assert.equal(fitLine("Hi."), "Hi.");
  assert.equal(fitLine("x".repeat(LINE_MAX)), "x".repeat(LINE_MAX));
  assert.throws(() => fitLine("y".repeat(LINE_MAX + 5)), /no sentence end/);
  assert.throws(() => fitLine(""), /outside 1\.\./);

  const model = fakeAdapter([talkReply(PLAIN, over)]);
  const r = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, quiet);
  assert.equal(model.calls.length, 1, "no retry");
  assert.equal(r.source, "model");
  assert.equal(r.end, false);
  assert.equal(r.line, keep);
  assert.equal(r.choices.length, 4);
});

test("the NPC's own active goal reaches its talk prompt, and no one else's", async () => {
  const model = fakeAdapter([reply(), talkReply(PLAIN)]);
  await withServer(model, async (c) => {
    await planSpring6(c);
    const plans = await c.store.loadPlans(SAVE);
    assert.equal(dayKey(plans.nights.at(-1)!.day), dayKey(spring(6)));
    await c.post("/v1/talk", talkReq({ npc: "Gus", day: { ...atSaloon, time: 1000, location: "Town" } }));
    const gus = model.calls.at(-1)!.user;
    assert.match(gus, /Gus's own goal these days: "Gus's spring project" \(progress 10\/100\)/);
    assert.doesNotMatch(gus, /Emily's spring project/);
  });
});
