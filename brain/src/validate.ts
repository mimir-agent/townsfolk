// The plan validator. Authoritative: every part of a model-written plan is checked here against
// the world snapshot the bridge sent at save load (POST /v1/world), and anything that fails is
// dropped on its own with a reason. One bad part never costs the rest of the plan.
// The bridge later re-checks only what needs the live game (the walking route, and the tile,
// which it moves to the nearest one an NPC can stand on).
//
// Pure functions, no I/O. plan.ts decides the order: schedules first (with the repeat regen),
// then the happening against the schedules that survived, then quest, friendship, relationships.

import { isCast, pairKey } from "./cast.ts";
import type {
  CalendarDay,
  DayRef,
  DroppedPart,
  FriendshipShift,
  Happening,
  MailQuest,
  PlannedSchedule,
  RelationshipShift,
  ScheduleStop,
  WorldRequest,
} from "./protocol.ts";

export const DAY_START = 600;
export const FIRST_TIME = 610;
export const LAST_TIME = 2600;
export const MAX_STOPS = 12;
export const MAX_REWARD = 500;
export const MAX_FRIENDSHIP = 40;
export const MAX_RELATIONSHIP = 10;
export const MAX_QUEST_CANDIDATES = 3;
export const MAX_REASON = 200;
export const MAX_TOPIC = 120;
export const MAX_MAIL = 400;
export const MAX_GOAL = 120;

export type World = Omit<WorldRequest, "v" | "saveId">;

export class InvalidPlan extends Error {}

// The model's reply after the top-level shape check. Everything inside is still unchecked.
export type RawPlan = {
  npcs: unknown[];
  happening: unknown;
  quests: unknown[];
  friendship: unknown[];
  relationships: unknown[];
};

function parseObject(raw: string): Record<string, unknown> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new InvalidPlan("no JSON object in reply");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new InvalidPlan("reply JSON does not parse");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new InvalidPlan("reply is not an object");
  return parsed as Record<string, unknown>;
}

// A missing or null optional list means the model planned none of that kind.
function optList(v: unknown, field: string): unknown[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new InvalidPlan(`${field} is not a list`);
  return v;
}

// Only the top-level shape can fail the whole reply (and trigger the retry). Everything below
// it is judged part by part.
export function parsePlanReply(raw: string): RawPlan {
  const p = parseObject(raw);
  if (!Array.isArray(p.npcs)) throw new InvalidPlan("npcs is not a list");
  return {
    npcs: p.npcs,
    happening: p.happening ?? null,
    quests: optList(p.quests, "quests"),
    friendship: optList(p.friendship, "friendship"),
    relationships: optList(p.relationships, "relationships"),
  };
}

export function parseRegenReply(raw: string): unknown[] {
  const p = parseObject(raw);
  if (!Array.isArray(p.schedules)) throw new InvalidPlan("schedules is not a list");
  return p.schedules;
}

type Check<T> = { ok: true; value: T } | { ok: false; reason: string };
const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v);
}

