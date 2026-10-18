// The game's own scripted moments (heart events) for the cast, as each character who was there
// remembers them. The bridge sends every event id the player has seen; storyFor() keeps only
// the ones this NPC took part in or was present for, so nobody learns a scene they were not in.
//
// Sources, read 2026-10-17:
// - Event ids and who is in each scene: the game's Data/Events files in the installed copy
//   (Stardew Valley 1.6), read locally. Only ids and actor names were read; no game text is in
//   this file. An NPC counts as present when the scene places them on the map.
// - What happens in each scene: the Stardew Valley Wiki character pages (Heart Events). Every
//   line below is our own short summary, written from that character's side.
// Left out on purpose: other characters' heart events where a cast member appears (Caroline,
// Clint, Elliott and others). Only the cast's own heart events are listed.
// In the group ten-heart scenes (195012, 195019) Pierre is placed off screen and has no lines,
// so he is not counted as present.

import type { CastMember } from "./cast.ts";

export type StoryEvent = { ids: readonly string[]; views: Partial<Record<CastMember, string>> };

export const STORY: readonly StoryEvent[] = [
  // Abigail
  { ids: ["1"], views: { Abigail: "The farmer came up to my room and we played my console game together; I got far too worked up over it." } },
  { ids: ["2"], views: { Abigail: "The farmer found me playing my flute by the mountain lake in the rain, and we played music together under the tree." } },
  {
    ids: ["4"],
    views: {
      Abigail: "The farmer found me practicing with my sword in the graveyard at night. Dad came to send me home to help cook and I stormed off.",
      Pierre: "I found Abigail out by the graveyard at night with the farmer and told her to come help with dinner. She stormed off.",
    },
  },
  { ids: ["3", "5"], views: { Abigail: "In my room, my spirit board gave away that I have feelings for the farmer. I panicked, rushed them out, and apologized the next day." } },
  { ids: ["901756"], views: { Abigail: "In the mines a swarm of bats sent me cowering in a corner. The farmer comforted me, and I admitted I am not as tough as I act." } },
  { ids: ["6963327"], views: { Abigail: "A monster jumped the farmer in the backwoods and I killed it. It was the first life I ever took." } },

  // Emily
  { ids: ["471942"], views: { Emily: "I dreamt of the farmer and woke up sure that our destinies are tied together." } },
  { ids: ["463391"], views: { Emily: "A parrot flew into our window, and the farmer saw me take it in to nurse it back to health." } },
  { ids: ["917409"], views: { Emily: "I showed the farmer my secret hobby, a dance I had worked on for a long time in my room, and asked what they honestly thought." } },
  {
    ids: ["2123243"],
    views: {
      Emily: "I ran a Clothing Therapy session at the mayor's house. The farmer came, and Lewis, Abigail, Shane, Robin and Clint each tried an outfit.",
      Lewis: "Emily ran a Clothing Therapy session in my house. The farmer was there, and I tried on the outfit she picked.",
      Abigail: "Emily ran a Clothing Therapy session at the mayor's house. The farmer was there, and I went along with it and tried an outfit.",
      Shane: "Emily talked me into her Clothing Therapy session at the mayor's house. The farmer was there and I tried on an outfit.",
      Robin: "Emily ran a Clothing Therapy session at the mayor's house. The farmer was there, and I tried on an outfit she picked.",
    },
  },
  { ids: ["2123343"], views: { Emily: "The farmer and I went camping in the Secret Woods, and a bear scared us both into the tent." } },
  { ids: ["3917600"], views: { Emily: "I asked my spouse, the farmer, to gather a big pile of fiber for a project." } },
  { ids: ["3917601"], views: { Emily: "I made my spouse, the farmer, a whole new outfit from the fiber they brought me." } },

  // Gus
  { ids: ["96"], views: { Gus: "The farmer found me worrying over the Saloon's money, and helped get Pam to settle her tab." } },
  { ids: ["980558"], views: { Gus: "I went out to the farm to tell the farmer I count them a real friend, and gave them an old jukebox." } },

  // Haley
  {
    ids: ["11"],
    views: {
      Haley: "Emily and I were fighting about cleaning the couch, and the farmer had to settle it.",
      Emily: "Haley and I argued about cleaning the couch, and the farmer stepped in to settle it.",
    },
  },
  { ids: ["12"], views: { Haley: "I could not get a jar open, and the farmer opened it for me." } },
  { ids: ["13"], views: { Haley: "I lost my great-grandmother's bracelet at the beach, and the farmer found me upset about it." } },
  { ids: ["14"], views: { Haley: "The farmer and I took photos at Marnie's ranch. I tried to climb a cow, ended up covered in mud, and laughed about it." } },
  { ids: ["15"], views: { Haley: "I showed the farmer the darkroom where I develop my photos." } },
  { ids: ["6184643"], views: { Haley: "I overheard that the kids' schoolbooks are falling apart, and started thinking about how to help." } },
  { ids: ["8675611"], views: { Haley: "I told my spouse, the farmer, that I want to hold a charity cake-walk for new schoolbooks." } },
  {
    ids: ["6184644"],
    views: {
      Haley: "My charity cake-walk in town raised money for new schoolbooks, with the farmer's help.",
      Emily: "Haley held a charity cake-walk in town to buy the kids new schoolbooks. The farmer and I were both there.",
      Lewis: "Haley held a charity cake-walk in town for new schoolbooks. I was there, and so was the farmer.",
      Robin: "Haley held a charity cake-walk in town for new schoolbooks. I was there, and so was the farmer.",
      Pierre: "Haley held a charity cake-walk in town for new schoolbooks. I was there, and so was the farmer.",
      Gus: "Haley held a charity cake-walk in town for new schoolbooks. I was there, and so was the farmer.",
    },
  },

  // Lewis
  { ids: ["639373"], views: { Lewis: "The farmer overheard Marnie and me arguing about whether to make our relationship public." } },

  // Pierre
  { ids: ["16"], views: { Pierre: "The farmer found my secret stash behind the bookshelf in my bedroom." } },

  // Robin
  { ids: ["33"], views: { Robin: "I talked carpentry with the farmer and shared two of my own furniture plans with them." } },

  // Shane
  { ids: ["611944"], views: { Shane: "One night I shared a beer with the farmer on the dock by the pond and admitted how low I have been." } },
  { ids: ["3910674"], views: { Shane: "The farmer found me passed out in my room. I said something awful in front of Jas and broke down." } },
  { ids: ["3910975"], views: { Shane: "On a stormy day the farmer found me at my lowest by the cliffs and stayed with me until I got help." } },
  { ids: ["2118991"], views: { Shane: "The day after the cliffs, I came by the farm to apologize and to tell the farmer I am going to counseling." } },
  { ids: ["3910974"], views: { Shane: "With the farmer there, I told Marnie I have been doing better and that leaning on people is not weakness, then gave Jas a present." } },
  {
    ids: ["831125"],
    views: {
      Shane: "The farmer helped me film my Joja Cola ad in town, with Emily and Clint acting in it.",
      Emily: "I acted in Shane's Joja Cola ad in town with Clint, and the farmer helped with the scene.",
    },
  },
  { ids: ["3900074"], views: { Shane: "I showed the farmer my blue chickens and my dream of selling fresh eggs, and that I am teaching Jas." } },
  { ids: ["2128292"], views: { Shane: "I invited the farmer to a gridball game in Zuzu City." } },
  {
    ids: ["9581348"],
    views: {
      Shane: "The farmer and I went to a gridball game in the city, and I thanked them for sticking with me.",
      Gus: "I saw Shane and the farmer catch the bus to the city together for a gridball game.",
    },
  },
  { ids: ["3917584"], views: { Shane: "Marnie and the farmer saw me come out of the Saloon after a heavy night." } },
  { ids: ["3917585"], views: { Shane: "The farmer asked me about my drinking, and I got defensive and went home." } },
  { ids: ["3917586"], views: { Shane: "Marnie and the farmer followed me into the Saloon sure I was drinking. I was at the arcade machine, which is how I fight the urge now." } },

  // Group ten-heart scenes: the player was dating several of them at once.
  {
    ids: ["195012", "195019"],
    views: {
      Abigail: "We found out the farmer was dating several of us at once, and a few of us confronted them together.",
      Emily: "We found out the farmer was dating several of us at once, and a few of us confronted them together.",
      Haley: "We found out the farmer was dating several of us at once, and a few of us confronted them together.",
    },
  },
  {
    ids: ["195013", "195099"],
    views: { Shane: "We found out the farmer was dating several of us at once, and a few of us confronted them together at the Saloon." },
  },
];

// This NPC's own lines for every listed scene the player has seen and this NPC was in, in the
// STORY order. A scene listed under several ids counts once.
export function storyFor(npc: string, eventsSeen: readonly string[]): string[] {
  if (eventsSeen.length === 0) return [];
  const seen = new Set(eventsSeen);
  const lines: string[] = [];
  for (const e of STORY) {
    const view = e.views[npc as CastMember];
    if (view !== undefined && e.ids.some((id) => seen.has(id))) lines.push(view);
  }
  return lines;
}
