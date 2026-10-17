// Which game stats each NPC may know. The bridge sends every stat it can read; this table is an
// allowlist, applied before any prompt is built. A stat not listed for an NPC never reaches that
// NPC's prompt. Money is listed for nobody. Season and weather are in every prompt's date line.

import type { GameStats } from "./protocol.ts";

type StatKey = keyof GameStats;

export const KNOWN_BY_EVERYONE: readonly StatKey[] = ["farmName", "daysPlayed"];

export const KNOWN_BY: Readonly<Record<string, readonly StatKey[]>> = {
  Lewis: ["communityCenterRooms"],
  Abigail: ["deepestMineLevel"],
  Robin: ["farmBuildings"],
};

export function statsFor(npc: string, stats: GameStats): GameStats {
  const allowed = new Set<StatKey>([...KNOWN_BY_EVERYONE, ...(KNOWN_BY[npc] ?? [])]);
  return Object.fromEntries(Object.entries(stats).filter(([k]) => allowed.has(k as StatKey))) as GameStats;
}

// One line per stat, worded for the prompt.
export function describeStats(s: GameStats): string[] {
  const lines: string[] = [];
  if (s.farmName !== undefined) lines.push(`The farm is called ${s.farmName} Farm.`);
  if (s.daysPlayed !== undefined) lines.push(`The farmer has lived in the valley for ${s.daysPlayed} days.`);
  if (s.communityCenterRooms !== undefined) lines.push(`Community center rooms restored: ${s.communityCenterRooms} of 6.`);
  if (s.deepestMineLevel !== undefined) lines.push(`Deepest mine level the farmer has reached: ${s.deepestMineLevel}.`);
  if (s.farmBuildings !== undefined) {
    lines.push(s.farmBuildings.length > 0 ? `Buildings on the farm: ${s.farmBuildings.join(", ")}.` : "There are no buildings on the farm yet.");
  }
  if (s.money !== undefined) lines.push(`The farmer has ${s.money}g.`);
  return lines;
}
