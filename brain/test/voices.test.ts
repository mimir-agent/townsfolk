// Character cards: every cast member has every section, the heart tier follows friendship, the
// talk prompt and the planner prompt carry only the tier for the farmer's current hearts, and no
// card repeats known game dialogue.

import assert from "node:assert/strict";
import { test } from "node:test";
import { CAST } from "../src/cast.ts";
import { fakeAdapter } from "../src/model.ts";
import { readFileSync } from "node:fs";
import { CARDS, HARD_DENIED, SOFT_DENIED, TIERS, VOICED, cardFor, planCard, talkCard, tierFor, type Card } from "../src/voices.ts";
import { CANON_LINES } from "./canon-lines.ts";
import { talkReq, withServer } from "./helpers.ts";
import { GOOD_SCHEDULES, WORLD, npcsEntry, planReq, reply, spring } from "./plan-fixtures.ts";

test("tier selection by hearts: 0-2 guarded, 3-5, 6-8, 9 and up open (spouse hearts too)", () => {
  const cases: [number, string][] = [
    [0, "0-2"], [2, "0-2"], [3, "3-5"], [5, "3-5"], [6, "6-8"], [8, "6-8"], [9, "9-10"], [10, "9-10"], [14, "9-10"],
  ];
  for (const [hearts, tier] of cases) assert.equal(tierFor(hearts), tier, `${hearts} hearts`);
});

test("every one of the 26 voiced villagers has a card with every section filled, and no extra cards", () => {
  assert.equal(VOICED.length, 26);
  assert.deepEqual(Object.keys(CARDS).sort(), [...VOICED].sort());
  for (const npc of CAST) assert.ok((VOICED as readonly string[]).includes(npc), `cast member ${npc} is voiced`);
  for (const npc of VOICED) {
    const c = cardFor(npc);
    assert.ok(c, npc);
    for (const k of ["voice", "household", "habits"] as const) assert.ok(c[k].trim().length > 20, `${npc} ${k}`);
    for (const k of ["close", "atOdds", "likes", "dislikes", "topics", "neverSays"] as const) {
      assert.ok(c[k].length >= 1 && c[k].every((s) => s.trim().length > 0), `${npc} ${k}`);
    }
    assert.deepEqual(Object.keys(c.tiers), [...TIERS], `${npc} tiers`);
    for (const t of TIERS) assert.ok(c.tiers[t].trim().length > 20, `${npc} tier ${t}`);
    assert.equal(new Set(TIERS.map((t) => c.tiers[t])).size, TIERS.length, `${npc} tiers differ`);
  }
});

function cardText(c: Card): string {
  return [c.voice, c.household, c.habits, ...c.close, ...c.atOdds, ...c.likes, ...c.dislikes, ...c.topics, ...c.neverSays, ...(c.private ?? []), ...Object.values(c.tiers)].join("\n");
}

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

test("no card repeats a known canon line, or any six-word run from one", () => {
  const RUN = 6;
  for (const npc of VOICED) {
    const text = ` ${words(cardText(CARDS[npc]!)).join(" ")} `;
    for (const line of CANON_LINES) {
      const w = words(line);
      for (let i = 0; i + Math.min(RUN, w.length) <= w.length; i++) {
        const run = w.slice(i, i + Math.min(RUN, w.length)).join(" ");
        assert.ok(!text.includes(` ${run} `), `${npc} card repeats "${run}" from: ${line}`);
      }
    }
  }
});

test("the guard itself catches a copied line", () => {
  const copied = ` ${words(`She says: ${CANON_LINES[1]}`).join(" ")} `;
  assert.ok(copied.includes(` ${words(CANON_LINES[1]!).slice(0, 6).join(" ")} `));
});

