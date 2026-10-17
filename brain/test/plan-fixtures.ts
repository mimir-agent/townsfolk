// Hand-written fixtures for the planner tests: a small world in the shape of what the bridge
// sends at save load, and a model plan reply. Location sizes and item ids are our own small
// stand-ins, not copied game data.

import type { DayRef } from "../src/protocol.ts";

export const SAVE = "Farm_123";

export const WORLD = {
  v: 1,
  saveId: SAVE,
  locations: [
    { name: "Town", width: 120, height: 110 },
    { name: "Saloon", width: 40, height: 30 },
    { name: "SeedShop", width: 40, height: 30 },
    { name: "Beach", width: 100, height: 50 },
    { name: "Mountain", width: 120, height: 60 },
    { name: "ScienceHouse", width: 40, height: 30 },
    { name: "ManorHouse", width: 30, height: 20 },
    { name: "HaleyHouse", width: 30, height: 30 },
    { name: "Trailer", width: 20, height: 15 },
    { name: "Forest", width: 120, height: 120 },
  ],
  items: [
    { id: "(O)24", name: "Parsnip" },
    { id: "(O)66", name: "Amethyst" },
    { id: "(O)18", name: "Daffodil" },
    { id: "(O)388", name: "Wood" },
  ],
  festivals: [
    { season: "spring", day: 13, name: "Egg Festival" },
    { season: "spring", day: 24, name: "Flower Dance" },
  ],
  married: [] as string[],
};

export const spring = (day: number): DayRef => ({ season: "spring", day, year: 1 });

export function planReq(day: DayRef) {
  return { v: 1, saveId: SAVE, playerName: "Tae", day, stats: { farmName: "Starfruit Hollow", daysPlayed: 4 } };
}

type Stop = { time: number; location: string; x: number; y: number; facing: number };
const stop = (time: number, location: string, x: number, y: number, facing = 2): Stop => ({ time, location, x, y, facing });

export const GOOD_SCHEDULES: Record<string, Stop[]> = {
  Abigail: [stop(900, "Mountain", 40, 20), stop(1300, "Town", 50, 60), stop(1900, "ScienceHouse", 10, 10)],
  Emily: [stop(800, "Town", 30, 40), stop(1700, "Saloon", 20, 15)],
  Gus: [stop(610, "Saloon", 10, 18), stop(2400, "Town", 12, 80)],
  Haley: [stop(1000, "Beach", 30, 20), stop(1600, "HaleyHouse", 10, 10)],
  Lewis: [stop(700, "Town", 60, 70), stop(1200, "ManorHouse", 8, 8)],
  Pierre: [stop(900, "SeedShop", 5, 18), stop(1800, "Saloon", 25, 15)],
  Robin: [stop(800, "Forest", 40, 40), stop(1500, "Town", 70, 30)],
  Shane: [stop(900, "Forest", 80, 90), stop(1800, "Saloon", 28, 12), stop(2300, "Trailer", 5, 5)],
};

export function goal(npc: string, text = `${npc}'s spring project`, progress = 10) {
  return { text, progress };
}

export function npcsEntry(schedules: Record<string, unknown>, goals: Record<string, unknown> = {}) {
  return Object.entries(schedules).map(([npc, schedule]) => ({ npc, schedule, goal: goals[npc] ?? goal(npc) }));
}

export const HAPPENING = { location: "Saloon", start: 1900, end: 2100, participants: ["Gus", "Emily", "Pierre", "Shane"], topic: "Gus tries out a new stew recipe" };
export const GOOD_QUEST = { item: "(O)24", from: "Gus", reward: 150, text: "Could you bring me a parsnip for tonight's soup? Gus" };
export const FRIENDSHIP = [
  { npc: "Emily", delta: 20, reason: "the farmer gave her an amethyst" },
  { npc: "Shane", delta: -10, reason: "the farmer laughed at his joke the wrong way" },
];
export const RELATIONSHIPS = [{ a: "Emily", b: "Haley", delta: 5, reason: "they shared a long talk at the beach" }];

export function reply(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    npcs: npcsEntry(GOOD_SCHEDULES),
    happening: HAPPENING,
    quests: [GOOD_QUEST],
    friendship: FRIENDSHIP,
    relationships: RELATIONSHIPS,
    ...over,
  });
}
