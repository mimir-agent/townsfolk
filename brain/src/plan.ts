// The overnight planner. POST /v1/plan, after day-end, asks the model once for tomorrow's town
// plan for the cast, validates every part against the world snapshot (validate.ts), sends the
// cast's repeated schedules back for one regen, and returns what survived. Anything dropped is
// logged with a reason and listed in the response, and that NPC or part runs vanilla.
//
// Plan state lives at <stateDir>/<saveId>/_plans.json: one record per planned night, the last
// HISTORY_NIGHTS of them. A record carries the night's schedule signatures (for the repeat
// guard and the digest), every cast member's goal after that night, and the NPC relationship
// shifts, which reach the town state only when that day is saved (memory.ts commit).
// Planning a date replaces any record for that date or later, so replanning after a reload, or
// after restoring an older save, never stacks.

import { CAST, type CastMember } from "./cast.ts";
import { applyDay, dateLabel, dayKey, emptyMemory, shareByNpc, type NpcMemory, type PendingDay } from "./memory.ts";
import type { ModelAdapter } from "./model.ts";
import type { DayRef, DroppedPart, GoalView, Happening, PlannedSchedule, PlanRequest, PlanResponse, RelationshipShift, ScheduleStop } from "./protocol.ts";
import { SEASONS } from "./protocol.ts";
import { knowledgeBlock, type TalkContext } from "./talk.ts";
import { relationship, type TownState } from "./town.ts";
import {
  checkFriendship,
  checkGoalShape,
  checkHappening,
  checkQuests,
  checkRelationships,
  checkSchedule,
  FIRST_TIME,
  InvalidPlan,
  isFestival,
  LAST_TIME,
  MAX_FRIENDSHIP,
  MAX_GOAL,
  MAX_QUEST_CANDIDATES,
  MAX_RELATIONSHIP,
  MAX_REWARD,
  MAX_STOPS,
  parsePlanReply,
  parseRegenReply,
  scheduleSignature,
  type World,
} from "./validate.ts";
import { planCard } from "./voices.ts";

export const HISTORY_NIGHTS = 7;
// A goal whose progress has not moved for a season is retired and replaced.
export const STALL_DAYS = 28;
export const RETIRED_KEPT = 5;
export const PLAN_MAX_TOKENS = 4000;
// Per NPC in the planner prompt: the newest raw memory days, and a cap on the whole block.
export const PLAN_MEMORY_DAYS = 3;
export const PLAN_MEMORY_CHARS = 1200;

export type Goal = { text: string; progress: number; started: number; progressedAt: number };

export type Night = {
  day: DayRef;
  source: PlanResponse["source"];
  // npc -> scheduleSignature of the schedule planned for it. NPCs left vanilla are absent.
  schedules: Record<string, string>;
  goals: Record<string, Goal>;
  // npc -> its most recent finished or abandoned goals, newest last, so a new goal differs.
  retired: Record<string, string[]>;
  happening: string | null;
  // The validated happening itself, so a talk that day can offer the join choice. Absent in
  // records written before slice 4; those nights offer no join.
  happeningPlan?: Happening | null;
  quest: string | null;
  relationships: RelationshipShift[];
};

export type PlanState = { version: 1; nights: Night[] };

export function emptyPlans(): PlanState {
  return { version: 1, nights: [] };
}

// Nights before `day`, oldest first, at most HISTORY_NIGHTS.
export function priorNights(state: PlanState, day: DayRef): Night[] {
  return state.nights.filter((n) => dayKey(n.day) < dayKey(day)).slice(-HISTORY_NIGHTS);
}

export function recordNight(state: PlanState, night: Night): PlanState {
  return { ...state, nights: [...priorNights(state, night.day), night].slice(-(HISTORY_NIGHTS + 1)) };
}

// What a talk on `day` may use from the plans: the NPC's goal as of the latest night planned
// for that day or earlier, and the happening planned for that exact day if the NPC is in it.
export function todayFor(state: PlanState, npc: string, day: DayRef): TalkContext {
  const night = state.nights.filter((n) => dayKey(n.day) <= dayKey(day)).at(-1);
  if (night === undefined) return { goal: null, happening: null };
  const g = night.goals[npc];
  const h = dayKey(night.day) === dayKey(day) ? (night.happeningPlan ?? null) : null;
  return {
    goal: g === undefined ? null : { text: g.text, progress: g.progress },
    happening: h !== null && h.participants.includes(npc) ? h : null,
  };
}

export type GoalNeed = "none" | "complete" | "stalled" | "active";

