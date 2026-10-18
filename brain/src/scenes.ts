// The game's own scripted events (cutscenes, heart events, festivals) as the villagers in them
// remember them. The bridge watches each one read-only and, when it ends, sends one "scene" day
// event for the farmer who watched it (mod/SceneWatcher.cs): npc is the first villager actor,
// witnesses the other villager actors. Every actor took part, so each one stores the scene in
// that farmer's memory section from its own side, and the town gets one fact that only the actors
// saw. Anyone else can learn it only through gossip (town.ts).
//
// Lines, in this order:
//   festival   "I was at the <festival> with <farmer>."
//   known id   the actor's own view from story.ts (the vanilla-progression id map), with "the
//              farmer" replaced by the farmer's name
//   any other  "I was part of something at the <location> with <actors> while <farmer> watched."
// Spec-v2 cut line: E reached build after 19:45, so no new per-id summaries were written here; the
// only per-id views are story.ts's, and events.md supplies the private flags only.
//
// Story knowledge from eventsSeen (story.ts storyFor) stays as it is: it is the backfill for
// scenes seen before the mod was installed, which no scene event ever reported.

import type { SceneEvent } from "./protocol.ts";
import { STORY } from "./story.ts";

// Scenes that canon frames as something the villagers in them would not spread, romance included.
// Ids from ~/.hermes/goals/stardew/events.md (Data, 2026-10-17, read from the installed game's
// Data/Events): every entry marked "private: yes" or "yes (romance)". Ids only; no game text.
export const PRIVATE_SCENES: ReadonlySet<string> = new Set([
  "3", "4", "5", "10", "15", "16", "17", "18", "21", "29", "35", "38", "43", "51", "54", "58", "96", "97", "100", "101",
  "2481135", "288847", "911526", "528052", "733330", "233104", "384882", "917409", "2123343", "611944", "3910674",
  "3910975", "2118991", "9581348", "3917584", "3917585", "3917586", "639373", "901756", "502969", "503180",
  "195012", "195013", "195019", "195099",
]);

export function isPrivateScene(eventId: string): boolean {
  return PRIVATE_SCENES.has(eventId);
}

// Every villager in the scene, first actor first.
export function actorsOf(e: SceneEvent): string[] {
  return [e.npc, ...e.witnesses];
}

// "A", "A and B", "A, B and C".
export function nameList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function festivalLabel(festival: string | undefined, location: string): string {
  // The world snapshot has no festival on this date (or none was sent yet), so the name is unknown.
  return festival !== undefined ? `the ${festival}` : `the festival at the ${location}`;
}

function storyView(eventId: string, npc: string): string | undefined {
  const e = STORY.find((s) => s.ids.includes(eventId));
  return (e?.views as Record<string, string> | undefined)?.[npc];
}

// One actor's own line for a scene. festival: the calendar name for the scene's date, when known.
export function sceneLine(e: SceneEvent, npc: string, farmer: string, festival?: string): string {
  if (e.festival) return `I was at ${festivalLabel(festival, e.location)} with ${farmer}.`;
  const view = storyView(e.eventId, npc);
  if (view !== undefined) return view.replace(/\b[Tt]he farmer\b/g, farmer);
  const others = actorsOf(e).filter((a) => a !== npc);
  const withWhom = others.length > 0 ? ` with ${nameList(others)}` : "";
  return `I was part of something at the ${e.location}${withWhom} while ${farmer} watched.`;
}

// The town fact's text: the same moment told from outside, so gossip never carries anyone's
// first-person view.
export function sceneFactText(e: SceneEvent, farmer: string, festival?: string): string {
  if (e.festival) return `${farmer} was at ${festivalLabel(festival, e.location)} with ${nameList(actorsOf(e))}.`;
  return `${farmer} saw something happen at the ${e.location} with ${nameList(actorsOf(e))}.`;
}
