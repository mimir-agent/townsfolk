// Per-NPC memory on disk: <stateDir>/<saveId>/<npc>.json.
// Each file holds only what that NPC took part in or witnessed (was in the same location).
//
// A day reaches memory in two steps. POST /v1/day-end stages it as the save's pending day
// (<stateDir>/<saveId>/_pending.json). POST /v1/saved for the same date commits it. A day
// the game never saved is replaced by the next day-end, or discarded by a saved call for a
// different date, so it is never remembered.
//
// Memory is tiered so it stays bounded however long the save runs:
//   entries  the last MAX_ENTRIES days, raw
//   seasons  one summary per season for the last MAX_SEASONS seasons, built from days
//            that rolled out of entries
//   years    one short summary of every season older than that
// fitToBudget then guarantees the serialized file is at most MAX_FILE_BYTES.
//
// The same commit also folds the day into the town state (<stateDir>/<saveId>/_town.json,
// see town.ts): new facts, then the night's gossip.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayEndRequest, DayEvent, DayRef, Season } from "./protocol.ts";
import { SEASONS } from "./protocol.ts";
import { seededRng, seedFrom } from "./rng.ts";
import { applyNight, emptyTown, type TownState } from "./town.ts";

export const MAX_ENTRIES = 14;
export const MAX_ENTRY_TEXT = 1200;
export const MAX_SEASON_SUMMARY = 700;
export const MAX_SEASONS = 8;
export const MAX_YEARS_SUMMARY = 1000;
export const MAX_FILE_BYTES = 32 * 1024;

export type MemoryEntry = { day: DayRef; text: string };
export type SeasonSummary = { season: Season; year: number; text: string };

export type NpcMemory = {
  version: 2;
  npc: string;
  // First day this NPC itself talked with or got a gift from the player. Witnessing does not count.
  firstMet: string | null;
  talks: number;
  gifts: number;
  years: string;
  seasons: SeasonSummary[];
  entries: MemoryEntry[];
};

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

export type Role = "participant" | "witness";
export type Witnessed = { event: DayEvent; role: Role };

export function emptyMemory(npc: string): NpcMemory {
  return { version: 2, npc, firstMet: null, talks: 0, gifts: 0, years: "", seasons: [], entries: [] };
}

export function dateLabel(d: DayRef): string {
  return `${d.season} ${d.day}, year ${d.year}`;
}

function clock(time: number): string {
  const h = Math.floor(time / 100);
  const m = time % 100;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")}${h % 24 < 12 ? "am" : "pm"}`;
}

