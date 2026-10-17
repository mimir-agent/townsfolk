// Per-NPC memory on disk: <stateDir>/<saveId>/<npc>.json.
// Each file holds only what that NPC witnessed. It is bounded: the last MAX_ENTRIES day
// digests stay raw; older digests are folded into a summary capped at MAX_SUMMARY chars.

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DayEvent, GameDay } from "./protocol.ts";

export const MAX_ENTRIES = 14;
export const MAX_SUMMARY = 1200;

export type MemoryEntry = { date: string; text: string };

export type NpcMemory = {
  version: 1;
  npc: string;
  firstMet: string | null;
  talks: number;
  gifts: number;
  summary: string;
  entries: MemoryEntry[];
};

export function emptyMemory(npc: string): NpcMemory {
  return { version: 1, npc, firstMet: null, talks: 0, gifts: 0, summary: "", entries: [] };
}

export function dateLabel(d: GameDay): string {
  return `${d.season} ${d.day}, year ${d.year}`;
}

function clock(time: number): string {
  const h = Math.floor(time / 100);
  const m = time % 100;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}:${String(m).padStart(2, "0")}${h % 24 < 12 ? "am" : "pm"}`;
}

// One line per event, written from the NPC's point of view.
function describe(e: DayEvent, player: string): string {
  if (e.type === "gift") {
    const taste = e.taste ? ` (${e.taste})` : "";
    return `${player} gave me ${e.item}${taste} at ${e.location}, ${clock(e.time)}.`;
  }
  const reply = e.playerChoice ? ` ${player} answered: "${e.playerChoice}".` : "";
  return `At ${e.location}, ${clock(e.time)}, I said: "${e.npcLine}".${reply}`;
}

// Pure: folds one day's events for one NPC into that NPC's memory.
export function applyDay(mem: NpcMemory, day: GameDay, events: DayEvent[], player: string): NpcMemory {
  if (events.length === 0) return mem;
  const date = dateLabel(day);
  const text = events.map((e) => describe(e, player)).join(" ");
  const entries = [...mem.entries, { date, text }];
  let summary = mem.summary;
  while (entries.length > MAX_ENTRIES) {
    const old = entries.shift()!;
    summary = foldIntoSummary(summary, old);
  }
  return {
    ...mem,
    firstMet: mem.firstMet ?? date,
    talks: mem.talks + events.filter((e) => e.type === "talk").length,
    gifts: mem.gifts + events.filter((e) => e.type === "gift").length,
    summary,
    entries,
  };
}

// Older days shrink to their first sentence, and the summary keeps only its newest
// MAX_SUMMARY chars, so the file size has a fixed ceiling however long the save runs.
function foldIntoSummary(summary: string, entry: MemoryEntry): string {
  const firstSentence = entry.text.split(/(?<=\.)\s/)[0] ?? entry.text;
  const next = `${summary}${summary ? " " : ""}${entry.date}: ${firstSentence}`;
  if (next.length <= MAX_SUMMARY) return next;
  const cut = next.slice(next.length - MAX_SUMMARY);
  const boundary = cut.indexOf(" ");
  return boundary === -1 ? cut : cut.slice(boundary + 1);
}

export class MemoryStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private path(saveId: string, npc: string): string {
    return join(this.dir, saveId, `${npc}.json`);
  }

  async load(saveId: string, npc: string): Promise<NpcMemory> {
    let raw: string;
    try {
      raw = await readFile(this.path(saveId, npc), "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyMemory(npc);
      throw err;
    }
    return JSON.parse(raw) as NpcMemory;
  }

  async save(saveId: string, mem: NpcMemory): Promise<void> {
    const file = this.path(saveId, mem.npc);
    await mkdir(join(this.dir, saveId), { recursive: true });
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(mem, null, 2));
    await rename(tmp, file);
  }

  // Groups events by NPC so each NPC's file only ever receives its own events.
  async recordDay(saveId: string, day: GameDay, events: DayEvent[], player: string): Promise<string[]> {
    const byNpc = new Map<string, DayEvent[]>();
    for (const e of events) {
      const list = byNpc.get(e.npc) ?? [];
      list.push(e);
      byNpc.set(e.npc, list);
    }
    for (const [npc, list] of byNpc) {
      const mem = await this.load(saveId, npc);
      await this.save(saveId, applyDay(mem, day, list, player));
    }
    return [...byNpc.keys()];
  }
}
