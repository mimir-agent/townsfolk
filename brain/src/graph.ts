// The town's social graph: the 34 giftable villagers and a starting score for every pair of them.
// Scores run from -100 to 100 and are undirected (A|B is B|A). They are judgment calls written in
// our own words from public wiki facts, not game data.
//
// Where a pair's starting score comes from, first match wins, and a pair may appear in only one
// layer (building the table throws otherwise, so no entry is ever silently overridden):
//   1. CANON2  the PAIR TABLE in ~/.hermes/goals/stardew/canon-2.md (Data, task t_daa63a0b,
//              2026-10-17), copied with its scores. Where it notes a one-sided feeling (A->B), the
//              plain undirected score is used, as that file says to for an undirected graph.
//   2. TIES    family and household ties from ~/.hermes/goals/stardew/roster.md (1a, 1b, section 4)
//              that canon-2 does not list, at the spec-v2 slice S defaults: spouses 60, parent and
//              child 35, siblings and housemates 40, named friends 30, Dwarf|Krobus -60.
//   3. CAST    the planning cast's pairs from the cast.ts table (before slice S) that canon-2 does not list,
//              kept as they were.
//   4. every other pair: DEFAULT_SEED.

import { pairKey } from "./cast.ts";

// roster.md 1a (12 marriage candidates) then 1b (22 other giftable villagers). Names as the game uses them.
export const ROSTER = [
  "Alex", "Elliott", "Harvey", "Sam", "Sebastian", "Shane", "Abigail", "Emily", "Haley", "Leah", "Maru", "Penny",
  "Caroline", "Clint", "Demetrius", "Dwarf", "Evelyn", "George", "Gus", "Jas", "Jodi", "Kent", "Krobus", "Leo",
  "Lewis", "Linus", "Marnie", "Pam", "Pierre", "Robin", "Sandy", "Vincent", "Willy", "Wizard",
] as const;

export type Villager = (typeof ROSTER)[number];

export function isRoster(npc: string): npc is Villager {
  return (ROSTER as readonly string[]).includes(npc);
}

export const DEFAULT_SEED = 5;

type Seed = [Villager, Villager, number];

// canon-2.md PAIR TABLE, all 71 rows, in its order.
const CANON2: Seed[] = [
  ["George", "Evelyn", 75],
  ["Jodi", "Vincent", 75],
  ["Alex", "Evelyn", 70],
  ["Sam", "Vincent", 70],
  ["Sam", "Sebastian", 70],
  ["Jas", "Vincent", 70],
  ["Jas", "Marnie", 70],
  ["Robin", "Demetrius", 65],
  ["Robin", "Maru", 65],
  ["Caroline", "Jodi", 65],
  ["Alex", "George", 60],
  ["Sam", "Jodi", 60],
  ["Maru", "Demetrius", 60],
  ["Jas", "Shane", 60],
  // Their romance is secret; the score says nothing about it to anyone who reads it.
  ["Lewis", "Marnie", 60],
  ["Abigail", "Sebastian", 60],
  ["Sam", "Abigail", 55],
  ["Emily", "Haley", 50],
  ["Penny", "Jas", 50],
  ["Penny", "Vincent", 50],
  ["Alex", "Haley", 45],
  ["Elliott", "Leah", 45],
  ["Penny", "Maru", 45],
  ["Harvey", "Maru", 45],
  ["Caroline", "Pierre", 45],
  ["Gus", "Emily", 45],
  ["Gus", "Pam", 45],
  ["Gus", "Shane", 40],
  ["Shane", "Marnie", 40],
  ["Sebastian", "Robin", 40],
  ["Elliott", "Willy", 35],
  ["Gus", "Lewis", 35],
  ["Sam", "Penny", 30],
  ["Clint", "Willy", 30],
  // Clint's crush on Emily is private to him (canon-2 marks it PRIVATE; roster.md: known to Clint
  // only). The graph keeps the plain friendly score, so nothing here gives the crush away.
  ["Clint", "Emily", 30],
  ["Gus", "Clint", 30],
  ["Gus", "Pierre", 30],
  ["Gus", "Robin", 30],
  ["Caroline", "Abigail", 25],
  ["Abigail", "Gus", 25],
  ["Emily", "Shane", 25],
  ["Lewis", "Robin", 25],
  ["Pierre", "Robin", 25],
  ["Gus", "Linus", 25],
  ["Caroline", "Marnie", 20],
  ["Caroline", "Robin", 20],
  ["Caroline", "Emily", 20],
  ["Jodi", "Marnie", 20],
  ["Jodi", "Robin", 20],
  ["Jodi", "Emily", 20],
  ["Marnie", "Emily", 20],
  ["Marnie", "Robin", 20],
  ["Abigail", "Emily", 20],
  ["Emily", "Robin", 20],
  ["Gus", "Willy", 20],
  ["Penny", "Pam", 20],
  ["Abigail", "Pierre", 15],
  ["Abigail", "Robin", 15],
  ["Lewis", "Pierre", 15],
  ["Linus", "Penny", 15],
  ["Linus", "Emily", 15],
  ["Harvey", "George", 10],
  ["Penny", "George", 10],
  ["Gus", "Haley", 10],
  ["Linus", "Robin", 5],
  ["Lewis", "Sam", 0],
  ["Haley", "Shane", 0],
  ["Maru", "Sebastian", 0],
  ["Linus", "George", -5],
  ["Pierre", "Shane", -10],
  ["Sebastian", "Demetrius", -15],
];