// The game's dialogue and mail engines treat these characters as commands.
export function cleanText(s: string): string {
  return s.replace(/[$#@%^{}<>|[\]~`]/g, "").replace(/\s+/g, " ").trim();
}

function text(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = cleanText(v);
  return t.length > 0 && t.length <= max ? t : null;
}

// A game clock time: hhmm with minutes in steps of 10, 610 to 2600.
function isClock(t: number): boolean {
  return t >= FIRST_TIME && t <= LAST_TIME && t % 100 < 60 && t % 10 === 0;
}

export function isFestival(world: World, day: DayRef): boolean {
  return world.festivals.some((f: CalendarDay) => f.season === day.season && f.day === day.day);
}

// One NPC's schedule. The model writes structured stops, never a raw schedule string, so game
// schedule commands (GOTO and the rest) cannot be expressed: a string schedule is not a list.
export function checkSchedule(npc: string, stops: unknown, world: World): Check<ScheduleStop[]> {
  if (world.married.includes(npc)) return fail(`${npc} is married; spouse schedules are out of scope`);
  if (!Array.isArray(stops) || stops.length === 0 || stops.length > MAX_STOPS) return fail(`schedule must be a list of 1..${MAX_STOPS} stops`);
  const out: ScheduleStop[] = [];
  for (const [i, raw] of stops.entries()) {
    const s = rec(raw);
    if (s === null) return fail(`stop ${i + 1} is not an object`);
    // The day starts at 600 and the model often writes that for "first thing"; the first stop
    // the game runs is 610.
    const time = i === 0 && s.time === DAY_START ? FIRST_TIME : s.time;
    if (!isInt(time) || !isClock(time)) return fail(`stop ${i + 1} time ${JSON.stringify(time)} is not a game time in ${FIRST_TIME}..${LAST_TIME}`);
    const prev = out.at(-1);
    if (prev !== undefined && time <= prev.time) return fail(`stop ${i + 1} time ${time} is not after ${prev.time}`);
    const loc = world.locations.find((l) => l.name === s.location);
    if (loc === undefined) return fail(`stop ${i + 1} location ${JSON.stringify(s.location)} is not in the world`);
    if (!isInt(s.x) || !isInt(s.y) || s.x < 0 || s.y < 0 || s.x >= loc.width || s.y >= loc.height) {
      return fail(`stop ${i + 1} tile ${JSON.stringify(s.x)},${JSON.stringify(s.y)} is outside ${loc.name} (${loc.width}x${loc.height})`);
    }
    if (!isInt(s.facing) || s.facing < 0 || s.facing > 3) return fail(`stop ${i + 1} facing must be 0..3`);
    out.push({ time, location: loc.name, x: s.x, y: s.y, facing: s.facing });
  }
  return { ok: true, value: out };
}

// Two schedules match when they go to the same places at the same times. Tiles and facing are
// ignored, so moving one tile over does not count as a new day.
export function scheduleSignature(stops: ScheduleStop[]): string {
  return stops.map((s) => `${s.time} ${s.location}`).join(" / ");
}

// Where the NPC stands from `start` to `end`: the last stop at or before start must be at the
// place, and no stop may move them away before end.
function presentThroughout(stops: ScheduleStop[], location: string, start: number, end: number): boolean {
  const before = stops.filter((s) => s.time <= start).at(-1);
  if (before === undefined || before.location !== location) return false;
  return !stops.some((s) => s.time > start && s.time < end);
}

// Participants who are not scheduled at the place for the whole window are dropped one by one;
// the happening itself is dropped if fewer than 2 remain.
export function checkHappening(raw: unknown, schedules: PlannedSchedule[], world: World): { happening: Happening | null; dropped: DroppedPart[] } {
  if (raw === null) return { happening: null, dropped: [] };
  const drop = (reason: string) => ({ happening: null, dropped: [{ part: "happening", reason }] });
  const h = rec(raw);
  if (h === null) return drop("happening is not an object");
  if (typeof h.location !== "string" || !world.locations.some((l) => l.name === h.location)) return drop(`location ${JSON.stringify(h.location)} is not in the world`);
  if (!isInt(h.start) || !isInt(h.end) || !isClock(h.start) || !isClock(h.end) || h.start >= h.end) {
    return drop(`window ${JSON.stringify(h.start)}..${JSON.stringify(h.end)} is not two increasing game times in ${FIRST_TIME}..${LAST_TIME}`);
  }
  const topic = text(h.topic, MAX_TOPIC);
  if (topic === null) return drop(`topic must be text of 1..${MAX_TOPIC} characters`);
  if (!Array.isArray(h.participants)) return drop("participants is not a list");
  const dropped: DroppedPart[] = [];
  const participants: string[] = [];
  for (const p of h.participants) {
    const label = `happening participant ${typeof p === "string" ? p : JSON.stringify(p)}`;
    if (typeof p !== "string" || !isCast(p)) dropped.push({ part: label, reason: "not in the planning cast" });
    else if (participants.includes(p)) dropped.push({ part: label, reason: "listed twice" });
    else {
      const sched = schedules.find((s) => s.npc === p);
      if (sched === undefined || !presentThroughout(sched.stops, h.location, h.start, h.end)) {
        dropped.push({ part: label, reason: `not scheduled at ${h.location} from ${h.start} to ${h.end}` });
      } else participants.push(p);
    }
  }
  if (participants.length < 2) return { happening: null, dropped: [...dropped, { part: "happening", reason: `fewer than 2 participants are scheduled at ${h.location} for the whole window` }] };
  return { happening: { location: h.location, start: h.start, end: h.end, participants, topic }, dropped };
}

// The model may offer up to MAX_QUEST_CANDIDATES quests in order of preference, so one bad quest
// does not cost the day its quest. The first valid one is delivered; each invalid one before it
// is dropped with its reason. Candidates after the chosen one are never looked at.
export function checkQuests(raw: unknown[], world: World, id: string): { quest: MailQuest | null; dropped: DroppedPart[] } {
  const dropped: DroppedPart[] = [];
  for (const [i, c] of raw.slice(0, MAX_QUEST_CANDIDATES).entries()) {
    const part = `quest ${i + 1}`;
    const q = rec(c);
    const reason = ((): string | MailQuest => {
      if (q === null) return "not an object";
      const item = world.items.find((it) => it.id === q.item);
      if (item === undefined) return `item ${JSON.stringify(q.item)} is not an item in the world`;
      if (typeof q.from !== "string" || !isCast(q.from)) return `from ${JSON.stringify(q.from)} is not in the planning cast`;
      if (world.married.includes(q.from)) return `${q.from} is married; spouse quests are out of scope`;
      if (!isInt(q.reward) || q.reward < 0) return `reward ${JSON.stringify(q.reward)} is not a whole number of gold`;
      if (q.reward > MAX_REWARD) return `reward ${q.reward}g is over the ${MAX_REWARD}g cap`;
      const mail = text(q.text, MAX_MAIL);
      if (mail === null) return `mail text must be 1..${MAX_MAIL} characters`;
      return { id, item: item.id, from: q.from, reward: q.reward, text: mail };
    })();
    if (typeof reason !== "string") return { quest: reason, dropped };
    dropped.push({ part, reason });
  }
  if (raw.length > MAX_QUEST_CANDIDATES) dropped.push({ part: "quests", reason: `only the first ${MAX_QUEST_CANDIDATES} candidates are considered` });
  return { quest: null, dropped };
}

export function checkFriendship(raw: unknown[]): { kept: FriendshipShift[]; dropped: DroppedPart[] } {
  const kept: FriendshipShift[] = [];
  const dropped: DroppedPart[] = [];
  for (const [i, c] of raw.entries()) {
    const f = rec(c);
    const npc = f !== null && typeof f.npc === "string" ? f.npc : `#${i + 1}`;
    const part = `friendship ${npc}`;
    const reason = text(f?.reason, MAX_REASON);
    if (f === null) dropped.push({ part, reason: "not an object" });
    else if (!isCast(npc)) dropped.push({ part, reason: "not in the planning cast" });
    else if (kept.some((k) => k.npc === npc)) dropped.push({ part, reason: "a second shift for the same NPC on one day" });
    else if (!isInt(f.delta) || f.delta === 0) dropped.push({ part, reason: `delta ${JSON.stringify(f.delta)} is not a non-zero whole number` });
    else if (Math.abs(f.delta) > MAX_FRIENDSHIP) dropped.push({ part, reason: `delta ${f.delta} is over the +-${MAX_FRIENDSHIP} daily cap` });
    else if (reason === null) dropped.push({ part, reason: `reason must be 1..${MAX_REASON} characters` });
    else kept.push({ npc, delta: f.delta, reason });
  }
  return { kept, dropped };
}

export function checkRelationships(raw: unknown[]): { kept: RelationshipShift[]; dropped: DroppedPart[] } {
  const kept: RelationshipShift[] = [];
  const dropped: DroppedPart[] = [];
  for (const [i, c] of raw.entries()) {
    const r = rec(c);
    const a = r !== null && typeof r.a === "string" ? r.a : "?";
    const b = r !== null && typeof r.b === "string" ? r.b : "?";
    const part = r === null ? `relationship #${i + 1}` : `relationship ${a}-${b}`;
    const reason = text(r?.reason, MAX_REASON);
    if (r === null) dropped.push({ part, reason: "not an object" });
    else if (!isCast(a) || !isCast(b) || a === b) dropped.push({ part, reason: "needs two different cast members" });
    else if (kept.some((k) => pairKey(k.a, k.b) === pairKey(a, b))) dropped.push({ part, reason: "a second shift for the same pair on one day" });
    else if (!isInt(r.delta) || r.delta === 0) dropped.push({ part, reason: `delta ${JSON.stringify(r.delta)} is not a non-zero whole number` });
    else if (Math.abs(r.delta) > MAX_RELATIONSHIP) dropped.push({ part, reason: `delta ${r.delta} is over the +-${MAX_RELATIONSHIP} daily cap` });
    else if (reason === null) dropped.push({ part, reason: `reason must be 1..${MAX_REASON} characters` });
    else kept.push({ a, b, delta: r.delta, reason });
  }
  return { kept, dropped };
}

export type GoalProposal = { text: string; progress: number };

export function checkGoalShape(raw: unknown): Check<GoalProposal> {
  const g = rec(raw);
  if (g === null) return fail("goal is not an object");
  const t = text(g.text, MAX_GOAL);
  if (t === null) return fail(`goal text must be 1..${MAX_GOAL} characters`);
  if (!isInt(g.progress) || g.progress < 0 || g.progress > 100) return fail(`goal progress ${JSON.stringify(g.progress)} is not a whole number in 0..100`);
  return { ok: true, value: { text: t, progress: g.progress } };
}
