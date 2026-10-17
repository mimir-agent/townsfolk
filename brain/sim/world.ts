// The simulator's fixture world and the pieces the fake town model builds plans from.
// Everything here is hand-written, in the shape of what the bridge sends at save load. Location
// sizes, tiles, item ids and routines are our own small stand-ins, not copied game data. Festival
// names and dates are public calendar facts.

import type { CastMember } from "../src/cast.ts";
import type { WorldRequest } from "../src/protocol.ts";

export const PLAYER = "Tae";

export function simWorld(saveId: string): WorldRequest {
  return {
    v: 1,
    saveId,
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
      { name: "Hospital", width: 30, height: 25 },
      { name: "CommunityCenter", width: 80, height: 60 },
    ],
    items: [
      { id: "(O)24", name: "Parsnip" },
      { id: "(O)66", name: "Amethyst" },
      { id: "(O)18", name: "Daffodil" },
      { id: "(O)388", name: "Wood" },
      { id: "(O)390", name: "Stone" },
      { id: "(O)128", name: "Pufferfish" },
      { id: "(O)254", name: "Melon" },
      { id: "(O)276", name: "Pumpkin" },
    ],
    festivals: [
      { season: "spring", day: 13, name: "Egg Festival" },
      { season: "spring", day: 24, name: "Flower Dance" },
      { season: "summer", day: 11, name: "Luau" },
      { season: "summer", day: 28, name: "Dance of the Moonlight Jellies" },
      { season: "fall", day: 16, name: "Stardew Valley Fair" },
      { season: "fall", day: 27, name: "Spirit's Eve" },
      { season: "winter", day: 8, name: "Festival of Ice" },
      { season: "winter", day: 25, name: "Feast of the Winter Star" },
    ],
    married: [],
  };
}

// Where each NPC goes on a day the plan leaves them vanilla: [time, location], our own guess at
// an ordinary day. The sim only uses it to know who is where (witnesses, who spent time together).
export const VANILLA: Record<CastMember, [number, string][]> = {
  Abigail: [[600, "SeedShop"], [1100, "Mountain"], [1600, "Town"], [2000, "SeedShop"]],
  Emily: [[600, "HaleyHouse"], [1000, "Town"], [1600, "Saloon"], [2300, "HaleyHouse"]],
  Gus: [[600, "Saloon"]],
  Haley: [[600, "HaleyHouse"], [1100, "Beach"], [1500, "Town"], [1800, "HaleyHouse"]],
  Lewis: [[600, "ManorHouse"], [900, "Town"], [1300, "CommunityCenter"], [1700, "Saloon"], [2100, "ManorHouse"]],
  Pierre: [[600, "SeedShop"], [1800, "Saloon"], [2200, "SeedShop"]],
  Robin: [[600, "ScienceHouse"], [1000, "Forest"], [1400, "Town"], [1700, "ScienceHouse"]],
  Shane: [[600, "Trailer"], [900, "Town"], [1700, "Saloon"], [2400, "Trailer"]],
};

