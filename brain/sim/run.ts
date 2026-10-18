// The year simulator. Starts a real brain server on a free localhost port with a fresh state
// directory and drives it day by day the way the bridge does: POST /v1/world once, then each day
// talks (POST /v1/talk, turn by turn, with seeded reply picks), POST /v1/day-end with the day's
// events and who spent time together, POST /v1/plan for tomorrow, POST /v1/saved for today.
// Night order matches the game: day-end, the plan (which reads the pending day), then the save.
//
// The simulated player and the fake town model share one seeded RNG and every request is
// sequential, so the same seed and adapter give the same diary. Wall time and brain log lines
// (which carry timings) stay out of the diary.
//
// Checks, enforced every day or at the end (see checks below): memory files at most 32 KB, the
// canary never leaves Emily, no identical planned schedule on more than 3 consecutive planned
// days, at least 8 distinct goals started (runs of 112 days or more), and every applied plan part
// passes the validator again when the sim re-checks it.

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAST, pairKey, type CastMember } from "../src/cast.ts";
import { clock, dateLabel, fileBudget, MemoryStore } from "../src/memory.ts";
import type { ModelAdapter } from "../src/model.ts";
import { nextDay } from "../src/plan.ts";
import type { DayEvent, DayRef, GameDay, PlanResponse, ScheduleStop, TalkResponse, Together, TranscriptLine } from "../src/protocol.ts";
import { seededRng, type Rng } from "../src/rng.ts";
import { createBrain } from "../src/server.ts";
import type { TownState } from "../src/town.ts";
import { checkFriendship, checkGoalShape, checkHappening, checkQuests, checkRelationships, checkSchedule, isFestival, scheduleSignature, type World } from "../src/validate.ts";
import { int, pick } from "./fake-town.ts";
import { CANARY, CANARY_FACT, CANARY_HOLDER, GIFT_ITEMS, PLAYER, simWorld, VANILLA } from "./world.ts";

export const MAX_IDENTICAL_RUN = 3;
export const MIN_GOALS = 8;
export const GOALS_CHECK_DAYS = 112;

export type SimOptions = {
  days: number;
  seed: number;
  // Builds the model from the run's RNG. The fake town uses it; a real model ignores it.
  model: (rng: Rng) => ModelAdapter;
  talkDeadlineMs: number;
  planDeadlineMs: number;
  log?: (msg: string) => void;
};

export type Check = { name: string; ok: boolean; detail: string };

export type SimResult = {
  diary: string;
  checks: Check[];
  modelCalls: number;
  drops: number;
  regens: number;
  sources: Record<string, number>;
};

const WEATHER = ["sunny", "sunny", "sunny", "rainy", "windy", "stormy"];
const START: DayRef = { season: "spring", day: 1, year: 1 };

// Where an NPC is at `time`: the last stop at or before it, else where its day starts.
function whereAt(stops: [number, string][], time: number, npc: CastMember): string {
  return stops.filter(([t]) => t <= time).at(-1)?.[1] ?? VANILLA[npc][0]![1];
}

function routineFor(npc: CastMember, plan: PlanResponse | null): { stops: [number, string][]; planned: boolean } {
  const s = plan?.schedules.find((p) => p.npc === npc);
  return s ? { stops: s.stops.map((x) => [x.time, x.location]), planned: true } : { stops: VANILLA[npc], planned: false };
}

function stopsText(stops: ScheduleStop[]): string {
  return stops.map((s) => `${clock(s.time)} ${s.location}`).join(", ");
}