test("cards carry the canon facts the audit found missing", () => {
  assert.match(talkCard("Emily", 0), /Saloon/);
  assert.match(talkCard("Emily", 0), /Gus/);
  assert.match(talkCard("Emily", 0), /Haley/);
  assert.match(talkCard("Abigail", 0), /Pierre and Caroline/);
  assert.match(talkCard("Shane", 0), /Jas/);
  assert.match(talkCard("Shane", 0), /JojaMart/);
  assert.match(talkCard("Robin", 0), /Demetrius/);
  assert.match(talkCard("Pierre", 0), /Caroline/);
});

test("talk prompt: a stranger gets the guarded tier, a close friend the open one, never both", async () => {
  const model = fakeAdapter([
    JSON.stringify({ line: "What.", choices: [], end: true }),
    JSON.stringify({ line: "Hey, you.", choices: [], end: true }),
  ]);
  await withServer(model, async (c) => {
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 0, points: 0 } }));
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 10, points: 2500 } }));
  });
  const [stranger, friend] = model.calls.map((x) => x.user);
  const s = CARDS.Shane!.tiers;
  assert.ok(stranger!.includes(s["0-2"]));
  assert.ok(!stranger!.includes(s["9-10"]));
  assert.ok(friend!.includes(s["9-10"]));
  assert.ok(!friend!.includes(s["0-2"]));
  for (const p of [stranger!, friend!]) {
    assert.match(p, /Family and household: /);
    assert.match(p, /Never says: /);
  }
});

test("planner prompt: each NPC's block carries its own card at its own heart tier; missing hearts plan as guarded", async () => {
  const model = fakeAdapter([reply({ npcs: npcsEntry(GOOD_SCHEDULES) })]);
  await withServer(model, async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    assert.equal((await c.post("/v1/plan", { ...planReq(spring(6)), hearts: { Abigail: 10, Lewis: 4 } })).status, 200);
  });
  const user = model.calls[0]!.user;
  const block = (npc: string) => {
    const i = CAST.indexOf(npc as (typeof CAST)[number]);
    return user.slice(user.indexOf(`## ${npc}`), i + 1 < CAST.length ? user.indexOf(`## ${CAST[i + 1]}`) : undefined);
  };
  assert.ok(block("Abigail").includes(planCard("Abigail", 10)));
  assert.ok(block("Abigail").includes(CARDS.Abigail!.tiers["9-10"]));
  assert.ok(block("Lewis").includes(CARDS.Lewis!.tiers["3-5"]));
  assert.ok(block("Shane").includes(CARDS.Shane!.tiers["0-2"]), "no hearts sent for Shane: guarded");
  assert.ok(!block("Abigail").includes(CARDS.Lewis!.voice), "one NPC's card never lands in another's block");
  assert.match(model.calls[0]!.system, /Never plan scenes of self-harm/);
});

test("planner request: hearts outside 0..14 are refused", async () => {
  await withServer(fakeAdapter([]), async (c) => {
    assert.equal((await c.post("/v1/world", WORLD)).status, 200);
    const bad = await c.postRaw("/v1/plan", { ...planReq(spring(6)), hearts: { Abigail: 15 } });
    assert.equal(bad.status, 400);
  });
});

test("talk prompt with no memories: only a low-hearts farmer is someone just getting to know", async () => {
  const model = fakeAdapter([
    JSON.stringify({ line: "What.", choices: [], end: true }),
    JSON.stringify({ line: "Hey, you.", choices: [], end: true }),
  ]);
  await withServer(model, async (c) => {
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 2, points: 500 } }));
    await c.post("/v1/talk", talkReq({ npc: "Shane", friendship: { hearts: 8, points: 2000 } }));
  });
  const [low, close] = model.calls.map((x) => x.user);
  assert.match(low!, /just getting to know/);
  assert.doesNotMatch(close!, /just getting to know/);
  assert.match(close!, /keep to how close you already are/);
});