// roster.md ties canon-2 does not list (mostly villagers outside its 28: Kent, Leo, Sandy, Dwarf, Krobus).
const TIES: Seed[] = [
  ["Jodi", "Kent", 60], // spouses
  ["Kent", "Sam", 35], // father and son
  ["Kent", "Vincent", 35], // father and son
  ["Leo", "Jas", 30], // named friends
  ["Leo", "Vincent", 30], // named friends
  ["Leo", "Linus", 30], // named friends
  ["Leo", "Penny", 30], // she teaches him
  ["Emily", "Sandy", 30], // friends and pen pals
  ["Dwarf", "Krobus", -60], // an old war between their peoples
];

// The planning cast's own pairs that canon-2 does not list, as the cast table had them.
const CAST: Seed[] = [
  ["Abigail", "Haley", 5],
  ["Abigail", "Lewis", 10],
  ["Abigail", "Shane", 0],
  ["Emily", "Lewis", 20],
  ["Emily", "Pierre", 15],
  ["Haley", "Lewis", 5],
  ["Haley", "Pierre", 10],
  ["Haley", "Robin", 10],
  ["Lewis", "Shane", -5],
  ["Robin", "Shane", 5],
];

export const SEED_LAYERS = { canon2: CANON2, ties: TIES, cast: CAST } as const;

const SEEDS: ReadonlyMap<string, number> = (() => {
  const m = new Map<string, number>();
  for (const [layer, rows] of Object.entries(SEED_LAYERS)) {
    for (const [a, b, score] of rows) {
      const k = pairKey(a, b);
      if (a === b || m.has(k)) throw new Error(`graph seed ${k} in ${layer} is a self pair or already set`);
      m.set(k, score);
    }
  }
  return m;
})();

// The starting score for two different roster villagers. Anyone else is a caller bug: gossip and
// planner shifts only ever reach roster pairs (town.ts pairsTogether, validate.ts checkRelationships).
export function seedScore(a: string, b: string): number {
  if (!isRoster(a) || !isRoster(b) || a === b) throw new Error(`no seed for ${a}|${b}: needs two different roster villagers`);
  return SEEDS.get(pairKey(a, b)) ?? DEFAULT_SEED;
}

// Every roster pair's starting score: 34 * 33 / 2 = 561 pairs.
export function seedRelationships(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [i, a] of ROSTER.entries()) for (const b of ROSTER.slice(i + 1)) out[pairKey(a, b)] = seedScore(a, b);
  return out;
}

// How close two villagers are, from their score. Sets how often and how faithfully gossip passes.
export type Band = "close" | "friendly" | "neutral" | "cool" | "at odds";

export function band(score: number): Band {
  if (score >= 50) return "close";
  if (score >= 15) return "friendly";
  if (score >= -14) return "neutral";
  if (score >= -39) return "cool";
  return "at odds";
}

// Chance per night that one villager passes one fact to another they spent time with.
export const PASS_CHANCE: Record<Band, number> = { close: 0.7, friendly: 0.45, neutral: 0.25, cool: 0.1, "at odds": 0.02 };