// Re-checks a plan response against the validator, as the bridge will trust it. Returns problems.
export function recheckPlan(resp: PlanResponse, world: World): string[] {
  const problems: string[] = [];
  if (resp.source === "festival" || resp.source === "fallback") {
    if (resp.schedules.length + resp.relationships.length + resp.friendship.length > 0 || resp.happening || resp.quest) problems.push(`${resp.source} plan carries parts`);
    return problems;
  }
  if (isFestival(world, resp.day)) problems.push("a festival day was planned");
  const seen = new Set<string>();
  for (const s of resp.schedules) {
    if (seen.has(s.npc)) problems.push(`schedule ${s.npc} listed twice`);
    seen.add(s.npc);
    if (!(CAST as readonly string[]).includes(s.npc)) problems.push(`schedule ${s.npc} is not cast`);
    const c = checkSchedule(s.npc, s.stops, world);
    if (!c.ok) problems.push(`schedule ${s.npc}: ${c.reason}`);
  }
  if (resp.happening) {
    const h = checkHappening(resp.happening, resp.schedules, world);
    if (h.dropped.length > 0 || JSON.stringify(h.happening) !== JSON.stringify(resp.happening)) problems.push(`happening: ${h.dropped.map((d) => d.reason).join("; ")}`);
  }
  if (resp.quest) {
    if (!resp.quest.id.startsWith("townsfolk_")) problems.push(`quest id ${resp.quest.id} lacks the townsfolk_ prefix`);
    const q = checkQuests([resp.quest], world, resp.quest.id);
    if (JSON.stringify(q.quest) !== JSON.stringify(resp.quest)) problems.push(`quest: ${q.dropped.map((d) => d.reason).join("; ")}`);
  }
  for (const d of checkFriendship(resp.friendship).dropped) problems.push(`friendship: ${d.reason}`);
  for (const d of checkRelationships(resp.relationships).dropped) problems.push(`relationship: ${d.reason}`);
  for (const g of resp.goals) {
    const c = checkGoalShape(g);
    if (!c.ok) problems.push(`goal ${g.npc}: ${c.reason}`);
  }
  return problems;
}

// Longest run of identical signatures in a list of planned days (vanilla days are skipped).
export function longestIdenticalRun(signatures: string[]): number {
  let best = 0;
  let run = 0;
  for (const [i, s] of signatures.entries()) {
    run = i > 0 && signatures[i - 1] === s ? run + 1 : 1;
    best = Math.max(best, run);
  }
  return best;
}

