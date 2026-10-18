// A realistic mid-game talk, shared by the manual latency scripts (talk-bench.ts, talk-e2e.ts):
// Abigail at 5 hearts, a full card, a season summary and 14 memory entries, 6 pieces of gossip,
// a 3-turn transcript, a game line, stats and two heart events. Hand-written; no game data.

import { emptyMemory, MemoryStore, type NpcMemory } from "../src/memory.ts";
import { MAIN_FARMER, type TalkRequest } from "../src/protocol.ts";
import { buildPrompt, NO_CONTEXT } from "../src/talk.ts";
import { emptyTown, newFact, type TownState } from "../src/town.ts";

export const BENCH_SAVE = "Bench_1";

const TOPICS = ["the mines", "Sebastian's new song", "the rain", "Dad's prices", "the flute", "video games", "the graveyard", "frogs", "the beach", "Linus", "Haley's photos", "the saloon", "the bus stop", "the tower"];
const FEELINGS = ["I want to leave town some day", "Mom worries about me", "I miss adventures", "I hate being told what to do"];

export function benchMemory(): NpcMemory {
  const mem = emptyMemory("Abigail");
  mem.farmers[MAIN_FARMER] = {
    farmerName: "Tae",
    firstMet: "spring 2, year 1",
    talks: 31,
    gifts: 9,
    years: "",
    seasons: [{ season: "spring", year: 1, text: "Tae arrived in early spring and kept showing up at the shop. 4: gave me an amethyst, my favorite. 11: we talked about the mines; Tae promised to tell me what is past level 40. 20: Tae saw me practicing with my sword and did not laugh. 27: the egg festival, Tae won the hunt and teased me about it." }],
    entries: TOPICS.map((topic, i) => ({
      day: { season: "summer" as const, day: i + 1, year: 1 },
      text: `Tae stopped by the shop around noon. We talked about ${topic}. Tae picked the warm reply and I felt a bit more at ease; I told them a little about how ${FEELINGS[(i + 1) % 4]}.`,
    })),
  };
  return mem;
}

export function benchTown(): TownState {
  const town = emptyTown();
  const gossip = [
    "The farmer gave Emily a bunch of daffodils at the saloon.",
    "The farmer joined Sam's band practice and played the tambourine badly.",
    "The farmer promised Pierre a crate of parsnips by Friday.",
    "The farmer was seen in the mines past level 60.",
    "The farmer and Leah walked along the river at dusk.",
    "The farmer fixed the broken bridge to the quarry.",
  ];
  gossip.forEach((text, i) => {
    town.facts.push(newFact(`g${i}`, { season: "summer", day: 8 + i, year: 1 }, text, true, { Abigail: { kind: "heard", from: "Sebastian" } }));
  });
  return town;
}

export function benchRequest(): TalkRequest {
  return {
    v: 1,
    saveId: BENCH_SAVE,
    npc: "Abigail",
    playerName: "Tae",
    day: { season: "summer", day: 15, year: 1, time: 1330, weather: "sunny", location: "SeedShop" },
    friendship: { hearts: 5, points: 1300 },
    transcript: [
      { speaker: "npc", text: "Oh, it's you. I was just about to sneak out to the mines, honestly." },
      { speaker: "player", text: "Want some company down there?" },
      { speaker: "npc", text: "Maybe. Depends if you can keep up with me." },
      { speaker: "player", text: "I made it past level 60 last week." },
      { speaker: "npc", text: "Wait, seriously? Sebastian said something about that. I thought he was joking." },
    ],
    recentChoice: { id: "b", text: "Want to see what I found down there?" },
    gameLines: ["Hey. Dad's been on my case all morning."],
    stats: { farmName: "Moonfield", daysPlayed: 43, deepestMineLevel: 64, communityCenterRooms: 2, money: 18250 },
    eventsSeen: ["1", "2"],
  };
}

export function benchPrompt(): { system: string; user: string } {
  return buildPrompt(benchRequest(), benchMemory(), benchTown(), NO_CONTEXT, false, null);
}

// Writes the fixture's memory and town into a brain state directory, so a brain started with
// TOWNSFOLK_STATE_DIR=dir builds the same prompt for benchRequest().
export async function seedState(dir: string): Promise<void> {
  const store = new MemoryStore(dir);
  await store.save(BENCH_SAVE, benchMemory());
  await store.saveTown(BENCH_SAVE, benchTown());
}
