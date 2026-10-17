// The fake model the simulator uses offline. It reads the same prompts a real model gets and
// answers with canned JSON assembled from the fixture pieces in world.ts, every choice drawn from
// one seeded RNG, so a seed always replays the same year. It never sees the brain's files: what it
// knows about goals and who to plan comes from the prompt text, as it would for a real model.
//
// About one NPC in twelve gets yesterday's schedule copied, which the brain's repeat guard must
// catch and send back for one regen. About one night in six it also slips one invalid part into the plan (a place that does not
// exist, a reward over the cap, an unknown NPC, a friendship shift over the cap), so the diary
// shows the validator dropping things.

import { isCast, type CastMember } from "../src/cast.ts";
import type { ModelAdapter } from "../src/model.ts";
import type { Rng } from "../src/rng.ts";
import { FRIENDSHIP_REASONS, GOAL_POOL, HAPPENING_POOL, PROMISE_ITEMS, RELATIONSHIP_REASONS, TALK_LINES, TALK_REPLIES, simWorld } from "./world.ts";

const WORLD = simWorld("fixture");
const PLACES = WORLD.locations.map((l) => l.name);

export function pick<T>(rng: Rng, list: readonly T[]): T {
  const v = list[Math.floor(rng.next() * list.length)];
  if (v === undefined) throw new Error("pick from an empty list");
  return v;
}

export function int(rng: Rng, min: number, max: number): number {
  return min + Math.floor(rng.next() * (max - min + 1));
}

function shuffle<T>(rng: Rng, list: readonly T[]): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

type Stop = { time: number; location: string; x: number; y: number; facing: number };

function tile(rng: Rng, location: string): { x: number; y: number } {
  const loc = WORLD.locations.find((l) => l.name === location)!;
  return { x: int(rng, 1, loc.width - 2), y: int(rng, 1, loc.height - 2) };
}

function stop(rng: Rng, time: number, location: string): Stop {
  return { time, location, ...tile(rng, location), facing: int(rng, 0, 3) };
}

const toMinutes = (t: number) => Math.floor(t / 100) * 60 + (t % 100);
const toClock = (m: number) => Math.floor(m / 60) * 100 + (m % 60);

// A game clock time on the hour or half hour, in [from, to].
export function clockBetween(rng: Rng, from: number, to: number): number {
  const slots: number[] = [];
  for (let m = Math.ceil(toMinutes(from) / 30) * 30; m <= toMinutes(to); m += 30) slots.push(toClock(m));
  return pick(rng, slots);
}

export function addHours(t: number, hours: number): number {
  return toClock(toMinutes(t) + 60 * hours);
}

function randomSchedule(rng: Rng): Stop[] {
  const n = int(rng, 2, 4);
  const times = new Set<number>();
  while (times.size < n) times.add(clockBetween(rng, 700, 2200));
  return [...times].sort((a, b) => a - b).map((t) => stop(rng, t, pick(rng, PLACES)));
}

// A schedule that has the NPC at `place` from start to end: some stops before, one at start, and
// maybe one after end. Nothing in between, so the validator sees them there the whole window.
function scheduleAround(rng: Rng, place: string, start: number, end: number): Stop[] {
  const before: Stop[] = [];
  if (start >= 900 && rng.next() < 0.8) before.push(stop(rng, clockBetween(rng, 700, addHours(start, -1)), pick(rng, PLACES)));
  const after = end <= 2300 && rng.next() < 0.8 ? [stop(rng, clockBetween(rng, end, Math.min(addHours(end, 3), 2400)), pick(rng, PLACES))] : [];
  return [...before, stop(rng, start, place), ...after];
}

type GoalState = { kind: "active"; text: string; progress: number } | { kind: "new"; avoid: string[] };

