// Per-NPC memory on disk: <stateDir>/<saveId>/<npc>.json.
// Each file holds only what that NPC took part in or witnessed (was in the same location).
//
// A day reaches memory in two steps. POST /v1/day-end stages it as the save's pending day
// (<stateDir>/<saveId>/_pending.json). POST /v1/saved for the same date commits it. A day
// the game never saved is replaced by the next day-end, or discarded by a saved call for a
// different date, so it is never remembered.
//
// A file holds one section per farmer the NPC has met or seen, keyed by farmerId (protocol.ts
// FarmerRef; MAIN_FARMER for a request without one). Sections never mix: an event lands only in
// the section of the farmer it happened with.
//
// Each section is tiered so it stays bounded however long the save runs:
//   entries  the last MAX_ENTRIES days, raw
//   seasons  one summary per season for the last MAX_SEASONS seasons, built from days
//            that rolled out of entries
//   years    one short summary of every season older than that
// fitToBudget then guarantees each section is at most sectionBudget(farmers) bytes and the
// file at most fileBudget(farmers): 32 KB for one farmer, never over MAX_FILE_BYTES.
//
// The same commit also folds the day into the town state (<stateDir>/<saveId>/_town.json,
// see town.ts): new facts, then the night's gossip.

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayEndRequest, DayEvent, DayRef, FarmerRef, Season, VanillaReason } from "./protocol.ts";
import { MAIN_FARMER, SEASONS } from "./protocol.ts";
import { seededRng, seedFrom } from "./rng.ts";
import { emptyPlans, recordNight, type Night, type PlanState } from "./plan.ts";
import { isPrivateScene, sceneLine } from "./scenes.ts";
import { applyNight, emptyTown, renameFarmer, type TownState } from "./town.ts";
import type { World } from "./validate.ts";

export const MAX_ENTRIES = 14;
export const MAX_ENTRY_TEXT = 1200;
export const MAX_SEASON_SUMMARY = 700;
export const MAX_SEASONS = 8;
export const MAX_YEARS_SUMMARY = 1000;
export const MAX_SECTION_BYTES = 32 * 1024;
export const MAX_FILE_BYTES = 64 * 1024;

export type MemoryEntry = { day: DayRef; text: string };
export type SeasonSummary = { season: Season; year: number; text: string };

// What one NPC remembers of one farmer.
export type FarmerMemory = {
  // The name the farmer had on the last committed day with them. Empty for a section carried
  // over from a v2 file until a day with that farmer is committed.
  farmerName: string;
  // First day this NPC itself talked with or got a gift from this farmer. Witnessing does not count.
  firstMet: string | null;
  talks: number;
  gifts: number;
  years: string;
  seasons: SeasonSummary[];
  entries: MemoryEntry[];
};

export type NpcMemory = {
  version: 3;
  npc: string;
  farmers: Record<string, FarmerMemory>;
};

// The single-farmer format. Read and converted on load to farmers[MAIN_FARMER]; never written.
export type NpcMemoryV2 = Omit<FarmerMemory, "farmerName"> & { version: 2; npc: string };

// The file format the tonight slice wrote. Read and converted on load; never written.
export type NpcMemoryV1 = {
  version: 1;
  npc: string;
  firstMet: string | null;
  talks: number;
  gifts: number;
  summary: string;
  entries: { date: string; text: string }[];
};

// Leads a private scene's line in an actor's memory (scenes.ts PRIVATE_SCENES).
export const PRIVATE_MARK = "(Private, I keep this to myself)";

export type Role = "participant" | "witness";
export type Witnessed = { event: DayEvent; role: Role };

export function emptyMemory(npc: string): NpcMemory {
  return { version: 3, npc, farmers: {} };
}

export function emptySection(farmerName: string): FarmerMemory {
  return { farmerName, firstMet: null, talks: 0, gifts: 0, years: "", seasons: [], entries: [] };
}

// The memory section a request or event belongs to. One without farmerId is the main farmer's:
// hostKey is MAIN_FARMER until a world request names the host, then the host's farmerId
// (MemoryStore.hostKey).
export function farmerKey(ref: FarmerRef, hostKey: string): string {
  return ref.farmerId ?? hostKey;
}

