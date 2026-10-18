// The planning cast: the 8 villagers the overnight plan schedules. How every roster villager feels
// about every other one at the start of a save is in graph.ts.

export const CAST = ["Abigail", "Emily", "Gus", "Haley", "Lewis", "Pierre", "Robin", "Shane"] as const;
export type CastMember = (typeof CAST)[number];

export function isCast(npc: string): npc is CastMember {
  return (CAST as readonly string[]).includes(npc);
}

// One key per unordered pair, so A|B and B|A are the same relationship.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