// One line per event, from this NPC's point of view. A witness sees that a talk happened but
// did not hear it, and sees a gift handed over but not how the receiver felt about it.
// The key collapses repeats: a witness saw one conversation, not one per turn.
function describe(e: DayEvent, role: Role, player: string): { key: string; line: string } {
  if (role === "witness") {
    if (e.type === "gift") return { key: `wg:${e.npc}:${e.item}`, line: `I saw ${player} give ${e.npc} ${e.item} at ${e.location}, ${clock(e.time)}.` };
    return { key: `wt:${e.npc}:${e.location}`, line: `I saw ${player} talking with ${e.npc} at ${e.location}, ${clock(e.time)}.` };
  }
  if (e.type === "gift") {
    const taste = e.taste ? ` (${e.taste})` : "";
    const line = `${player} gave me ${e.item}${taste} at ${e.location}, ${clock(e.time)}.`;
    return { key: line, line };
  }
  const reply = e.playerChoice ? ` ${player} answered: "${e.playerChoice}".` : "";
  const line = `At ${e.location}, ${clock(e.time)}, I said: "${e.npcLine}".${reply}`;
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
    for (const w of event.witnesses) add(w, { event, role: "witness" });
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

function foldOldestSeason(mem: NpcMemory): NpcMemory {
  const [s, ...seasons] = mem.seasons;
  if (s === undefined) return mem;
  return { ...mem, seasons, years: appendBounded(mem.years, `${s.season} year ${s.year}: ${firstSentence(s.text)}`, MAX_YEARS_SUMMARY) };
}

function rollOldestEntry(mem: NpcMemory): NpcMemory {
  const [old, ...entries] = mem.entries;
  if (old === undefined) return mem;
  const seasons = [...mem.seasons];
  const last = seasons.at(-1);
  const piece = `${old.day.day}: ${firstSentence(old.text)}`;
  if (last && last.season === old.day.season && last.year === old.day.year) {
    seasons[seasons.length - 1] = { ...last, text: appendBounded(last.text, piece, MAX_SEASON_SUMMARY) };
  } else {
    seasons.push({ season: old.day.season, year: old.day.year, text: appendBounded("", piece, MAX_SEASON_SUMMARY) });
  }
  let next: NpcMemory = { ...mem, seasons, entries };
  while (next.seasons.length > MAX_SEASONS) next = foldOldestSeason(next);
  return next;
}

export function fileBytes(mem: NpcMemory): number {
  return Buffer.byteLength(JSON.stringify(mem, null, 2));
}

// The tier caps count characters and keep plain text near 24 KB. JSON escaping and multi-byte
// characters make bytes exceed characters, so the ceiling is enforced here, in bytes. With no
// entries and no seasons left the file is the years summary alone (at most 1000 chars), so the
// loop always ends.
export function fitToBudget(mem: NpcMemory): NpcMemory {
  let m = mem;
  while (fileBytes(m) > MAX_FILE_BYTES && (m.entries.length > 0 || m.seasons.length > 0)) {
    m = m.entries.length > 0 ? rollOldestEntry(m) : foldOldestSeason(m);
  }
  return m;
}

// Pure: folds one day's share of events for one NPC into that NPC's memory.
export function applyDay(mem: NpcMemory, day: DayRef, share: Witnessed[], player: string): NpcMemory {
  if (share.length === 0) return mem;
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const { event, role } of share) {
    const { key, line } = describe(event, role, player);
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  const own = share.filter((w) => w.role === "participant").map((w) => w.event);
  let next: NpcMemory = {
    ...mem,
    firstMet: mem.firstMet ?? (own.length > 0 ? dateLabel(day) : null),
    talks: mem.talks + own.filter((e) => e.type === "talk").length,
    gifts: mem.gifts + own.filter((e) => e.type === "gift").length,
    entries: [...mem.entries, { day: { season: day.season, day: day.day, year: day.year }, text: cap(lines.join(" "), MAX_ENTRY_TEXT) }],
  };
  while (next.entries.length > MAX_ENTRIES) next = rollOldestEntry(next);
  return fitToBudget(next);
}

const V1_LABEL = /^(spring|summer|fall|winter) (\d{1,2}), year (\d+)$/;

// Tonight's files keep their raw days; their one rolling summary becomes the years summary.
export function migrateV1(old: NpcMemoryV1): NpcMemory {
  const entries = old.entries.map((e): MemoryEntry => {
    const m = V1_LABEL.exec(e.date);
    if (!m) throw new Error(`v1 memory for ${old.npc} has an unreadable date "${e.date}"`);
    return { day: { season: m[1] as Season, day: Number(m[2]), year: Number(m[3]) }, text: cap(e.text, MAX_ENTRY_TEXT) };
  });
  return fitToBudget({
    ...emptyMemory(old.npc),
    firstMet: old.firstMet,
    talks: old.talks,
    gifts: old.gifts,
    years: appendBounded("", old.summary, MAX_YEARS_SUMMARY),
    entries,
  });
}

export type PendingDay = Omit<DayEndRequest, "v">;
export type CommitResult = { outcome: "committed" | "nothing-pending" | "stale-discarded"; committed: string[] };

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
    const raw = (await this.readJson(this.path(saveId, npc))) as NpcMemory | NpcMemoryV1 | null;
    if (raw === null) return emptyMemory(npc);
    if (raw.version === 2) return raw;
    if (raw.version === 1) return migrateV1(raw);
    throw new Error(`memory file for ${npc} has unknown version ${String((raw as { version: unknown }).version)}`);
  }

  async save(saveId: string, mem: NpcMemory): Promise<void> {
    await this.writeJson(saveId, this.path(saveId, mem.npc), mem);
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
      for (const [npc, list] of share) {
        await this.save(saveId, applyDay(await this.load(saveId, npc), p.day, list, p.playerName));
      }
      // The night's dice are seeded by save and date, so replaying a save replays its gossip.
      const rng = seededRng(seedFrom(`${saveId}:${dayKey(p.day)}`));
      await this.saveTown(saveId, applyNight(await this.loadTown(saveId), p, rng));
      await rm(this.pendingPath(saveId));
      return { outcome: "committed", committed: [...share.keys()] };
    });
  }
}