// This NPC's section for one farmer; an empty one when the NPC has no history with them.
export function sectionFor(mem: NpcMemory, key: string): FarmerMemory {
  return mem.farmers[key] ?? emptySection("");
}

export function dateLabel(d: DayRef): string {
  return `${d.season} ${d.day}, year ${d.year}`;
}

export function clock(time: number): string {
  const h = Math.floor(time / 100);
  const m = time % 100;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")}${h % 24 < 12 ? "am" : "pm"}`;
}

const CHAT_LINES: Record<VanillaReason, string> = {
  "first-meeting": "met for the first time",
  quest: "talked about an errand",
  birthday: "talked on my birthday",
  story: "talked",
};

// One line per event, from this NPC's point of view. A witness sees that a talk happened but
// did not hear it, and sees a gift handed over but not how the receiver felt about it.
// The key collapses repeats: a witness saw one conversation, not one per turn.
// festival: the calendar name of today's festival, when the world snapshot has one (scenes.ts).
function describe(e: DayEvent, role: Role, player: string, npc: string, festival: string | undefined): { key: string; line: string } {
  // Every actor in a scene took part in it, and each tells it from its own side.
  if (e.type === "scene") {
    const line = sceneLine(e, npc, player, festival);
    // The mark leads the line, so it survives when the day is cut to its first sentence for the
    // season summary.
    return { key: `s:${e.eventId}`, line: isPrivateScene(e.eventId) ? `${PRIVATE_MARK} ${line}` : line };
  }
  // Everyone in a happening was part of it, so the one the player spoke to and the others
  // remember the join the same way.
  if (e.type === "join") {
    const line = `${player} joined us at ${e.location}, ${clock(e.time)}: ${e.topic}.`;
    return { key: `j:${e.location}:${e.topic}`, line };
  }
  if (role === "witness") {
    if (e.type === "gift") return { key: `wg:${e.npc}:${e.item}`, line: `I saw ${player} give ${e.npc} ${e.item} at ${e.location}, ${clock(e.time)}.` };
    return { key: `wt:${e.npc}:${e.location}`, line: `I saw ${player} talking with ${e.npc} at ${e.location}, ${clock(e.time)}.` };
  }
  if (e.type === "gift") {
    const taste = e.taste ? ` (${e.taste})` : "";
    const line = `${player} gave me ${e.item}${taste} at ${e.location}, ${clock(e.time)}.`;
    return { key: line, line };
  }
  // The game's own lines were shown and are not sent, so memory keeps only that they talked.
  if (e.type === "chat") {
    const line = `${player} and I ${CHAT_LINES[e.reason]} at ${e.location}, ${clock(e.time)}.`;
    return { key: line, line };
  }
  if (e.type === "said") {
    const line = `At ${e.location}, ${clock(e.time)}, I said (game line) to ${player}: "${e.line}"`;
    return { key: line, line };
  }
  const reply = e.playerChoice ? ` ${player} answered: "${e.playerChoice}".` : "";
  const fact = e.fact ? ` I will remember: ${e.fact.text}${e.fact.shareable ? "" : " (told in confidence)"}` : "";
  const line = `At ${e.location}, ${clock(e.time)}, I said: "${e.npcLine}".${reply}${fact}`;
  return { key: line, line };
}