// Reads one NPC's goal line from the planner prompt (plan.ts goalLine).
function readGoal(block: string): GoalState {
  const active = /Goal: "(.+)", progress (\d+)\/100\./.exec(block);
  if (active) return { kind: "active", text: active[1]!, progress: Number(active[2]) };
  const avoid = /do not reuse: (.+)\.$/m.exec(block);
  return { kind: "new", avoid: avoid ? [...avoid[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!) : [] };
}

function planBlocks(user: string): Map<CastMember, string> {
  const out = new Map<CastMember, string>();
  for (const part of user.split(/^## /m).slice(1)) {
    const name = part.slice(0, part.indexOf("\n")).trim();
    if (isCast(name)) out.set(name, part);
  }
  return out;
}

// The NPC's schedule in the newest night of the prompt's plan digest (plan.ts buildPlanPrompt),
// as stops, or null if it was vanilla. Signatures carry time and place only; tiles are drawn anew.
function lastPlanned(rng: Rng, user: string, npc: string): Stop[] | null {
  const latest = user.split("\n").filter((l) => l.startsWith("- ") && l.includes(". Happening: ")).at(-1);
  const sig = latest === undefined ? undefined : new RegExp(`${npc}: ([^;]+?)(?:; |\\. Happening: )`).exec(latest)?.[1];
  if (sig === undefined) return null;
  return sig.split(" / ").map((part) => {
    const [time, location] = part.split(" ");
    return stop(rng, Number(time), location!);
  });
}

function newGoal(rng: Rng, npc: CastMember, season: string, avoid: string[]): { text: string; progress: number } {
  const options = GOAL_POOL[npc].map((a) => `${a} this ${season}`).filter((t) => !avoid.includes(t));
  return { text: pick(rng, options), progress: int(rng, 0, 20) };
}

function fakePlan(rng: Rng, user: string): unknown {
  const season = /day \d+ of 28 in (\w+)\./.exec(user)?.[1] ?? "spring";
  const castLine = /Plan tomorrow for: (.+)\./.exec(user)?.[1] ?? "";
  const cast = castLine.split(", ").filter(isCast);
  const blocks = planBlocks(user);

  const h = pick(rng, HAPPENING_POOL);
  const place = pick(rng, h.places);
  const start = clockBetween(rng, 1000, 1900);
  const end = addHours(start, int(rng, 1, 3));
  const participants = shuffle(rng, cast).slice(0, int(rng, 2, 3));

  const npcs = cast.map((npc) => {
    const goal = readGoal(blocks.get(npc) ?? "");
    const g = goal.kind === "active" ? { text: goal.text, progress: Math.min(100, goal.progress + int(rng, 0, 8)) } : newGoal(rng, npc, season, goal.avoid);
    // Now and then a lazy model copies yesterday, so the repeat guard and its regen get exercised.
    const copied = rng.next() < 0.08 ? lastPlanned(rng, user, npc) : null;
    const schedule = participants.includes(npc) ? scheduleAround(rng, place, start, end) : (copied ?? randomSchedule(rng));
    return { npc, schedule, goal: g };
  });

  const quest = { item: pick(rng, WORLD.items).id, from: pick(rng, cast), reward: 10 * int(rng, 5, 30), text: "" };
  quest.text = `Hello farmer, could you bring me one of these when you have a moment? I would be grateful. From ${quest.from}`;

  const pairs: [string, string][] = [];
  for (let i = 0, n = int(rng, 1, 3); i < n; i++) {
    const [a, b] = shuffle(rng, cast);
    if (a !== undefined && b !== undefined && !pairs.some(([x, y]) => (x === a && y === b) || (x === b && y === a))) pairs.push([a, b]);
  }
  const relationships = pairs.map(([a, b]) => {
    const delta = pick(rng, [-6, -4, -2, 2, 3, 5, 7]);
    return { a, b, delta, reason: pick(rng, delta > 0 ? RELATIONSHIP_REASONS.warmer : RELATIONSHIP_REASONS.cooler) };
  });
  const friendship = shuffle(rng, cast)
    .slice(0, int(rng, 0, 2))
    .map((npc) => {
      const delta = pick(rng, [-10, -5, 5, 10, 15]);
      return { npc, delta, reason: pick(rng, delta > 0 ? FRIENDSHIP_REASONS.warmer : FRIENDSHIP_REASONS.cooler) };
    });

  const reply = { npcs, happening: { location: place, start, end, participants, topic: h.topic }, quests: [quest] as unknown[], friendship: friendship as unknown[], relationships: relationships as unknown[] };

  // The occasional bad part, so the validator has something to drop.
  if (rng.next() < 1 / 6) {
    const kind = int(rng, 0, 3);
    if (kind === 0) {
      const victim = pick(rng, npcs);
      victim.schedule = [...victim.schedule.slice(0, 1), { time: 2500, location: "Moon", x: 1, y: 1, facing: 2 }];
    } else if (kind === 1) reply.quests = [{ ...quest, reward: 5000 }, quest];
    else if (kind === 2) reply.relationships = [...relationships, { a: "Krobus", b: pick(rng, cast), delta: 3, reason: "an unknown neighbor" }];
    else reply.friendship = [...friendship.filter((f) => f.npc !== npcs[0]!.npc), { npc: npcs[0]!.npc, delta: 80, reason: "far too much" }];
  }
  return reply;
}

function fakeRegen(rng: Rng, user: string): unknown {
  const names = [...user.matchAll(/^## (\S+)$/gm)].map((m) => m[1]!);
  return { schedules: names.map((npc) => ({ npc, schedule: randomSchedule(rng) })) };
}

function fakeTalk(rng: Rng, user: string): unknown {
  const line = pick(rng, TALK_LINES);
  if (/This is the last turn/.test(user)) return { line: "Well, I should get back to it. See you around.", choices: [], end: true };
  const replies = shuffle(rng, TALK_REPLIES).slice(0, 3);
  const choices: Record<string, unknown>[] = replies.map(([text, delta], i) => ({ id: "abc"[i], text, delta }));
  if (rng.next() < 0.4) {
    const shareable = rng.next() < 0.85;
    choices[2] = {
      id: "c",
      text: shareable ? "I'll bring you something soon." : "Can I tell you something private?",
      delta: 4,
      fact: shareable
        ? { text: `The farmer promised to bring me ${pick(rng, PROMISE_ITEMS)} soon.`, shareable: true }
        : { text: "The farmer said they miss their family back in the city.", shareable: false },
    };
  }
  if (/mark that choice with "join": true/.test(user)) choices[0] = { id: "a", text: "Mind if I join in?", delta: 5, join: true };
  return { line, choices, end: false };
}

// One adapter for the whole run. The kind of request is told apart by its system prompt, which
// the brain fixes per endpoint (talk.ts, plan.ts).
export function fakeTownAdapter(rng: Rng): ModelAdapter {
  return {
    name: "fake-town",
    async complete(system, user) {
      if (system.startsWith("You write dialogue")) return JSON.stringify(fakeTalk(rng, user));
      if (system.startsWith("You plan tomorrow")) return JSON.stringify(fakePlan(rng, user));
      if (system.startsWith("You replan schedules")) return JSON.stringify(fakeRegen(rng, user));
      throw new Error(`fake town got an unknown prompt: ${system.slice(0, 60)}`);
    },
  };
}