// Where the canary may appear in a prompt. Talk prompts are for one character; plan prompts hold
// one block per cast member after the shared head; regen prompts hold no memory at all.
export function canaryLeak(system: string, user: string): string | null {
  if (!user.includes(CANARY) && !system.includes(CANARY)) return null;
  if (system.startsWith("You write dialogue")) {
    const who = /^Character: (.+)$/m.exec(user)?.[1];
    return who === CANARY_HOLDER ? null : `talk prompt for ${who ?? "unknown"}`;
  }
  if (system.startsWith("You plan tomorrow")) {
    const [head, ...blocks] = user.split(/^## /m);
    if (head!.includes(CANARY)) return "plan prompt, shared part";
    const bad = blocks.filter((b) => b.includes(CANARY) && !b.startsWith(`${CANARY_HOLDER}\n`)).map((b) => b.slice(0, b.indexOf("\n")));
    return bad.length > 0 ? `plan prompt, block for ${bad.join(", ")}` : null;
  }
  return "regen prompt";
}

type Http = (path: string, body: unknown) => Promise<any>;

export async function runSim(opts: SimOptions): Promise<SimResult> {
  const rng = seededRng(opts.seed);
  const inner = opts.model(rng);
  const leaks: string[] = [];
  let modelCalls = 0;
  const model: ModelAdapter = {
    name: inner.name,
    complete(system, user, signal, maxTokens, o) {
      modelCalls++;
      const leak = canaryLeak(system, user);
      if (leak !== null) leaks.push(leak);
      return inner.complete(system, user, signal, maxTokens, o);
    },
  };
  const brainLog: string[] = [];
  const log = opts.log ?? (() => {});
  const stateDir = await mkdtemp(join(tmpdir(), "townsfolk-sim-"));
  const store = new MemoryStore(stateDir);
  const server = createBrain({
    store,
    model,
    talkDeadlineMs: opts.talkDeadlineMs,
    planDeadlineMs: opts.planDeadlineMs,
    version: "sim",
    readiness: () => ({ ready: true }),
    log: (m) => {
      brainLog.push(m);
      log(m);
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const post: Http = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json();
    if (res.status !== 200) throw new Error(`${path} answered ${res.status}: ${JSON.stringify(json)}`);
    return json;
  };

  const saveId = `Sim_${opts.seed}`;
  const worldReq = simWorld(saveId);
  const { v: _v, saveId: _s, ...world } = worldReq;
  const out: string[] = [];
  const failures = { memory: [] as string[], validator: [] as string[] };
  let maxMemory = 0;
  let drops = 0;
  const sources: Record<string, number> = {};
  const signatures = new Map<string, string[]>(CAST.map((n) => [n, []]));
  const goalsStarted = new Set<string>();
  const goalsFinished: string[] = [];
  const friendship = new Map<string, number>(CAST.map((n) => [n, 250]));
  const bump = (npc: string, delta: number) => friendship.set(npc, Math.max(0, Math.min(2500, (friendship.get(npc) ?? 0) + delta)));
  const hearts = () => Object.fromEntries([...friendship].map(([npc, p]) => [npc, Math.floor(p / 250)]));

  try {
    await post("/v1/world", worldReq);
    let date = START;
    let today: PlanResponse = await post("/v1/plan", { v: 1, saveId, playerName: PLAYER, day: date, stats: { farmName: "Sim", daysPlayed: 0 }, hearts: hearts() });
    out.push(`# Town diary: ${opts.days} days, seed ${opts.seed}, model ${inner.name}`, "");

    for (let n = 1; n <= opts.days; n++) {
      const weather = pick(rng, WEATHER);
      const festival = world.festivals.find((f) => f.season === date.season && f.day === date.day);
      out.push(`## Day ${n}: ${dateLabel(date)}, ${weather}${festival ? `, ${festival.name}` : ""}`, "");
      sources[today.source] = (sources[today.source] ?? 0) + 1;
      drops += today.dropped.length;

      // The plan that is in force today, and the validator re-check of it.
      const problems = recheckPlan(today, world);
      for (const p of problems) failures.validator.push(`${dateLabel(date)}: ${p}`);
      const routines = new Map(CAST.map((npc) => [npc, routineFor(npc, today)] as const));
      for (const npc of CAST) {
        const s = today.schedules.find((p) => p.npc === npc);
        if (s) signatures.get(npc)!.push(scheduleSignature(s.stops));
      }

      out.push(`Plan: ${today.source}, ${today.schedules.length} planned, ${CAST.length - today.schedules.length} vanilla.`);
      for (const npc of CAST) {
        const s = today.schedules.find((p) => p.npc === npc);
        const g = today.goals.find((x) => x.npc === npc);
        const goal = g ? ` Goal: ${g.text} (${g.progress}/100${g.isNew ? ", new" : ""}).` : "";
        out.push(`- ${npc}: ${s ? stopsText(s.stops) : "vanilla"}.${goal}`);
        if (g?.isNew) goalsStarted.add(`${npc}: ${g.text}`);
        if (g && g.progress >= 100) goalsFinished.push(`${npc}: ${g.text}`);
      }
      const h = today.happening;
      out.push(h ? `Happening: ${h.topic} at ${h.location}, ${clock(h.start)} to ${clock(h.end)}, with ${h.participants.join(", ")}.` : "Happening: none.");
      const q = today.quest;
      out.push(q ? `Quest: ${q.from} asks for ${world.items.find((i) => i.id === q.item)?.name ?? q.item} (${q.item}), ${q.reward}g. "${q.text}"` : "Quest: none.");
      for (const f of today.friendship) bump(f.npc, f.delta);
      if (today.friendship.length > 0) out.push(`Feelings toward ${PLAYER}: ${today.friendship.map((f) => `${f.npc} ${f.delta > 0 ? "+" : ""}${f.delta} (${f.reason})`).join("; ")}.`);
      out.push(today.dropped.length > 0 ? `Dropped by the validator: ${today.dropped.map((d) => `${d.part} (${d.reason})`).join("; ")}.` : "Dropped by the validator: nothing.");

      // The player's day.
      const gameDay = (time: number, location: string): GameDay => ({ ...date, time, weather, location });
      const events: DayEvent[] = [];
      const witnessesAt = (npc: string, location: string, time: number) => CAST.filter((o) => o !== npc && whereAt(routines.get(o)!.stops, time, o) === location);
      const did: string[] = [];
      let joined = false;

      if (n === 1) {
        // Day 1: the player tells Emily something in confidence, as the bridge would report it.
        const loc = whereAt(routines.get(CANARY_HOLDER)!.stops, 1000, CANARY_HOLDER);
        events.push({ type: "talk", npc: CANARY_HOLDER, location: loc, time: 1000, witnesses: witnessesAt(CANARY_HOLDER, loc, 1000), npcLine: "You look like something is on your mind.", playerChoice: "Can I tell you something in confidence?", fact: { text: CANARY_FACT, shareable: false } });
        did.push(`told ${CANARY_HOLDER} the canary in confidence at ${loc}`);
      }

      if (!festival) {
        const visits: { npc: CastMember; time: number; location: string }[] = [];
        if (h && rng.next() < 0.6) {
          const npc = pick(rng, h.participants) as CastMember;
          visits.push({ npc, time: h.start + 10, location: h.location });
        }
        const count = int(rng, 2, 3);
        const others = CAST.filter((c) => !visits.some((v) => v.npc === c));
        while (visits.length < count) {
          const npc = others.splice(Math.floor(rng.next() * others.length), 1)[0]!;
          const time = 100 * int(rng, 9, 18) + pick(rng, [0, 30]);
          visits.push({ npc, time, location: whereAt(routines.get(npc)!.stops, time, npc) });
        }
        visits.sort((a, b) => a.time - b.time || a.npc.localeCompare(b.npc));

        for (const visit of visits) {
          // One game time for the whole talk: the sim's clock does not tick during a conversation.
          const { npc, location, time } = visit;
          const transcript: TranscriptLine[] = [];
          let recent: { id: string; text: string } | undefined;
          const points = () => friendship.get(npc) ?? 0;
          const said: string[] = [];
          for (let turn = 0; turn < 4; turn++) {
            const reply = (await post("/v1/talk", {
              v: 1,
              saveId,
              npc,
              playerName: PLAYER,
              day: gameDay(time, location),
              friendship: { hearts: Math.floor(points() / 250), points: points() },
              ...(recent ? { recentChoice: recent } : {}),
              ...(joined ? { joined: true } : {}),
              transcript,
              stats: { farmName: "Sim", daysPlayed: n - 1 },
            })) as TalkResponse;
            // Like the bridge: a fallback on the opening turn means vanilla dialogue; a fallback
            // later is shown but not remembered.
            if (reply.source === "fallback") {
              said.push(turn === 0 ? "the brain gave no reply (vanilla line)" : "the talk ended on a canned line");
              break;
            }
            transcript.push({ speaker: "npc", text: reply.line });
            if (reply.end || reply.choices.length === 0) {
              events.push({ type: "talk", npc, location, time, witnesses: witnessesAt(npc, location, time), npcLine: reply.line });
              break;
            }
            const join = reply.choices.find((c) => c.join === true);
            const choice = join && rng.next() < 0.7 ? join : pick(rng, reply.choices.filter((c) => c.join !== true));
            events.push({ type: "talk", npc, location, time, witnesses: witnessesAt(npc, location, time), npcLine: reply.line, playerChoice: choice.text, ...(choice.fact ? { fact: choice.fact } : {}) });
            if (choice.join && reply.happening) {
              joined = true;
              const rest = reply.happening.participants.filter((p) => p !== npc);
              events.push({ type: "join", npc, location: reply.happening.location, time, witnesses: rest, topic: reply.happening.topic });
              for (const p of reply.happening.participants) bump(p, choice.delta);
              said.push(`joined ${reply.happening.topic}`);
            } else bump(npc, choice.delta);
            said.push(`"${choice.text}" (${choice.delta > 0 ? "+" : ""}${choice.delta})${choice.fact ? `, ${choice.fact.shareable ? "promised" : "said in confidence"}: ${choice.fact.text}` : ""}`);
            recent = { id: choice.id, text: choice.text };
            transcript.push({ speaker: "player", text: choice.text });
          }
          if (rng.next() < 0.25) {
            const [item, taste] = pick(rng, GIFT_ITEMS);
            events.push({ type: "gift", npc, location, time, witnesses: witnessesAt(npc, location, time), item, taste });
            said.push(`gift ${item} (${taste})`);
          }
          did.push(`${npc} at ${location}, ${clock(visit.time)}: ${said.join("; ") || "nothing said"}`);
        }
      }
      out.push(did.length > 0 ? `${PLAYER}: ${did.join(". ")}.` : `${PLAYER}: at the festival; no talks recorded.`);

      // Who spent time together, sampled every hour like the bridge's TimeChanged sampling.
      const together = new Map<string, Together>();
      if (!festival) {
        for (let t = 800; t <= 2200; t += 100) {
          const byPlace = new Map<string, string[]>();
          for (const npc of CAST) {
            const at = whereAt(routines.get(npc)!.stops, t, npc);
            byPlace.set(at, [...(byPlace.get(at) ?? []), npc]);
          }
          for (const [location, npcs] of byPlace) if (npcs.length >= 2) together.set(`${location}:${npcs.join(",")}`, { location, npcs });
        }
      }

      // Night: day-end, tomorrow's plan, then the save commits today.
      const townBefore = await store.loadTown(saveId);
      await post("/v1/day-end", { v: 1, saveId, playerName: PLAYER, day: gameDay(2200, "Farm"), events, together: [...together.values()].slice(0, 200) });
      const tomorrow = nextDay(date);
      const logMark = brainLog.length;
      const nextPlan: PlanResponse = await post("/v1/plan", { v: 1, saveId, playerName: PLAYER, day: tomorrow, stats: { farmName: "Sim", daysPlayed: n }, hearts: hearts() });
      await post("/v1/saved", { v: 1, saveId, day: date });
      const townAfter = await store.loadTown(saveId);
      out.push(...gossipLines(townBefore, townAfter), ...relationshipLines(townBefore, townAfter, today));
      // The planner's repeat guard, from the brain log of tomorrow's plan call (no timings in it).
      for (const m of brainLog.slice(logMark)) if (m.startsWith("plan regen for")) out.push(`Tomorrow's plan: ${m.slice("plan ".length)}.`);

      // Memory files, every day.
      const dir = join(stateDir, saveId);
      for (const f of await readdir(dir)) {
        if (f.startsWith("_") || !f.endsWith(".json")) continue;
        const size = (await stat(join(dir, f))).size;
        maxMemory = Math.max(maxMemory, size);
        // One farmer in this sim, so the single-player budget (32 KB) applies.
        if (size > fileBudget(1)) failures.memory.push(`${dateLabel(date)}: ${f} is ${size} bytes`);
        if (f !== `${CANARY_HOLDER}.json`) {
          const mem = JSON.stringify(await store.load(saveId, f.slice(0, -5)));
          if (mem.includes(CANARY)) leaks.push(`${dateLabel(date)}: memory file ${f}`);
        }
      }
      const canary = townAfter.facts.filter((f) => Object.values(f.knowers).some((k) => k.text.includes(CANARY)));
      for (const f of canary) for (const who of Object.keys(f.knowers)) if (who !== CANARY_HOLDER) leaks.push(`${dateLabel(date)}: ${who} knows the canary fact`);

      out.push("");
      today = nextPlan;
      date = tomorrow;
    }
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await rm(stateDir, { recursive: true, force: true });
  }

  const runs = CAST.map((npc) => ({ npc, run: longestIdenticalRun(signatures.get(npc)!) }));
  const worst = runs.reduce((a, b) => (b.run > a.run ? b : a));
  const regens = brainLog.filter((m) => m.startsWith("plan regen for")).length;
  const checks: Check[] = [
    { name: "memory files at most 32 KB every day", ok: failures.memory.length === 0, detail: failures.memory.length === 0 ? `largest ${maxMemory} bytes` : failures.memory.slice(0, 5).join("; ") },
    { name: "canary never leaves Emily", ok: leaks.length === 0, detail: leaks.length === 0 ? "no prompt, memory file or fact outside Emily carried it" : [...new Set(leaks)].slice(0, 5).join("; ") },
    {
      name: `no identical planned schedule on more than ${MAX_IDENTICAL_RUN} consecutive planned days`,
      ok: worst.run <= MAX_IDENTICAL_RUN,
      detail: `longest identical run ${worst.run} (${worst.npc}); planned days per NPC: ${CAST.map((n) => `${n} ${signatures.get(n)!.length}`).join(", ")}`,
    },
    opts.days >= GOALS_CHECK_DAYS
      ? { name: `at least ${MIN_GOALS} distinct goals started`, ok: goalsStarted.size >= MIN_GOALS, detail: `${goalsStarted.size} started, ${new Set(goalsFinished).size} finished` }
      : { name: `at least ${MIN_GOALS} distinct goals started (enforced from ${GOALS_CHECK_DAYS} days)`, ok: true, detail: `${goalsStarted.size} started in ${opts.days} days, not enforced` },
    { name: "every applied plan part passes the validator", ok: failures.validator.length === 0, detail: failures.validator.length === 0 ? "re-checked every day's plan" : failures.validator.slice(0, 5).join("; ") },
  ];
  out.push(
    "## Summary",
    "",
    `Days: ${opts.days}. Seed: ${opts.seed}. Model: ${inner.name}. Model calls: ${modelCalls}.`,
    `Plans: ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(", ")}. Parts dropped: ${drops}. Schedule regens: ${regens}.`,
    `Goals started (${goalsStarted.size}): ${[...goalsStarted].join("; ")}.`,
    "",
    ...checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`),
    "",
  );
  return { diary: out.join("\n"), checks, modelCalls, drops, regens, sources };
}

function gossipLines(before: TownState, after: TownState): string[] {
  const lines: string[] = [];
  const old = new Map(before.facts.map((f) => [f.id, f]));
  for (const f of after.facts) {
    for (const [who, k] of Object.entries(f.knowers)) {
      if (old.get(f.id)?.knowers[who] !== undefined) continue;
      if (k.source.kind === "heard") lines.push(`${who} heard from ${k.source.from} (hop ${k.hops}): ${k.text}`);
      else if (!old.has(f.id)) lines.push(`${who} ${k.source.kind === "told" ? `was told${f.shareable ? "" : " in confidence"}` : "saw"}: ${k.text}`);
    }
  }
  return [lines.length > 0 ? `Gossip and news overnight: ${lines.join(" | ")}` : "Gossip and news overnight: none."];
}

function relationshipLines(before: TownState, after: TownState, plan: PlanResponse): string[] {
  const moved = Object.keys(after.relationships)
    .sort()
    .filter((k) => after.relationships[k] !== before.relationships[k])
    .map((k) => {
      const [a, b] = k.split("|") as [string, string];
      const why = plan.relationships.find((r) => pairKey(r.a, r.b) === k)?.reason;
      const d = after.relationships[k]! - (before.relationships[k] ?? 0);
      return `${a}-${b} ${d > 0 ? "+" : ""}${d} to ${after.relationships[k]}${why ? ` (${why})` : ""}`;
    });
  return [moved.length > 0 ? `Relationships: ${moved.join("; ")}.` : "Relationships: no change."];
}