// The bridge (mod/Voiced.cs) is where who-reaches-the-brain is enforced; the brain keeps the
// same lists so it never writes a card for a denied name. Read the C# source so the two agree.
function csSet(source: string, field: string): string[] {
  const m = new RegExp(`${field} = new HashSet<string>\\(StringComparer\\.Ordinal\\)\\s*\\{([^}]*)\\}`).exec(source);
  assert.ok(m, `Voiced.cs ${field}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

test("Voiced.cs and voices.ts list the same 26 voiced, 18 hard-denied and 2 soft-denied names", () => {
  const cs = readFileSync(new URL("../../mod/Voiced.cs", import.meta.url), "utf8");
  assert.deepEqual(csSet(cs, "Roster").sort(), [...VOICED].sort());
  assert.equal(HARD_DENIED.length, 18);
  for (const n of HARD_DENIED) assert.ok(csSet(cs, "HardDeny").includes(n), `HardDeny has ${n}`);
  assert.deepEqual(csSet(cs, "SoftDeny").sort(), [...SOFT_DENIED].sort());
  for (const n of [...HARD_DENIED, ...SOFT_DENIED]) assert.ok(!(VOICED as readonly string[]).includes(n), `${n} not voiced`);
});

test("none of the 20 denied names gets a card", () => {
  const denied = [...HARD_DENIED, ...SOFT_DENIED];
  assert.equal(denied.length, 20);
  for (const n of denied) {
    assert.equal(cardFor(n), undefined, n);
    assert.equal(planCard(n, 10), "", n);
    assert.match(talkCard(n, 10), /a resident of Pelican Town/, n);
  }
});

const ALL_HEARTS = [0, 4, 7, 10] as const;

test("Clint's crush is on Clint's card only: Emily's card, and every other, never mentions it", () => {
  for (const npc of VOICED) {
    if (npc === "Clint") continue;
    for (const h of ALL_HEARTS) {
      for (const block of [talkCard(npc, h), planCard(npc, h)]) {
        assert.doesNotMatch(block, /crush|how he feels about (her|Emily)|feelings for Emily/i, `${npc} at ${h}`);
      }
    }
  }
  for (const h of ALL_HEARTS) assert.doesNotMatch(talkCard("Emily", h), /Clint/, `Emily at ${h}`);
});

test("Clint's own talk card carries his crush on Emily as private", () => {
  const t = talkCard("Clint", 0);
  assert.match(t, /Known only to Clint, never passed on/);
  assert.match(t, /crush on Emily/);
});

test("private items reach only that villager's talk prompt: never the planner, never another card", () => {
  const withPrivate = VOICED.filter((n) => (CARDS[n]!.private ?? []).length > 0);
  assert.ok(withPrivate.length >= 10, `${withPrivate.length} cards carry private items`);
  for (const owner of withPrivate) {
    for (const item of CARDS[owner]!.private!) {
      for (const h of ALL_HEARTS) {
        assert.ok(talkCard(owner, h).includes(item), `${owner} talk ${h}`);
        assert.ok(!planCard(owner, h).includes(item), `${owner} plan ${h}`);
      }
      for (const other of VOICED) {
        if (other === owner) continue;
        assert.ok(!talkCard(other, 10).includes(item), `${owner}'s private item in ${other}'s card`);
      }
    }
  }
});

test("Marnie's and Lewis's secret is private on Marnie's card, not stated on the open sections", () => {
  const c = CARDS.Marnie!;
  const open = [c.voice, c.household, c.habits, ...c.close, ...c.atOdds, ...c.topics, ...Object.values(c.tiers)].join("\n");
  assert.doesNotMatch(open, /romance|dating|partner/i);
  assert.ok(c.private!.some((p) => /Lewis/.test(p)));
});

test("a newly voiced villager's talk prompt carries its own card", async () => {
  const model = fakeAdapter([JSON.stringify({ line: "Hm.", choices: [], end: true })]);
  await withServer(model, async (c) => {
    await c.post("/v1/talk", talkReq({ npc: "Clint", friendship: { hearts: 4, points: 1000 } }));
  });
  const user = model.calls[0]!.user;
  assert.ok(user.includes(CARDS.Clint!.voice));
  assert.ok(user.includes(CARDS.Clint!.tiers["3-5"]));
  assert.ok(!user.includes(CARDS.Clint!.tiers["0-2"]));
});
