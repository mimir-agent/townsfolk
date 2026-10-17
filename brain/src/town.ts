// Town state for one save: facts with knowers, and NPC-to-NPC relationships.
// Stored at <stateDir>/<saveId>/_town.json and changed only when a day is committed
// (POST /v1/saved), so an unsaved day never moves gossip.
//
// A fact is something one or more NPCs know. Each knower holds its own copy of the text and
// says how it learned it:
//   saw    it happened in front of them
//   told   the player told them (shareable false means in confidence)
//   heard  another NPC passed it on; `from` names who, `hops` counts the passes from the source
// Overnight, cast members who spent time together pass shareable facts to each other with a
// probability set by their relationship. One pass per night, at most MAX_HOPS passes from the
// source, and the text gets shorter at each pass.

import { isCast, pairKey, startingRelationships } from "./cast.ts";
import { dateLabel, dayKey, type PendingDay } from "./memory.ts";
import type { DayRef, RelationshipShift } from "./protocol.ts";
import type { Rng } from "./rng.ts";

export const MAX_HOPS = 2;
export const MAX_FACTS = 200;
export const MAX_NEW_FACTS_PER_DAY = 20;
// Gossip is news: a fact older than this many days is no longer passed on.
export const FRESH_DAYS = 14;
// How many facts an NPC's prompt shows, newest first.
export const MAX_PROMPT_FACTS = 8;
// Text length allowed for a knower's copy, by hops from the source.
export const TEXT_MAX_BY_HOPS = [200, 120, 70] as const;

export type FactSource = { kind: "saw" } | { kind: "told" } | { kind: "heard"; from: string };

export type Knowledge = { source: FactSource; hops: number; text: string; learned: DayRef };

export type Fact = {
  id: string;
  created: DayRef;
  shareable: boolean;
  knowers: Record<string, Knowledge>;
};

export type TownState = {
  version: 1;
  // dayKey of the last night applied, so a repeated commit of the same night is a no-op.
  lastNight: number | null;
  relationships: Record<string, number>;
  facts: Fact[];
};

export function emptyTown(): TownState {
  return { version: 1, lastNight: null, relationships: startingRelationships(), facts: [] };
}

export function relationship(town: TownState, a: string, b: string): number {
  return town.relationships[pairKey(a, b)] ?? 0;
}

// -100 -> 0.1, 0 -> 0.4, 100 -> 0.7. Even rivals gossip sometimes; nobody passes everything.
export function passChance(score: number): number {
  const s = Math.max(-100, Math.min(100, score));
  return 0.1 + (0.6 * (s + 100)) / 200;
}