export function goalNeed(goal: Goal | undefined, day: DayRef): GoalNeed {
  if (goal === undefined) return "none";
  if (goal.progress >= 100) return "complete";
  if (dayKey(day) - goal.progressedAt >= STALL_DAYS) return "stalled";
  return "active";
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

export type PlanContext = {
  world: World;
  town: TownState;
  memories: Map<string, NpcMemory>;
  state: PlanState;
};

// What each cast member remembers, as of tonight. The day just ended is still pending (it is
// committed only when the game saves), so its share is folded in here, in memory only, from the
// same per-NPC split the commit uses. Nothing is written.
export function memoriesTonight(stored: Map<string, NpcMemory>, pending: PendingDay | null, day: DayRef): Map<string, NpcMemory> {
  if (pending === null || dayKey(pending.day) !== dayKey(day) - 1) return stored;
  const share = shareByNpc(pending.events);
  const out = new Map(stored);
  for (const npc of CAST) {
    const mem = out.get(npc);
    const mine = share.get(npc);
    if (mem !== undefined && mine !== undefined) out.set(npc, applyDay(mem, pending.day, mine, pending.playerName));
  }
  return out;
}

function memoryLines(mem: NpcMemory): string {
  const season = mem.seasons.at(-1);
  const lines = [
    mem.years ? `Long ago: ${mem.years}` : "",
    season ? `${season.season} of year ${season.year}: ${season.text}` : "",
    ...mem.entries.slice(-PLAN_MEMORY_DAYS).map((e) => `${dateLabel(e.day)}: ${e.text}`),
  ].filter(Boolean);
  const text = lines.length > 0 ? lines.join("\n") : "Nothing yet with the farmer.";
  // Keep the newest end when cutting: recent days matter most for tomorrow.
  return text.length <= PLAN_MEMORY_CHARS ? text : `...${text.slice(text.length - PLAN_MEMORY_CHARS + 3)}`;
}

export function nextDay(d: DayRef): DayRef {
  if (d.day < 28) return { ...d, day: d.day + 1 };
  const s = SEASONS.indexOf(d.season);
  return s === 3 ? { season: "spring", day: 1, year: d.year + 1 } : { season: SEASONS[s + 1]!, day: 1, year: d.year };
}

function calendarLines(world: World, day: DayRef): string {
  const upcoming: string[] = [];
  let d = day;
  for (let i = 0; i < 14; i++) {
    const f = world.festivals.find((x) => x.season === d.season && x.day === d.day);
    if (f !== undefined) upcoming.push(`${dateLabel(d)}: ${f.name}`);
    d = nextDay(d);
  }
  return [`Today is ${dateLabel(day)}, day ${day.day} of 28 in ${day.season}.`, upcoming.length > 0 ? `Festivals in the next two weeks: ${upcoming.join("; ")}.` : "No festivals in the next two weeks."].join(" ");
}

function goalLine(npc: string, goal: Goal | undefined, need: GoalNeed, retired: string[], day: DayRef): string {
  const avoid = retired.length > 0 ? ` Earlier goals, do not reuse: ${retired.map((g) => `"${g}"`).join(", ")}.` : "";
  if (need === "active" && goal !== undefined) {
    return `Goal: "${goal.text}", progress ${goal.progress}/100. Keep this exact goal text; raise progress if tomorrow moves it forward, never lower it.`;
  }
  const why = need === "complete" ? `${npc} just finished "${goal!.text}".` : need === "stalled" ? `"${goal!.text}" has not moved for a season and is dropped.` : `${npc} has no goal yet.`;
  return `Goal: NEW NEEDED. ${why} Pick one new personal goal that fits ${day.season} and ${npc}, progress 0 to 20.${avoid}`;
}

const SYSTEM = `You plan tomorrow in Stardew Valley's Pelican Town for a fixed cast of villagers.
Reply with ONE JSON object and nothing else: no prose, no markdown fences.
Shape:
{"npcs": [{"npc": string, "schedule": [{"time": number, "location": string, "x": number, "y": number, "facing": number}], "goal": {"text": string, "progress": number}}],
 "happening": {"location": string, "start": number, "end": number, "participants": [string], "topic": string} or null,
 "quests": [{"item": string, "from": string, "reward": number, "text": string}],
 "friendship": [{"npc": string, "delta": number, "reason": string}],
 "relationships": [{"a": string, "b": string, "delta": number, "reason": string}]}
Rules:
- One entry in "npcs" per cast member listed. A schedule is 1 to ${MAX_STOPS} stops; each stop is when the villager sets off (24h game clock, hhmm, minutes in steps of 10, ${FIRST_TIME} to ${LAST_TIME}, strictly increasing), where they go (a location from the list exactly), the tile (x, y inside that location's size) and which way they face when there (0 up, 1 right, 2 down, 3 left).
- Schedules follow each villager's goal, mood and relationships. Do not copy the recent plans: vary places and times.
- "happening": at most one thing going on somewhere in town that the farmer could walk up to. Every participant's schedule must have them at that location for the whole window. null if nothing fits.
- "quests": up to ${MAX_QUEST_CANDIDATES} mailed item-delivery requests, best first; only the first valid one is sent. "item" is an item id from the list, "from" a cast member, "reward" whole gold 0 to ${MAX_REWARD}, "text" the letter in that villager's voice, at most 400 characters. [] for none.
- "friendship": how villagers feel about the farmer after what happened, delta -${MAX_FRIENDSHIP} to ${MAX_FRIENDSHIP} points, only where something gives a reason.
- "relationships": shifts between two cast members from what they did or heard, delta -${MAX_RELATIONSHIP} to ${MAX_RELATIONSHIP}, with the reason.
- Each villager's block starts with who they are and how open they are with the farmer at their current hearts; quests, happenings and friendship shifts stay inside that tier (a guarded villager does not confide or ask big favors).
- Keep heavy themes as they are in the character's past. Never plan scenes of self-harm or crisis for anyone.
- A villager only acts on what their own block says they know. Never use one villager's memory for another. Something told in confidence is never passed on.
- Goal text at most ${MAX_GOAL} characters, progress 0 to 100; 100 means finished. No "$", "#", "{", "}", "<", ">", "|" anywhere.`;

export function buildPlanPrompt(req: PlanRequest, ctx: PlanContext, cast: readonly CastMember[], prior: Night[]): { system: string; user: string } {
  const last = prior.at(-1);
  const blocks = cast.map((npc) => {
    const goal = last?.goals[npc];
    const need = goalNeed(goal, req.day);
    // A goal retired tonight is not in the record yet, but the new one must differ from it too.
    const avoid = [...(last?.retired[npc] ?? []), ...(need !== "active" && goal !== undefined ? [goal.text] : [])].slice(-RETIRED_KEPT);
    const others = CAST.filter((o) => o !== npc).map((o) => `${o} ${relationship(ctx.town, npc, o)}`).join(", ");
    return [
      `## ${npc}`,
      planCard(npc, req.hearts[npc] ?? 0),
      goalLine(npc, goal, need, avoid, req.day),
      `Feelings toward the others (-100 to 100): ${others}.`,
      `Memory (only what ${npc} took part in or saw):\n${memoryLines(ctx.memories.get(npc) ?? emptyMemory(npc))}`,
      knowledgeBlock(npc, req.stats, ctx.town),
    ]
      .filter(Boolean)
      .join("\n");
  });
  const digest =
    prior.length === 0
      ? "No earlier plans."
      : prior
          .map((n) => {
            const sched = Object.entries(n.schedules).map(([npc, sig]) => `${npc}: ${sig}`).join("; ");
            return `- ${dateLabel(n.day)}: ${sched || "all vanilla"}. Happening: ${n.happening ?? "none"}. Quest: ${n.quest ?? "none"}.`;
          })
          .join("\n");
  const user = [
    calendarLines(ctx.world, req.day),
    `The farmer: ${req.playerName}.`,
    `Locations (name, width x height in tiles): ${ctx.world.locations.map((l) => `${l.name} ${l.width}x${l.height}`).join(", ")}.`,
    `Items for quests (id = name): ${ctx.world.items.map((i) => `${i.id} = ${i.name}`).join(", ")}.`,
    `Recent plans, last ${HISTORY_NIGHTS} nights (vary from these):\n${digest}`,
    `Plan tomorrow for: ${cast.join(", ")}.`,
    ...blocks,
  ].join("\n\n");
  return { system: SYSTEM, user };
}

const REGEN_SYSTEM = `You replan schedules for Stardew Valley villagers whose plan for tomorrow repeated a recent day.
Reply with ONE JSON object and nothing else: {"schedules": [{"npc": string, "schedule": [{"time": number, "location": string, "x": number, "y": number, "facing": number}]}]}
Same stop rules as before: 1 to ${MAX_STOPS} stops, game times ${FIRST_TIME} to ${LAST_TIME} strictly increasing in steps of 10 minutes, locations from the list exactly, tiles inside the location, facing 0 to 3. Each new schedule must differ from every recent one listed: different places or different times.`;

export function buildRegenPrompt(world: World, repeats: { npc: string; recent: string[] }[]): { system: string; user: string } {
  const user = [
    `Locations (name, width x height in tiles): ${world.locations.map((l) => `${l.name} ${l.width}x${l.height}`).join(", ")}.`,
    ...repeats.map((r) => `## ${r.npc}\nRecent schedules, do not repeat any of them:\n${r.recent.map((s) => `- ${s}`).join("\n")}`),
  ].join("\n\n");
  return { system: REGEN_SYSTEM, user };
}

type Ask = (system: string, user: string) => Promise<string>;

// One prompt, two attempts. Returns null when both failed; the caller decides the fallback.
async function askTwice<T>(ask: Ask, system: string, user: string, parse: (raw: string) => T, label: string, log: (m: string) => void): Promise<T | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      return parse(await ask(system, user));
    } catch (err) {
      log(`${label} attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }
  return null;
}

// The quest id the game will see. Always ours, always prefixed, one per planned date.
export function questId(day: DayRef): string {
  return `townsfolk_${dayKey(day)}`;
}

function emptyResponse(day: DayRef, source: PlanResponse["source"], dropped: DroppedPart[]): PlanResponse {
  return { v: 1, day, source, schedules: [], goals: [], happening: null, quest: null, friendship: [], relationships: [], dropped };
}

export type PlanResult = { response: PlanResponse; night: Night | null };

export async function plan(
  req: PlanRequest,
  ctx: PlanContext,
  model: ModelAdapter,
  opts: { deadlineMs: number; log: (msg: string) => void },
): Promise<PlanResult> {
  if (isFestival(ctx.world, req.day)) return { response: emptyResponse(req.day, "festival", []), night: null };

  const deadline = Date.now() + opts.deadlineMs;
  const ask: Ask = (system, user) => {
    const remaining = deadline - Date.now();
    if (remaining < 500) return Promise.reject(new Error("plan deadline reached"));
    return model.complete(system, user, AbortSignal.timeout(remaining), PLAN_MAX_TOKENS);
  };
  const prior = priorNights(ctx.state, req.day);
  const last = prior.at(-1);
  // Married cast members are never planned; they stay vanilla without costing the prompt.
  const cast = CAST.filter((n) => !ctx.world.married.includes(n));
  const { system, user } = buildPlanPrompt(req, ctx, cast, prior);
  const raw = await askTwice(ask, system, user, parsePlanReply, "plan", opts.log);
  const carried: Night = {
    day: req.day,
    source: "fallback",
    schedules: {},
    goals: { ...(last?.goals ?? {}) },
    retired: { ...(last?.retired ?? {}) },
    happening: null,
    happeningPlan: null,
    quest: null,
    relationships: [],
  };
  if (raw === null) {
    return { response: emptyResponse(req.day, "fallback", [{ part: "plan", reason: "the model gave no usable plan in two attempts; everyone runs vanilla" }]), night: carried };
  }

  const dropped: DroppedPart[] = [];
  const schedules = new Map<string, ScheduleStop[]>();
  const goalRaw = new Map<string, unknown>();
  const seen = new Set<string>();
  for (const [i, entry] of raw.npcs.entries()) {
    const e = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    const npc = typeof e.npc === "string" ? e.npc : `#${i + 1}`;
    if (!(cast as readonly string[]).includes(npc)) {
      dropped.push({ part: `npc ${npc}`, reason: ctx.world.married.includes(npc) ? `${npc} is married; spouse schedules are out of scope` : "not in the planning cast" });
      continue;
    }
    if (seen.has(npc)) {
      dropped.push({ part: `npc ${npc}`, reason: "listed twice; the first entry is used" });
      continue;
    }
    seen.add(npc);
    if (e.goal !== undefined) goalRaw.set(npc, e.goal);
    const s = checkSchedule(npc, e.schedule, ctx.world);
    if (s.ok) schedules.set(npc, s.value);
    else dropped.push({ part: `schedule ${npc}`, reason: s.reason });
  }

  // Repeat guard: a schedule that matches one of the NPC's last HISTORY_NIGHTS planned schedules
  // gets one regen, then goes vanilla.
  const recentOf = (npc: string) => prior.map((n) => n.schedules[npc]).filter((s): s is string => s !== undefined);
  const repeats = [...schedules.entries()].filter(([npc, stops]) => recentOf(npc).includes(scheduleSignature(stops))).map(([npc]) => npc);
  if (repeats.length > 0) {
    for (const npc of repeats) schedules.delete(npc);
    const rp = buildRegenPrompt(
      ctx.world,
      repeats.map((npc) => ({ npc, recent: [...new Set(recentOf(npc))] })),
    );
    opts.log(`plan regen for ${repeats.join(", ")}: schedule repeats one of the last ${HISTORY_NIGHTS} nights`);
    const regen = (await askTwice(ask, rp.system, rp.user, parseRegenReply, "plan regen", opts.log)) ?? [];
    for (const npc of repeats) {
      const entry = regen.find((x) => typeof x === "object" && x !== null && (x as Record<string, unknown>).npc === npc) as Record<string, unknown> | undefined;
      if (entry === undefined) {
        dropped.push({ part: `schedule ${npc}`, reason: "repeated a recent schedule and the regen gave none; vanilla" });
        continue;
      }
      const s = checkSchedule(npc, entry.schedule, ctx.world);
      if (!s.ok) dropped.push({ part: `schedule ${npc}`, reason: `repeated a recent schedule and the regen was invalid (${s.reason}); vanilla` });
      else if (recentOf(npc).includes(scheduleSignature(s.value))) dropped.push({ part: `schedule ${npc}`, reason: "repeated a recent schedule again after one regen; vanilla" });
      else schedules.set(npc, s.value);
    }
  }

  const planned: PlannedSchedule[] = cast.filter((n) => schedules.has(n)).map((npc) => ({ npc, stops: schedules.get(npc)! }));

  // Goals: an active goal keeps its text and may only move forward; a finished, stalled or
  // missing goal must be replaced by one that differs from the old and the retired ones.
  const goals: Record<string, Goal> = { ...(last?.goals ?? {}) };
  const retired: Record<string, string[]> = { ...(last?.retired ?? {}) };
  const goalViews: GoalView[] = [];
  const today = dayKey(req.day);
  for (const npc of cast) {
    const old = last?.goals[npc];
    const need = goalNeed(old, req.day);
    const proposal = goalRaw.get(npc);
    const part = `goal ${npc}`;
    if (need !== "active" && old !== undefined) {
      retired[npc] = [...(retired[npc] ?? []), old.text].slice(-RETIRED_KEPT);
      delete goals[npc];
    }
    if (proposal === undefined) {
      if (need !== "active") dropped.push({ part, reason: "a new goal was needed and none was given" });
      if (need === "active" && old !== undefined) goalViews.push({ npc, text: old.text, progress: old.progress, isNew: false });
      continue;
    }
    const g = checkGoalShape(proposal);
    let reason: string | null = g.ok ? null : g.reason;
    if (g.ok && need === "active" && old !== undefined) {
      if (!same(g.value.text, old.text)) reason = `the active goal "${old.text}" is not finished; the text must stay the same`;
      else if (g.value.progress < old.progress) reason = `progress ${g.value.progress} is below the current ${old.progress}`;
      else {
        goals[npc] = { ...old, progress: g.value.progress, progressedAt: g.value.progress > old.progress ? today : old.progressedAt };
      }
    } else if (g.ok) {
      if (g.value.progress >= 100) reason = "a new goal cannot start finished";
      else if ((retired[npc] ?? []).some((t) => same(t, g.value.text))) reason = `"${g.value.text}" was already a goal; a new one must differ`;
      else goals[npc] = { text: g.value.text, progress: g.value.progress, started: today, progressedAt: today };
    }
    if (reason !== null) dropped.push({ part, reason });
    const now = goals[npc];
    if (now !== undefined) goalViews.push({ npc, text: now.text, progress: now.progress, isNew: now.started === today });
  }

  const h = checkHappening(raw.happening, planned, ctx.world);
  dropped.push(...h.dropped);
  const q = checkQuests(raw.quests, ctx.world, questId(req.day));
  dropped.push(...q.dropped);
  const f = checkFriendship(raw.friendship);
  dropped.push(...f.dropped);
  const r = checkRelationships(raw.relationships);
  dropped.push(...r.dropped);

  const response: PlanResponse = {
    v: 1,
    day: req.day,
    source: "model",
    schedules: planned,
    goals: goalViews,
    happening: h.happening,
    quest: q.quest,
    friendship: f.kept,
    relationships: r.kept,
    dropped,
  };
  const night: Night = {
    day: req.day,
    source: "model",
    schedules: Object.fromEntries(planned.map((p) => [p.npc, scheduleSignature(p.stops)])),
    goals,
    retired,
    happening: h.happening ? `${h.happening.topic} at ${h.happening.location} (${h.happening.participants.join(", ")})` : null,
    happeningPlan: h.happening,
    quest: q.quest ? `${q.quest.from} asks for ${q.quest.item}` : null,
    relationships: r.kept,
  };
  return { response, night };
}
