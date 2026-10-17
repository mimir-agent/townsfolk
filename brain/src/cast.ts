// The planning cast and how they feel about each other at the start of a save.
// Scores run from -100 to 100. They are our own judgment of the characters, hand-written,
// not read from game data. Every pair is listed once; test/town.test.ts checks that.

export const CAST = ["Abigail", "Emily", "Gus", "Haley", "Lewis", "Pierre", "Robin", "Shane"] as const;
export type CastMember = (typeof CAST)[number];

export function isCast(npc: string): npc is CastMember {
  return (CAST as readonly string[]).includes(npc);
}

// One key per unordered pair, so A|B and B|A are the same relationship.
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

const STARTING: [CastMember, CastMember, number][] = [
  ["Abigail", "Emily", 20],
  ["Abigail", "Gus", 25],
  ["Abigail", "Haley", 5],
  ["Abigail", "Lewis", 10],
  ["Abigail", "Pierre", 35],
  ["Abigail", "Robin", 15],
  ["Abigail", "Shane", 0],
  ["Emily", "Gus", 45],
  ["Emily", "Haley", 50],
  ["Emily", "Lewis", 20],
  ["Emily", "Pierre", 15],
  ["Emily", "Robin", 20],
  ["Emily", "Shane", 25],
  ["Gus", "Haley", 10],
  ["Gus", "Lewis", 35],
  ["Gus", "Pierre", 30],
  ["Gus", "Robin", 30],
  ["Gus", "Shane", 40],
  ["Haley", "Lewis", 5],
  ["Haley", "Pierre", 10],
  ["Haley", "Robin", 10],
  ["Haley", "Shane", -25],
  ["Lewis", "Pierre", 30],
  ["Lewis", "Robin", 35],
  ["Lewis", "Shane", -5],
  ["Pierre", "Robin", 25],
  ["Pierre", "Shane", -30],
  ["Robin", "Shane", 5],
];

export function startingRelationships(): Record<string, number> {
  return Object.fromEntries(STARTING.map(([a, b, score]) => [pairKey(a, b), score]));
}