// Cuts at a word boundary and marks the cut, so a retold fact reads as a vaguer version.
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > max / 2 ? cut.slice(0, space) : cut}...`;
}

export function newFact(id: string, created: DayRef, text: string, shareable: boolean, knowers: Record<string, FactSource>): Fact {
  const k: Record<string, Knowledge> = {};
  for (const [npc, source] of Object.entries(knowers)) {
    k[npc] = { source, hops: 0, text: shorten(text, TEXT_MAX_BY_HOPS[0]), learned: created };
  }
  return { id, created, shareable, knowers: k };
}

// Facts a committed day creates, in event order, at most MAX_NEW_FACTS_PER_DAY:
//   gift  a public act: the receiver and everyone who saw it know, and may pass it on
//   join  the player joined a happening: every participant saw it, and may pass it on
//   talk  only when the picked reply carried a fact (a promise): the NPC spoken to was told it;
//         witnesses saw a conversation but did not hear it. In confidence means not shareable.
// Other talk makes no fact; what was said already lives in that NPC's memory.
export function factsFromDay(day: PendingDay): Fact[] {
  const facts: Fact[] = [];
  const add = (text: string, shareable: boolean, knowers: Record<string, FactSource>) => {
    if (facts.length < MAX_NEW_FACTS_PER_DAY) facts.push(newFact(`${dayKey(day.day)}-${facts.length}`, day.day, text, shareable, knowers));
  };
  const sawIt = (npc: string, witnesses: string[]): Record<string, FactSource> =>
    Object.fromEntries([npc, ...witnesses].map((n): [string, FactSource] => [n, { kind: "saw" }]));
  for (const e of day.events) {
    if (e.type === "gift") add(`${day.playerName} gave ${e.npc} ${e.item} at ${e.location}.`, true, sawIt(e.npc, e.witnesses));
    else if (e.type === "join") add(`${day.playerName} joined in at ${e.location}: ${e.topic}.`, true, sawIt(e.npc, e.witnesses));
    else if (e.fact !== undefined) add(e.fact.text, e.fact.shareable, { [e.npc]: { kind: "told" } });
  }
  return facts;
}

// Cast pairs who spent time in the same place today: an event's npc with its witnesses, and
// each group the bridge saw together. Sorted, so the night's dice are rolled in a fixed order.
export function pairsTogether(day: PendingDay): [string, string][] {
  const groups = [...day.events.map((e) => [e.npc, ...e.witnesses]), ...(day.together ?? []).map((g) => g.npcs)];
  const keys = new Set<string>();
  for (const g of groups) {
    const cast = [...new Set(g.filter(isCast))].sort();
    for (let i = 0; i < cast.length; i++) for (let j = i + 1; j < cast.length; j++) keys.add(pairKey(cast[i]!, cast[j]!));
  }
  return [...keys].sort().map((k) => k.split("|") as [string, string]);
}

function canPass(fact: Fact, k: Knowledge, night: DayRef): boolean {
  return fact.shareable && k.hops < MAX_HOPS && dayKey(night) - dayKey(fact.created) < FRESH_DAYS;
}

// Pure. Only what knowers knew before tonight is passed, so a fact moves at most one hop a night.
export function gossipNight(town: TownState, night: DayRef, pairs: [string, string][], rng: Rng): TownState {
  const facts = town.facts.map((f) => ({ ...f, knowers: { ...f.knowers } }));
  for (const [a, b] of pairs) {
    const chance = passChance(relationship(town, a, b));
    for (const [i, fact] of facts.entries()) {
      const before = town.facts[i]!.knowers;
      for (const [teller, listener] of [[a, b], [b, a]] as const) {
        const k = before[teller];
        if (k === undefined || fact.knowers[listener] !== undefined || !canPass(fact, k, night)) continue;
        if (rng.next() >= chance) continue;
        const hops = k.hops + 1;
        fact.knowers[listener] = { source: { kind: "heard", from: teller }, hops, text: shorten(k.text, TEXT_MAX_BY_HOPS[hops]!), learned: night };
      }
    }
  }
  return { ...town, facts };
}

// Folds a committed day into the town: new facts from the day, then the night's gossip, then
// the cap. Returns the town unchanged when this exact night was the last one applied: that is a
// commit that wrote the town but crashed before clearing the pending day, then ran again. An
// earlier date is applied normally (the player restored an older save backup).
// shifts are the NPC relationship changes the planner set for this day; they land with the day,
// so a day that is never saved never moves a relationship.
export function applyNight(town: TownState, day: PendingDay, rng: Rng, shifts: readonly RelationshipShift[] = []): TownState {
  const key = dayKey(day.day);
  if (town.lastNight === key) return town;
  const relationships = { ...town.relationships };
  for (const s of shifts) {
    const k = pairKey(s.a, s.b);
    relationships[k] = Math.max(-100, Math.min(100, (relationships[k] ?? 0) + s.delta));
  }
  const withNew: TownState = { ...town, relationships, facts: [...town.facts, ...factsFromDay(day)] };
  const after = gossipNight(withNew, day.day, pairsTogether(day), rng);
  return { ...after, lastNight: key, facts: after.facts.slice(-MAX_FACTS) };
}

function sourceLabel(s: FactSource, shareable: boolean): string {
  if (s.kind === "heard") return `heard from ${s.from}`;
  if (s.kind === "told") return shareable ? "the farmer told you" : "the farmer told you in confidence; do not repeat it";
  return "you saw it";
}

// What this NPC knows from facts, for its prompt. Facts it only saw are left out: those are
// already in its own memory. Never reads another NPC's copy.
export function knownFactLines(town: TownState, npc: string): string[] {
  const mine = town.facts
    .map((f) => ({ f, k: f.knowers[npc] }))
    .filter((x): x is { f: Fact; k: Knowledge } => x.k !== undefined && x.k.source.kind !== "saw")
    .sort((x, y) => dayKey(y.k.learned) - dayKey(x.k.learned))
    .slice(0, MAX_PROMPT_FACTS);
  return mine.map(({ f, k }) => `- ${k.text} (${sourceLabel(k.source, f.shareable)}, ${dateLabel(k.learned)})`);
}