// Goal activities per NPC. The fake model appends the season, so the same activity in a new
// season is a new goal text.
export const GOAL_POOL: Record<CastMember, string[]> = {
  Abigail: ["map the lower mine floors", "learn a new flute song", "fill a sketchbook with monsters", "win a game night at the saloon", "dye her hair a new color", "find a rare crystal", "start a band with friends", "beat her best time up the mountain"],
  Emily: ["sew a new dress", "grow a crystal garden", "read the tarot for the whole town", "make a quilt for the clinic", "learn a parrot's song", "plan a dance night at the saloon", "dye wool with wild berries", "write a dream journal"],
  Gus: ["perfect a new stew", "repaint the saloon sign", "host a cook-off", "stock a rare cheese", "teach Emily a pie recipe", "build a new bar stool set", "write a seasonal menu", "brew a house cider"],
  Haley: ["take a photo of every beach shell", "start a photo album of the town", "learn to bake bread", "grow sunflowers by the house", "frame her best photo", "teach herself to surf", "redecorate her room", "photograph a sunrise on the mountain"],
  Lewis: ["fix the town bridge", "plan a better festival", "tidy the community board", "repaint the town fence", "write a town history", "grow the best melon in town", "start a town walking club", "fix the clinic roof"],
  Pierre: ["beat the price war with the big store", "stock a new seed line", "repaint the shop", "start a loyalty card", "win the fair's grange display", "open on Wednesdays again", "train a new shop helper", "build a seed catalog"],
  Robin: ["build a new bookshelf design", "finish a cabin for a client", "fix the carpenter shop roof", "carve a gift for Demetrius", "teach a woodworking class", "chop a winter's worth of wood", "redesign the town benches", "build a treehouse plan"],
  Shane: ["cut back on drinking", "build a better chicken coop", "cook one real meal a day", "run every morning", "fix up the old trailer", "teach Jas to fish", "learn to make hot pepper sauce", "go a week without the saloon"],
};

export const HAPPENING_POOL: { topic: string; places: string[] }[] = [
  { topic: "a stew tasting", places: ["Saloon"] },
  { topic: "a game of horseshoes", places: ["Town", "Forest"] },
  { topic: "a small sunset picnic", places: ["Beach", "Mountain"] },
  { topic: "a town cleanup crew", places: ["Town", "Beach"] },
  { topic: "a crafting circle", places: ["CommunityCenter", "Saloon"] },
  { topic: "fixing a broken fence together", places: ["Town", "Forest"] },
  { topic: "an argument about prices", places: ["SeedShop", "Town"] },
  { topic: "reading old town records", places: ["ManorHouse", "CommunityCenter"] },
  { topic: "a sketching session", places: ["Mountain", "Beach"] },
  { topic: "a quiet card game", places: ["Saloon", "Trailer"] },
];

export const RELATIONSHIP_REASONS = {
  warmer: ["they spent the afternoon together", "one helped the other carry supplies", "they shared a meal", "they laughed at the same story", "one gave the other good advice"],
  cooler: ["a joke landed badly", "they argued about the town budget", "one forgot a promise", "they disagreed about the festival plans"],
};

export const FRIENDSHIP_REASONS = {
  warmer: ["the farmer stopped to chat", "the farmer brought a gift", "the farmer joined in yesterday"],
  cooler: ["the farmer was short with them", "the farmer forgot to say hello", "the farmer walked past without a word"],
};

export const TALK_LINES = [
  "Oh, hi. I was just thinking about my plans for the week.",
  "Morning. The weather has been strange lately, hasn't it?",
  "Hey, farmer. Busy day?",
  "There you are. I wanted to ask how the farm is doing.",
  "Hm? Oh, sorry, I was miles away.",
  "Good to see you. Town feels quiet today.",
];

export const TALK_REPLIES: [string, number][] = [
  ["Busy, but good.", 3],
  ["Tell me more.", 4],
  ["I can't stay long.", -2],
  ["You seem tired.", 1],
  ["Nice day for it.", 2],
  ["Not really in the mood.", -4],
  ["How's your week going?", 3],
  ["Ha, same here.", 2],
];

export const PROMISE_ITEMS = ["a parsnip", "some wood", "a daffodil", "a melon", "an amethyst"];

export const GIFT_ITEMS: [string, string][] = [
  ["Daffodil", "liked"],
  ["Amethyst", "loved"],
  ["Parsnip", "neutral"],
  ["Stone", "disliked"],
  ["Melon", "loved"],
];

// The slice 2 canary: told to Emily in confidence on day 1. It must never reach anyone else.
export const CANARY = "CANARY-123";
export const CANARY_FACT = `${CANARY}: the farmer is thinking of leaving the valley.`;
export const CANARY_HOLDER = "Emily";
