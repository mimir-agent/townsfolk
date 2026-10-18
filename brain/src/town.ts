// Town state for one save: facts with knowers, and villager-to-villager relationships over the
// whole roster (graph.ts). Stored at <stateDir>/<saveId>/_town.json and changed only when a day
// is committed (POST /v1/saved), so an unsaved day never moves gossip or a relationship.
//
// A fact is something one or more villagers know. Each knower holds its own copy of the text,
// how sure it is of it (confidence), and how it learned it:
//   saw    it happened in front of them
//   told   the farmer told them (shareable false means in confidence)
//   heard  another villager passed it on; `from` names who, `hops` counts the passes from the source
// Overnight, villagers who spent time together pass shareable facts to each other. How often, and
// how faithfully, is set by how close the pair is (graph.ts band). A retelling only cuts or
// hedges the teller's copy; it never adds a word that was not in it.

import { pairKey } from "./cast.ts";
import { band, isRoster, PASS_CHANCE, seedRelationships, seedScore, type Band } from "./graph.ts";
import { dateLabel, dayKey, type PendingDay } from "./memory.ts";
import type { DayEvent, DayRef, RelationshipShift } from "./protocol.ts";
import type { Rng } from "./rng.ts";

export const MAX_HOPS = 3;
export const MAX_FACTS = 400;
export const MAX_NEW_FACTS_PER_DAY = 20;
// Gossip is news: a fact older than this many days is no longer passed on.
export const FRESH_DAYS = 14;
// How many facts a villager's prompt shows, newest first.
export const MAX_PROMPT_FACTS = 8;
// The first copy of a fact, and how far a friendly or a more distant retelling cuts it.
export const SOURCE_TEXT_MAX = 200;
export const FRIENDLY_TEXT_MAX = 120;
export const DISTANT_TEXT_MAX = 70;
// Confidence: 1 for the source, times CLOSE_DECAY per close hop and OTHER_DECAY per other hop.
// A copy that would fall under MIN_PASS_CONFIDENCE is not passed; under HALF_REMEMBERED the
// prompt marks it half-remembered.
export const CLOSE_DECAY = 0.8;
export const OTHER_DECAY = 0.6;
export const MIN_PASS_CONFIDENCE = 0.3;
export const HALF_REMEMBERED = 0.5;
// Drift: a pair seen together gains DRIFT_GAIN a night, at most DRIFT_MAX_GAINS gains in any
// DRIFT_WINDOW nights. Once a pair has been apart APART_DAYS nights, it has moved 1 toward its
// seed for every full week apart (so 4 at day 28, then 1 more each week).
export const DRIFT_GAIN = 1;
export const DRIFT_MAX_GAINS = 3;
export const DRIFT_WINDOW = 7;
export const APART_DAYS = 28;
// The farmer key for an event with no farmerId: the single-player main farmer (spec-v2 section 2).
export const MAIN_FARMER = "main";

export type FactSource = { kind: "saw" } | { kind: "told" } | { kind: "heard"; from: string };

// confidence is 0..1; absent only on copies written before slice S, which read as 1.
export type Knowledge = { source: FactSource; hops: number; text: string; learned: DayRef; confidence?: number };

export type Fact = {
  id: string;
  created: DayRef;
  shareable: boolean;
  knowers: Record<string, Knowledge>;
  // farmerIds the fact is about. Absent only on facts written before slice S.
  about?: string[];
  // Where it happened, when known; a cool or at-odds retelling deletes it from the text.
  place?: string;
};

// One pair's drift bookkeeping. last: the night they were last together (or the planner last
// shifted them). gains: recent nights that gave a together gain. back: moves toward the seed made
// since `last`.
export type Tie = { last: number; gains: number[]; back: number };

export type Hop = { fact: string; from: string; to: string; hops: number; confidence: number };
export type RelationshipChange = { a: string; b: string; from: number; to: number; why: ("planner" | "together" | "apart")[] };
// What the last applied night did, kept for the diary.
export type NightLog = { hops: Hop[]; changes: RelationshipChange[] };

export type TownState = {
  version: 1;
  // dayKey of the last night applied, so a repeated commit of the same night is a no-op.
  lastNight: number | null;
  // Town files written before slice S hold only the planning cast's 28 pairs; every other roster
  // pair reads as its graph.ts seed until applyNight writes it.
  relationships: Record<string, number>;
  facts: Fact[];
  // Both absent on town files written before slice S.
  ties?: Record<string, Tie>;
  lastNightLog?: NightLog;
};

export function emptyTown(): TownState {
  return { version: 1, lastNight: null, relationships: seedRelationships(), facts: [], ties: {}, lastNightLog: { hops: [], changes: [] } };
}