// Splits a day's events into each NPC's share: the events it took part in or witnessed.
export function shareByNpc(events: DayEvent[]): Map<string, Witnessed[]> {
  const byNpc = new Map<string, Witnessed[]>();
  const add = (npc: string, w: Witnessed) => {
    const list = byNpc.get(npc) ?? [];
    list.push(w);
    byNpc.set(npc, list);
  };
  for (const event of events) {
    add(event.npc, { event, role: "participant" });
    // A scene's witnesses are its other actors: they were in it, not watching it.
    for (const w of event.witnesses) add(w, { event, role: event.type === "scene" ? "participant" : "witness" });
  }
  return byNpc;
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function firstSentence(text: string): string {
  return text.split(/(?<=\.)\s/)[0] ?? text;
}

// Appends to a summary and keeps only its newest `max` chars, cut at a word boundary.
function appendBounded(summary: string, piece: string, max: number): string {
  const next = `${summary}${summary ? " " : ""}${piece}`;
  if (next.length <= max) return next;
  const cut = next.slice(next.length - max);
  const boundary = cut.indexOf(" ");
  return boundary === -1 ? cut : cut.slice(boundary + 1);
}

function foldOldestSeason(sec: FarmerMemory): FarmerMemory {
  const [s, ...seasons] = sec.seasons;
  if (s === undefined) return sec;
  return { ...sec, seasons, years: appendBounded(sec.years, `${s.season} year ${s.year}: ${firstSentence(s.text)}`, MAX_YEARS_SUMMARY) };
}

function rollOldestEntry(sec: FarmerMemory): FarmerMemory {
  const [old, ...entries] = sec.entries;
  if (old === undefined) return sec;
  const seasons = [...sec.seasons];
  const last = seasons.at(-1);
  const piece = `${old.day.day}: ${firstSentence(old.text)}`;
  if (last && last.season === old.day.season && last.year === old.day.year) {
    seasons[seasons.length - 1] = { ...last, text: appendBounded(last.text, piece, MAX_SEASON_SUMMARY) };
  } else {
    seasons.push({ season: old.day.season, year: old.day.year, text: appendBounded("", piece, MAX_SEASON_SUMMARY) });
  }
  let next: FarmerMemory = { ...sec, seasons, entries };
  while (next.seasons.length > MAX_SEASONS) next = foldOldestSeason(next);
  return next;
}

// One step of shrinking a section: roll its oldest raw day into its season summary, or fold its
// oldest season into the years summary. Null when only the years summary is left.
function shrink(sec: FarmerMemory): FarmerMemory | null {
  if (sec.entries.length > 0) return rollOldestEntry(sec);
  if (sec.seasons.length > 0) return foldOldestSeason(sec);
  return null;
}

export function fileBytes(mem: NpcMemory): number {
  return Buffer.byteLength(JSON.stringify(mem, null, 2));
}

// The bytes one section takes inside the file as written: its key, its body at the file's
// indentation, and the separator.
export function sectionBytes(mem: NpcMemory, key: string): number {
  const sec = mem.farmers[key];
  if (sec === undefined) return 0;
  const body = JSON.stringify(sec, null, 2).replaceAll("\n", "\n    ");
  return Buffer.byteLength(`    ${JSON.stringify(key)}: ${body},\n`);
}

// min(32 KB, 64 KB / farmers): single player keeps 32 KB, four farmers get 16 KB each.
export function sectionBudget(farmers: number): number {
  return Math.min(MAX_SECTION_BYTES, Math.floor(MAX_FILE_BYTES / Math.max(1, farmers)));
}

// The whole file: 32 KB with one farmer, as before multiplayer; 64 KB from two farmers on.
export function fileBudget(farmers: number): number {
  return Math.min(MAX_FILE_BYTES, Math.max(1, farmers) * MAX_SECTION_BYTES);
}

// The tier caps count characters and keep plain text near 24 KB per section. JSON escaping and
// multi-byte characters make bytes exceed characters, so the ceilings are enforced here, in
// bytes. First each section is brought under sectionBudget; then, while the whole file (its
// header included) is over fileBudget, the largest section that can still shrink gives way.
// A section with nothing left but its years summary is under 1.5 KB and a save has at most
// MAX_FARMERS of them, so the file always fits before every section runs out of steps.
export function fitToBudget(mem: NpcMemory): NpcMemory {
  const keys = Object.keys(mem.farmers);
  const farmers = { ...mem.farmers };
  const m: NpcMemory = { ...mem, farmers };
  const perSection = sectionBudget(keys.length);
  for (const key of keys) {
    while (sectionBytes(m, key) > perSection) {
      const next = shrink(farmers[key]!);
      if (next === null) break;
      farmers[key] = next;
    }
  }
  const perFile = fileBudget(keys.length);
  while (fileBytes(m) > perFile) {
    const largest = keys
      .filter((k) => farmers[k]!.entries.length > 0 || farmers[k]!.seasons.length > 0)
      .sort((a, b) => sectionBytes(m, b) - sectionBytes(m, a))[0];
    if (largest === undefined) break;
    farmers[largest] = shrink(farmers[largest]!)!;
  }
  return m;
}

// Pure: folds one day's share for one farmer into that farmer's section. `farmer` is the name
// the lines use.
function applySection(sec: FarmerMemory, day: DayRef, share: Witnessed[], farmer: string, npc: string, festival: string | undefined): FarmerMemory {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { event, role } of share) {
    const { key, line } = describe(event, role, farmer, npc, festival);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  // Being in a scene the farmer watched is not meeting them.
  const own = share.filter((w) => w.role === "participant" && w.event.type !== "scene").map((w) => w.event);
  let next: FarmerMemory = {
    ...sec,
    farmerName: farmer,
    firstMet: sec.firstMet ?? (own.length > 0 ? dateLabel(day) : null),
    talks: sec.talks + own.filter((e) => e.type === "talk" || e.type === "chat").length,
    gifts: sec.gifts + own.filter((e) => e.type === "gift").length,
    entries: [...sec.entries, { day: { season: day.season, day: day.day, year: day.year }, text: cap(lines.join(" "), MAX_ENTRY_TEXT) }],
  };
  while (next.entries.length > MAX_ENTRIES) next = rollOldestEntry(next);
  return next;
}

// Pure: folds one day's share of events for one NPC into that NPC's memory. Each event lands in
// the section of the farmer it happened with. An event without farmerId is the main farmer's:
// it goes to hostKey (see farmerKey) and its lines use `player`, the day's playerName.
// festival: today's festival name from the world snapshot, for festival scene lines.
export function applyDay(
  mem: NpcMemory,
  day: DayRef,
  share: Witnessed[],
  player: string,
  hostKey: string = MAIN_FARMER,
  festival?: string,
): NpcMemory {
  if (share.length === 0) return mem;
  const byFarmer = new Map<string, { name: string; list: Witnessed[] }>();
  for (const w of share) {
    const key = farmerKey(w.event, hostKey);
    const group = byFarmer.get(key) ?? { name: w.event.farmerName ?? player, list: [] };
    group.list.push(w);
    byFarmer.set(key, group);
  }
  const farmers = { ...mem.farmers };
  for (const [key, { name, list }] of byFarmer) farmers[key] = applySection(farmers[key] ?? emptySection(name), day, list, name, mem.npc, festival);
  return fitToBudget({ ...mem, farmers });
}

const V1_LABEL = /^(spring|summer|fall|winter) (\d{1,2}), year (\d+)$/;

// Tonight's files keep their raw days; their one rolling summary becomes the years summary.
export function migrateV1(old: NpcMemoryV1): NpcMemory {
  const entries = old.entries.map((e): MemoryEntry => {
    const m = V1_LABEL.exec(e.date);
    if (!m) throw new Error(`v1 memory for ${old.npc} has an unreadable date "${e.date}"`);
    return { day: { season: m[1] as Season, day: Number(m[2]), year: Number(m[3]) }, text: cap(e.text, MAX_ENTRY_TEXT) };
  });
  const main: FarmerMemory = {
    ...emptySection(""),
    firstMet: old.firstMet,
    talks: old.talks,
    gifts: old.gifts,
    years: appendBounded("", old.summary, MAX_YEARS_SUMMARY),
    entries,
  };
  return fitToBudget({ ...emptyMemory(old.npc), farmers: { [MAIN_FARMER]: main } });
}

// A v2 file is one farmer's memory, the single-player main farmer's: it becomes that section as is.
export function migrateV2(old: NpcMemoryV2): NpcMemory {
  const { version: _v, npc, ...section } = old;
  return fitToBudget({ ...emptyMemory(npc), farmers: { [MAIN_FARMER]: { farmerName: "", ...section } } });
}

// Which farmerId a request without one stands for. Written once a world request names the host.
type HostFile = { version: 1; hostFarmerId: string };

export type PendingDay = Omit<DayEndRequest, "v">;
export type CommitResult = { outcome: "committed" | "nothing-pending" | "stale-discarded"; committed: string[] };

// The calendar name of the festival on this date, from the world snapshot. Undefined when the
// bridge has sent no snapshot yet or there is no festival that day.
export function festivalOn(world: World | null, d: DayRef): string | undefined {
  return world?.festivals.find((f) => f.season === d.season && f.day === d.day)?.name;
}

export function dayKey(d: DayRef): number {
  return (d.year - 1) * 112 + SEASONS.indexOf(d.season) * 28 + (d.day - 1);
}

export class MemoryStore {
  readonly dir: string;
  // Requests for one save run one at a time, so a commit never races the stage it commits.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(dir: string) {
    this.dir = dir;
  }

  private path(saveId: string, npc: string): string {
    return join(this.dir, saveId, `${npc}.json`);
  }

  // NPC names must start with a letter or digit (protocol.ts), so this file cannot collide with one.
  private pendingPath(saveId: string): string {
    return join(this.dir, saveId, "_pending.json");
  }

  private townPath(saveId: string): string {
    return join(this.dir, saveId, "_town.json");
  }

  async loadTown(saveId: string): Promise<TownState> {
    const raw = (await this.readJson(this.townPath(saveId))) as TownState | null;
    if (raw === null) return emptyTown();
    if (raw.version !== 1) throw new Error(`town file for ${saveId} has unknown version ${String((raw as { version: unknown }).version)}`);
    return raw;
  }

  async saveTown(saveId: string, town: TownState): Promise<void> {
    await this.writeJson(saveId, this.townPath(saveId), town);
  }

  // The world snapshot the bridge sent at save load. Null until it has sent one.
  async loadWorld(saveId: string): Promise<World | null> {
    return (await this.readJson(join(this.dir, saveId, "_world.json"))) as World | null;
  }

  saveWorld(saveId: string, world: World): Promise<void> {
    return this.serial(saveId, () => this.writeJson(saveId, join(this.dir, saveId, "_world.json"), world));
  }

  async loadPlans(saveId: string): Promise<PlanState> {
    const raw = (await this.readJson(this.plansPath(saveId))) as PlanState | null;
    if (raw === null) return emptyPlans();
    if (raw.version !== 1) throw new Error(`plans file for ${saveId} has unknown version ${String((raw as { version: unknown }).version)}`);
    return raw;
  }

  // Read, record and write under the save's queue. The model call happens outside it, so a long
  // plan never holds up a saved call; two plans for the same save at once: the later one wins.
  recordPlan(saveId: string, night: Night): Promise<void> {
    return this.serial(saveId, async () => {
      await this.writeJson(saveId, this.plansPath(saveId), recordNight(await this.loadPlans(saveId), night));
    });
  }

  private plansPath(saveId: string): string {
    return join(this.dir, saveId, "_plans.json");
  }

  private serial<T>(saveId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(saveId) ?? Promise.resolve()).then(fn);
    this.queues.set(saveId, run.catch(() => {}));
    return run;
  }

  private async readJson(file: string): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private async writeJson(saveId: string, file: string, value: unknown): Promise<void> {
    await mkdir(join(this.dir, saveId), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(value, null, 2));
    await rename(tmp, file);
  }

  async load(saveId: string, npc: string): Promise<NpcMemory> {
    const raw = (await this.readJson(this.path(saveId, npc))) as NpcMemory | NpcMemoryV2 | NpcMemoryV1 | null;
    if (raw === null) return emptyMemory(npc);
    if (raw.version === 3) return raw;
    if (raw.version === 2) return migrateV2(raw);
    if (raw.version === 1) return migrateV1(raw);
    throw new Error(`memory file for ${npc} has unknown version ${String((raw as { version: unknown }).version)}`);
  }

  async save(saveId: string, mem: NpcMemory): Promise<void> {
    await this.writeJson(saveId, this.path(saveId, mem.npc), mem);
  }

  private hostPath(saveId: string): string {
    return join(this.dir, saveId, "_host.json");
  }

  // The section key for a request without farmerId: the host's farmerId once a world request
  // has named it, MAIN_FARMER before. Kept in its own file, so a later world request without
  // hostFarmerId does not split the host's history back into MAIN_FARMER.
  async hostKey(saveId: string): Promise<string> {
    const raw = (await this.readJson(this.hostPath(saveId))) as HostFile | null;
    if (raw === null) return MAIN_FARMER;
    if (raw.version !== 1) throw new Error(`host file for ${saveId} has unknown version ${String((raw as { version: unknown }).version)}`);
    return raw.hostFarmerId;
  }

  // A world request named the host. Every NPC file's MAIN_FARMER section (single-player history,
  // including files from before multiplayer) moves to hostId, and requests without farmerId use
  // hostId from now on. Runs on every world request with a host and is a no-op once nothing is
  // under MAIN_FARMER. An NPC that already has a hostId section keeps both sections as they
  // are and is listed in `kept`: merging two histories is not something this slice decides.
  setHost(saveId: string, hostId: string): Promise<{ moved: string[]; kept: string[] }> {
    return this.serial(saveId, async () => {
      const moved: string[] = [];
      const kept: string[] = [];
      let files: string[] = [];
      try {
        files = await readdir(join(this.dir, saveId));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      // NPC names start with a letter or digit (protocol.ts), so a _ file is never an NPC's.
      for (const f of files.filter((x) => x.endsWith(".json") && !x.startsWith("_")).sort()) {
        const mem = await this.load(saveId, f.slice(0, -".json".length));
        const { [MAIN_FARMER]: main, ...others } = mem.farmers;
        if (main === undefined) continue;
        if (others[hostId] !== undefined) {
          kept.push(mem.npc);
          continue;
        }
        await this.save(saveId, { ...mem, farmers: { ...others, [hostId]: main } });
        moved.push(mem.npc);
      }
      // Town facts about the single-player farmer are about the host too.
      const town = await this.loadTown(saveId);
      const renamed = renameFarmer(town, MAIN_FARMER, hostId);
      if (renamed !== town) await this.saveTown(saveId, renamed);
      await this.writeJson(saveId, this.hostPath(saveId), { version: 1, hostFarmerId: hostId } satisfies HostFile);
      return { moved, kept };
    });
  }

  async pending(saveId: string): Promise<PendingDay | null> {
    return (await this.readJson(this.pendingPath(saveId))) as PendingDay | null;
  }

  // Replaces whatever day was pending. A day-end only follows an uncommitted one when the
  // player reloaded without saving (or the saved call never arrived), and that day must not
  // be remembered.
  stage(req: DayEndRequest): Promise<string[]> {
    return this.serial(req.saveId, async () => {
      const { v: _v, ...day } = req;
      await this.writeJson(req.saveId, this.pendingPath(req.saveId), day satisfies PendingDay);
      return [...shareByNpc(req.events).keys()];
    });
  }

  // Commits the pending day only when the save that finished is for that same date. A pending
  // day with any other date was never saved, so it is thrown away.
  commit(saveId: string, day: DayRef): Promise<CommitResult> {
    return this.serial(saveId, async () => {
      const p = await this.pending(saveId);
      if (p === null) return { outcome: "nothing-pending", committed: [] };
      if (dayKey(p.day) !== dayKey(day)) {
        await rm(this.pendingPath(saveId));
        return { outcome: "stale-discarded", committed: [] };
      }
      const share = shareByNpc(p.events);
      const hostKey = await this.hostKey(saveId);
      const festival = festivalOn(await this.loadWorld(saveId), p.day);
      for (const [npc, list] of share) {
        await this.save(saveId, applyDay(await this.load(saveId, npc), p.day, list, p.playerName, hostKey, festival));
      }
      // The night's dice are seeded by save and date, so replaying a save replays its gossip.
      const rng = seededRng(seedFrom(`${saveId}:${dayKey(p.day)}`));
      const planned = (await this.loadPlans(saveId)).nights.find((n) => dayKey(n.day) === dayKey(p.day));
      await this.saveTown(saveId, applyNight(await this.loadTown(saveId), p, rng, planned?.relationships ?? [], hostKey, festival));
      await rm(this.pendingPath(saveId));
      return { outcome: "committed", committed: [...share.keys()] };
    });
  }
}