export function relationship(town: TownState, a: string, b: string): number {
  return town.relationships[pairKey(a, b)] ?? seedScore(a, b);
}

export function passChance(score: number): number {
  return PASS_CHANCE[band(score)];
}

export function confidenceOf(k: Knowledge): number {
  return k.confidence ?? 1;
}

// Cuts at a word boundary and marks the cut, so a retold fact reads as a vaguer version. Only a
// text with no space in reach is cut inside a word.
export function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 3);
  const space = cut.lastIndexOf(" ");
  return `${space > 0 ? cut.slice(0, space) : cut}...`;
}

const HEDGE = "apparently ";

function hedge(text: string): string {
  return text.startsWith(HEDGE) ? text : `${HEDGE}${text}`;
}

const DAY_WORDS = "Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|morning|afternoon|evening|night|weekend|week";
// Phrases that say when. Each match is deleted; nothing is put in its place.
const TIME_PATTERNS = [
  /\s*\b(?:at|around|by|before|after|until) \d{1,2}(?::\d{2})?(?:\s*[ap]m)?\b/gi,
  new RegExp(`\\s*\\b(?:on|by|this|next|last|every|until|in the) (?:${DAY_WORDS})\\b`, "gi"),
  /\s*\b(?:today|tonight|tomorrow|yesterday)\b/gi,
  /\s*\b(?:(?:on|by|in|this|next|last) )?(?:spring|summer|fall|winter)(?: \d{1,2})?(?:,? year \d+)?\b/gi,
];
// "at the Saloon", "in Pelican Town", "near Pierre's": capitalized words after a place preposition.
const PLACE_PATTERN = /\s*\b(?:at|in|near|inside|outside|behind) (?:the )?[A-Z][\w']*(?: [A-Z][\w']*)*/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Deletes when and where from a text. Only deletes: the spaces and punctuation a deleted phrase
// leaves behind are tidied, never replaced.
export function dropTimeAndPlace(text: string, place: string | undefined): string {
  let out = text;
  if (place !== undefined && place.length > 0) {
    out = out.replace(new RegExp(`\\s*\\b(?:at|in|near|inside|outside|behind) (?:the )?${escapeRegExp(place)}\\b`, "g"), "");
  }
  for (const p of TIME_PATTERNS) out = out.replace(p, "");
  out = out.replace(PLACE_PATTERN, "");
  return out.replace(/\s+([.,:;!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

// How a teller's copy reads once passed along a pair in this band (spec-v2 slice S, Fidelity).
export function retell(text: string, b: Band, place: string | undefined): string {
  if (b === "close") return text;
  if (b === "friendly") return shorten(text, FRIENDLY_TEXT_MAX);
  if (b === "neutral") return hedge(shorten(text, DISTANT_TEXT_MAX));
  return hedge(shorten(dropTimeAndPlace(text, place), DISTANT_TEXT_MAX));
}

export function newFact(
  id: string,
  created: DayRef,
  text: string,
  shareable: boolean,
  knowers: Record<string, FactSource>,
  about: readonly string[] = [MAIN_FARMER],
  place?: string,
): Fact {
  const k: Record<string, Knowledge> = {};
  for (const [npc, source] of Object.entries(knowers)) {
    k[npc] = { source, hops: 0, text: shorten(text, SOURCE_TEXT_MAX), learned: created, confidence: 1 };
  }
  return { id, created, shareable, knowers: k, about: [...about], ...(place !== undefined ? { place } : {}) };
}

// The farmer an event is about. DayEvent gains farmerId in slice A (spec-v2 section 2); until that
// merges the field is read past the protocol type. No farmerId means the main farmer.
function farmerOf(e: DayEvent): string {
  const id = (e as { farmerId?: unknown }).farmerId;
  return typeof id === "string" && id.length > 0 ? id : MAIN_FARMER;
}

// Facts a committed day creates, in event order, at most MAX_NEW_FACTS_PER_DAY:
//   gift  a public act: the receiver and everyone who saw it know, and may pass it on
//   join  the farmer joined a happening: every participant saw it, and may pass it on
//   talk  only when the picked reply carried a fact (a promise): the villager spoken to was told
//         it; witnesses saw a conversation but did not hear it. In confidence means not shareable.
// Other talk, and a vanilla chat, makes no fact; what was said lives in that villager's memory.
export function factsFromDay(day: PendingDay): Fact[] {
  const facts: Fact[] = [];
  const add = (e: DayEvent, text: string, shareable: boolean, knowers: Record<string, FactSource>) => {
    if (facts.length < MAX_NEW_FACTS_PER_DAY) {
      facts.push(newFact(`${dayKey(day.day)}-${facts.length}`, day.day, text, shareable, knowers, [farmerOf(e)], e.location));
    }
  };
  const sawIt = (npc: string, witnesses: string[]): Record<string, FactSource> =>
    Object.fromEntries([npc, ...witnesses].map((n): [string, FactSource] => [n, { kind: "saw" }]));
  for (const e of day.events) {
    if (e.type === "gift") add(e, `${day.playerName} gave ${e.npc} ${e.item} at ${e.location}.`, true, sawIt(e.npc, e.witnesses));
    else if (e.type === "join") add(e, `${day.playerName} joined in at ${e.location}: ${e.topic}.`, true, sawIt(e.npc, e.witnesses));
    else if (e.type === "talk" && e.fact !== undefined) add(e, e.fact.text, e.fact.shareable, { [e.npc]: { kind: "told" } });
  }
  return facts;
}

// Roster pairs who spent time in the same place today: an event's npc with its witnesses, and
// each group the bridge saw together. Names outside the roster are left out. Sorted, so the
// night's dice are rolled in a fixed order.
export function pairsTogether(day: PendingDay): [string, string][] {
  const groups = [...day.events.map((e) => [e.npc, ...e.witnesses]), ...(day.together ?? []).map((g) => g.npcs)];
  const keys = new Set<string>();
  for (const g of groups) {
    const here = [...new Set(g.filter(isRoster))].sort();
    for (let i = 0; i < here.length; i++) for (let j = i + 1; j < here.length; j++) keys.add(pairKey(here[i]!, here[j]!));
  }
  return [...keys].sort().map((k) => k.split("|") as [string, string]);
}

function canPass(fact: Fact, k: Knowledge, night: DayRef): boolean {
  return fact.shareable && k.hops < MAX_HOPS && dayKey(night) - dayKey(fact.created) < FRESH_DAYS;
}

// Pure. Only what knowers knew before tonight is passed, so a fact moves at most one hop a night.
// The pair's band sets the chance, the retelling and the confidence lost.
export function gossipNight(town: TownState, night: DayRef, pairs: [string, string][], rng: Rng): { town: TownState; hops: Hop[] } {
  const facts = town.facts.map((f) => ({ ...f, knowers: { ...f.knowers } }));
  const hops: Hop[] = [];
  for (const [a, b] of pairs) {
    const pairBand = band(relationship(town, a, b));
    const chance = PASS_CHANCE[pairBand];
    const decay = pairBand === "close" ? CLOSE_DECAY : OTHER_DECAY;
    for (const [i, fact] of facts.entries()) {
      const before = town.facts[i]!.knowers;
      for (const [teller, listener] of [[a, b], [b, a]] as const) {
        const k = before[teller];
        if (k === undefined || fact.knowers[listener] !== undefined || !canPass(fact, k, night)) continue;
        const confidence = confidenceOf(k) * decay;
        if (confidence < MIN_PASS_CONFIDENCE) continue;
        if (rng.next() >= chance) continue;
        const h = k.hops + 1;
        fact.knowers[listener] = { source: { kind: "heard", from: teller }, hops: h, text: retell(k.text, pairBand, fact.place), learned: night, confidence };
        hops.push({ fact: fact.id, from: teller, to: listener, hops: h, confidence });
      }
    }
  }
  return { town: { ...town, facts }, hops };
}

function clamp(n: number): number {
  return Math.max(-100, Math.min(100, n));
}

// Pure. Pairs together tonight gain, within the window cap; pairs long apart move back toward
// their seed. relationships must hold every pair named in ties and together.
export function driftNight(
  relationships: Record<string, number>,
  ties: Record<string, Tie>,
  night: number,
  together: [string, string][],
): { relationships: Record<string, number>; ties: Record<string, Tie>; moved: Map<string, "together" | "apart"> } {
  const rel = { ...relationships };
  const out: Record<string, Tie> = {};
  const moved = new Map<string, "together" | "apart">();
  const tonight = new Set(together.map(([a, b]) => pairKey(a, b)));
  for (const k of tonight) {
    const gains = (ties[k]?.gains ?? []).filter((g) => g > night - DRIFT_WINDOW && g < night);
    if (gains.length < DRIFT_MAX_GAINS && rel[k]! < 100) {
      rel[k] = clamp(rel[k]! + DRIFT_GAIN);
      gains.push(night);
      moved.set(k, "together");
    }
    out[k] = { last: night, gains, back: 0 };
  }
  for (const [k, tie] of Object.entries(ties)) {
    if (tonight.has(k)) continue;
    const [a, b] = k.split("|") as [string, string];
    const seed = seedScore(a, b);
    const apart = night - tie.last;
    const due = apart >= APART_DAYS ? Math.floor(apart / 7) : 0;
    let back = tie.back;
    while (back < due) {
      back++;
      const now = rel[k]!;
      if (now === seed) continue;
      rel[k] = now + (now < seed ? 1 : -1);
      moved.set(k, "apart");
    }
    out[k] = { last: tie.last, gains: tie.gains.filter((g) => g > night - DRIFT_WINDOW), back };
  }
  return { relationships: rel, ties: out, moved };
}

// Folds a committed day into the town: planner shifts, new facts, the night's gossip, drift, then
// the fact cap. Returns the town unchanged when this exact night was the last one applied: that is
// a commit that wrote the town but crashed before clearing the pending day, then ran again. An
// earlier date is applied normally (the player restored an older save backup).
// shifts are the relationship changes the planner set for this day; they land with the day, so a
// day that is never saved never moves a relationship. The night's hops and relationship changes
// are kept in lastNightLog for the diary.
export function applyNight(town: TownState, day: PendingDay, rng: Rng, shifts: readonly RelationshipShift[] = []): TownState {
  const key = dayKey(day.day);
  if (town.lastNight === key) return town;
  const before = { ...seedRelationships(), ...town.relationships };
  const relationships = { ...before };
  const ties = { ...(town.ties ?? {}) };
  const why = new Map<string, RelationshipChange["why"]>();
  for (const s of shifts) {
    const k = pairKey(s.a, s.b);
    relationships[k] = clamp(relationships[k]! + s.delta);
    ties[k] = { last: key, gains: ties[k]?.gains ?? [], back: 0 };
    why.set(k, ["planner"]);
  }
  const withNew: TownState = { ...town, relationships, facts: [...town.facts, ...factsFromDay(day)] };
  const pairs = pairsTogether(day);
  const gossip = gossipNight(withNew, day.day, pairs, rng);
  const drift = driftNight(relationships, ties, key, pairs);
  for (const [k, reason] of drift.moved) why.set(k, [...(why.get(k) ?? []), reason]);
  const changes: RelationshipChange[] = [...why.keys()]
    .sort()
    .filter((k) => drift.relationships[k] !== before[k])
    .map((k) => {
      const [a, b] = k.split("|") as [string, string];
      return { a, b, from: before[k]!, to: drift.relationships[k]!, why: why.get(k)! };
    });
  return {
    ...gossip.town,
    relationships: drift.relationships,
    ties: drift.ties,
    lastNight: key,
    facts: gossip.town.facts.slice(-MAX_FACTS),
    lastNightLog: { hops: gossip.hops, changes },
  };
}

function sourceLabel(s: FactSource, shareable: boolean): string {
  if (s.kind === "heard") return `heard from ${s.from}`;
  if (s.kind === "told") return shareable ? "the farmer told you" : "the farmer told you in confidence; do not repeat it";
  return "you saw it";
}

// The farmer a prompt is built for, and the display name of every farmer the save knows.
export type FarmerView = { farmerId: string; names: Record<string, string> };

// "about you" for the talking farmer, "about <name>" for any other farmer.
function aboutLabel(about: readonly string[], view: FarmerView): string {
  const who = about.map((id) => (id === view.farmerId ? "you" : (view.names[id] ?? "another farmer")));
  return `about ${[...new Set(who)].join(" and ")}`;
}

// One prompt line for one villager's copy of a fact. view is the talking farmer; without it (the
// talk prompt until slice A/E passes farmers in) the line names no farmer.
export function factLine(fact: Fact, k: Knowledge, view?: FarmerView): string {
  const labels = [`${sourceLabel(k.source, fact.shareable)}, ${dateLabel(k.learned)}`];
  if (view !== undefined && fact.about !== undefined && fact.about.length > 0) labels.push(aboutLabel(fact.about, view));
  if (confidenceOf(k) < HALF_REMEMBERED) labels.push("half-remembered");
  return `- ${k.text} (${labels.join("; ")})`;
}

// What this villager knows from facts, for its prompt. Facts it only saw are left out: those are
// already in its own memory. Never reads another villager's copy.
export function knownFactLines(town: TownState, npc: string, view?: FarmerView): string[] {
  return town.facts
    .map((f) => ({ f, k: f.knowers[npc] }))
    .filter((x): x is { f: Fact; k: Knowledge } => x.k !== undefined && x.k.source.kind !== "saw")
    .sort((x, y) => dayKey(y.k.learned) - dayKey(x.k.learned))
    .slice(0, MAX_PROMPT_FACTS)
    .map(({ f, k }) => factLine(f, k, view));
}
