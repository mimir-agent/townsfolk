// One conversation turn: build the prompt from this NPC's voice and memory, ask the model,
// validate, retry once, and fall back to a safe canned line so the game never waits forever.

import type { ModelAdapter } from "./model.ts";
import type { FarmerMemory, NpcMemory } from "./memory.ts";
import { dateLabel, farmerKey, sectionFor } from "./memory.ts";
import type { Choice, GameStats, Happening, HappeningView, TalkFact, TalkRequest, TalkResponse } from "./protocol.ts";
import { MAIN_FARMER } from "./protocol.ts";
import { describeStats, statsFor } from "./stats.ts";
import { storyFor } from "./story.ts";
import { knownFactLines, type TownState } from "./town.ts";
import { talkCard, tierFor } from "./voices.ts";

export const MAX_TURNS = 3;
export const LINE_MAX = 220;
// The prompt asks for CHOICE_ASK; validation allows up to CHOICE_MAX so a slightly long
// choice costs nothing, while a runaway one is still refused.
export const CHOICE_ASK = 45;
export const CHOICE_MAX = 80;
// Friendship points one picked reply may move, either way. The model's number is clamped into
// this range. The bridge also caps the day's total per NPC (mod/ModEntry.cs).
export const CHOICE_DELTA_MAX = 15;
// The join choice's gain, for every NPC in the happening. Fixed by the brain, not the model.
export const JOIN_GAIN = 10;
export const FACT_MAX = 200;
// Used only when a join is offered and the model marked no choice as the join.
export const JOIN_TEXT = "Mind if I join in?";

// What the night's plan says about this NPC today (plan.ts todayFor). Empty before any plan.
export type TalkContext = { goal: { text: string; progress: number } | null; happening: Happening | null };
export const NO_CONTEXT: TalkContext = { goal: null, happening: null };

const SYSTEM = `You write dialogue for one character in Stardew Valley's Pelican Town.
Reply with ONE JSON object and nothing else: no prose, no markdown fences.
Shape: {"line": string, "choices": [{"id": string, "text": string, "delta": number, "fact": {"text": string, "shareable": boolean}}], "end": boolean}
Rules:
- "line" is what the character says now: 1 to 3 short sentences, at most ${LINE_MAX} characters, in their voice. No stage directions, no quotation marks around it, no "$" or "#" characters.
- If "end" is false, give 3 or 4 "choices": things the player could say back, each a short phrase of at most ${CHOICE_ASK} characters, clearly different in tone (for example warm, playful, curious, blunt). ids are "a", "b", "c", "d".
- Each choice has "delta": how much the character's friendship with the player changes if the player says it, a whole number from -${CHOICE_DELTA_MAX} to ${CHOICE_DELTA_MAX}. Most replies are -5 to 5; save the extremes for replies that really land or really hurt.
- A choice may have "fact": something the character will remember if the player says it, written from the character's side in at most ${FACT_MAX} characters, for example a promise the player makes ("The farmer promised to bring me a cave carrot by Friday."). "shareable" is false when the player is saying it in confidence. Leave "fact" out for small talk.
- If "end" is true the conversation closes after this line and "choices" is [].
- The character only knows what is in their memory below, the facts and stats listed with it, and what happens in this conversation. Never invent past events with the player that are not in memory. Something marked "in confidence" is never repeated to anyone else. Do not mention being an AI.`;

// A join is offered when the player talks to a participant at the happening's place during its
// window, has not joined one yet today, and the conversation is not on its last turn.
export function joinOffer(req: TalkRequest, ctx: TalkContext, mustEnd: boolean): HappeningView | null {
  const h = ctx.happening;
  if (h === null || mustEnd || req.joined === true) return null;
  if (!h.participants.includes(req.npc) || req.day.location !== h.location) return null;
  if (req.day.time < h.start || req.day.time >= h.end) return null;
  return { location: h.location, topic: h.topic, participants: h.participants };
}

// The parts of a prompt that depend on what this NPC knows beyond its own memory: the game's
// scenes it was in (story.ts), the stats it may know and the facts it holds. Every prompt built
// for an NPC (talk and plan) goes through here, so the knowledge boundary is enforced in one place.
export function knowledgeBlock(npc: string, stats: GameStats, town: TownState, eventsSeen: readonly string[]): string {
  const statLines = describeStats(statsFor(npc, stats));
  const factLines = knownFactLines(town, npc);
  const story = storyFor(npc, eventsSeen);
  return [
    story.length > 0
      ? `Moments ${npc} shared with the farmer, in ${npc}'s own words (they happened; ${npc} may bring one up when it fits, never retell it word for word):\n${story.map((s) => `- ${s}`).join("\n")}`
      : "",
    statLines.length > 0 ? `What ${npc} knows about the farmer's life here:\n${statLines.join("\n")}` : "",
    factLines.length > 0 ? `Things ${npc} has heard or been told:\n${factLines.join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// The NPC's own plan for today: its goal, and the happening it is in. Nothing about anyone else's.
function todayBlock(req: TalkRequest, ctx: TalkContext, offer: HappeningView | null): string {
  const h = ctx.happening;
  return [
    ctx.goal ? `${req.npc}'s own goal these days: "${ctx.goal.text}" (progress ${ctx.goal.progress}/100). It is on their mind; bring it up only if it fits.` : "",
    h !== null && h.participants.includes(req.npc)
      ? `Today ${req.npc} is part of this, at ${h.location} from ${h.start} to ${h.end} with ${h.participants.filter((p) => p !== req.npc).join(", ")}: ${h.topic}.`
      : "",
    offer
      ? `${talkerName(req)} has walked up while it is going on. Exactly one choice must be ${talkerName(req)} asking to join in; mark that choice with "join": true. The others are normal replies.`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
}

// Characters of another farmer's latest season summary that reach the prompt.
export const OTHER_FARMER_SUMMARY = 150;

// The talking farmer's name: farmerName when the request names a farmer, else playerName (the
// single-player main farmer, as before multiplayer).
export function talkerName(req: TalkRequest): string {
  return req.farmerName ?? req.playerName;
}

// One short line about a farmer this NPC knows who is not the one talking, so the NPC can mention
// them without their history reaching the prompt: no entry and no full summary, only counts, the
// last day, and the start of the latest season summary.
export function otherFarmerLine(sec: FarmerMemory): string {
  const name = sec.farmerName || "another farmer";
  const lastEntry = sec.entries.at(-1);
  const lastSeason = sec.seasons.at(-1);
  const last = lastEntry ? dateLabel(lastEntry.day) : lastSeason ? `${lastSeason.season} of year ${lastSeason.year}` : null;
  const summary = lastSeason ? ` Latest season: ${lastSeason.text.slice(0, OTHER_FARMER_SUMMARY)}` : "";
  return `- ${name}: ${sec.talks} ${sec.talks === 1 ? "talk" : "talks"}${last ? `, last seen ${last}` : ""}.${summary}`;
}

export function buildPrompt(
  req: TalkRequest,
  mem: NpcMemory,
  town: TownState,
  ctx: TalkContext,
  mustEnd: boolean,
  offer: HappeningView | null,
  hostKey: string = MAIN_FARMER,
): { system: string; user: string } {
  const who = talkerName(req);
  const key = farmerKey(req, hostKey);
  const sec = sectionFor(mem, key);
  const memory =
    sec.entries.length === 0 && sec.seasons.length === 0 && sec.years === ""
      ? tierFor(req.friendship.hearts) === "0-2"
        ? `You have no memories of ${who} yet; treat them as someone you are just getting to know.`
        : `You have no specific memories of ${who} to draw on; keep to how close you already are, as the heart tier above says.`
      : [
          sec.firstMet
            ? `First met ${who}: ${sec.firstMet}. Talks so far: ${sec.talks}. Gifts received: ${sec.gifts}.`
            : `You have never spoken with ${who}; you have only seen them around.`,
          sec.years ? `Long ago: ${sec.years}` : "",
          ...sec.seasons.map((s) => `Earlier, ${s.season} of year ${s.year} (by day of month): ${s.text}`),
          sec.entries.length > 0 ? "Recent days:" : "",
          ...sec.entries.map((e) => `- ${dateLabel(e.day)}: ${e.text}`),
        ]
          .filter(Boolean)
          .join("\n");
  const others = Object.entries(mem.farmers).filter(([k]) => k !== key);
  const convo = req.transcript.map((t) => `${t.speaker === "npc" ? req.npc : who}: ${t.text}`).join("\n");
  const user = [
    `Character: ${req.npc}`,
    talkCard(req.npc, req.friendship.hearts),
    `Now: ${dateLabel(req.day)}, ${req.day.time} (24h clock), weather ${req.day.weather}, at ${req.day.location}.`,
    `Talking with: ${who}, friendship ${req.friendship.hearts} hearts.`,
    `Memory (only what ${req.npc} took part in or saw):\n${memory}`,
    others.length > 0
      ? `Other farmers ${req.npc} knows (each has their own history with ${req.npc}; ${req.npc} may mention them by name, but nothing above happened with them and nothing here happened with ${who}):\n${others.map(([, s]) => otherFarmerLine(s)).join("\n")}`
      : "",
    knowledgeBlock(req.npc, req.stats, town, req.eventsSeen),
    todayBlock(req, ctx, offer),
    convo ? `Conversation so far:\n${convo}` : `${who} just walked up to start a conversation.`,
    req.recentChoice ? `${who} just said: "${req.recentChoice.text}". Respond to that.` : "",
    mustEnd ? `This is the last turn: set "end" to true and close the conversation naturally.` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system: SYSTEM, user };
}

// The game's dialogue engine treats some characters as commands, so they are stripped here.
function clean(s: string): string {
  return s.replace(/[$#@%^{}<>|]/g, "").replace(/\s+/g, " ").trim();
}

export class InvalidReply extends Error {}

// A sentence ends at . ! or ? (then any closing quote) before a space or the end, unless the
// word is a title like "Mr.", which the town uses ("Mr. Qi").
const SENTENCE_END = /(?<!\b(?:Mr|Mrs|Ms|Dr|St))[.!?]+["')]*(?=\s|$)/g;

// A line over LINE_MAX keeps its whole sentences up to the cap, so a reply a few characters
// long still reaches the player instead of failing the turn. A line with no sentence end
// inside the cap cannot be cut cleanly and is refused, so the reply is retried.
export function fitLine(line: string): string {
  if (line.length === 0) throw new InvalidReply(`line length 0 outside 1..${LINE_MAX}`);
  if (line.length <= LINE_MAX) return line;
  let cut = 0;
  for (const m of line.matchAll(SENTENCE_END)) {
    const end = m.index + m[0].length;
    if (end > LINE_MAX) break;
    cut = end;
  }
  if (cut === 0) throw new InvalidReply(`line length ${line.length} over ${LINE_MAX} with no sentence end inside it`);
  return line.slice(0, cut);
}

// A whole number of friendship points, clamped into the per-choice cap. A choice without a
// delta moves nothing (0). Any other non-number is refused, so the reply is retried.
function choiceDelta(v: unknown, i: number): number {
  if (v === undefined) return 0;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new InvalidReply(`choice ${i} delta is not a number`);
  return Math.max(-CHOICE_DELTA_MAX, Math.min(CHOICE_DELTA_MAX, Math.round(v)));
}

function choiceFact(v: unknown, i: number): TalkFact | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object") throw new InvalidReply(`choice ${i} fact is not an object`);
  const f = v as Record<string, unknown>;
  if (typeof f.text !== "string") throw new InvalidReply(`choice ${i} fact has no text`);
  if (typeof f.shareable !== "boolean") throw new InvalidReply(`choice ${i} fact.shareable is not a boolean`);
  const text = clean(f.text);
  if (text.length === 0 || text.length > FACT_MAX) throw new InvalidReply(`choice ${i} fact length ${text.length} outside 1..${FACT_MAX}`);
  return { text, shareable: f.shareable };
}

// When a join is offered, exactly one choice is the join. The model marks it; if it marked none,
// the brain swaps in its own join line for the last choice (or adds one when there are 3), so the
// offer never depends on the model remembering it. Two or more marked is a bad reply.
// The join choice's delta is the brain's fixed JOIN_GAIN, and it carries no fact: what the join
// leaves behind is the join event the bridge reports.
function withJoin(choices: Choice[], marked: number[], offer: HappeningView | null): Choice[] {
  if (offer === null) return choices;
  if (marked.length > 1) throw new InvalidReply(`${marked.length} choices are marked as the join; exactly one may be`);
  const join = (c: Pick<Choice, "id" | "text">): Choice => ({ id: c.id, text: c.text, delta: JOIN_GAIN, join: true });
  if (marked.length === 1) return choices.map((c, i) => (i === marked[0] ? join(c) : c));
  const keep = choices.filter((c) => c.text.toLowerCase() !== JOIN_TEXT.toLowerCase()).slice(0, 3);
  const ids = ["a", "b", "c", "d"];
  return [...keep, join({ id: "", text: JOIN_TEXT })].map((c, i) => ({ ...c, id: ids[i]! }));
}

export function validateReply(raw: string, mustEnd: boolean, offer: HappeningView | null = null): Omit<TalkResponse, "v" | "source"> {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new InvalidReply("no JSON object in reply");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new InvalidReply("reply JSON does not parse");
  }
  if (typeof parsed !== "object" || parsed === null) throw new InvalidReply("reply is not an object");
  const p = parsed as Record<string, unknown>;
  if (typeof p.line !== "string") throw new InvalidReply("line missing");
  const line = fitLine(clean(p.line));
  const ending = mustEnd || p.end === true;
  if (ending) return { line, choices: [], end: true };
  if (!Array.isArray(p.choices) || p.choices.length < 3 || p.choices.length > 4) throw new InvalidReply("need 3 or 4 choices");
  const ids = ["a", "b", "c", "d"];
  const marked: number[] = [];
  const choices: Choice[] = p.choices.map((c, i) => {
    if (typeof c !== "object" || c === null) throw new InvalidReply(`choice ${i} is not an object`);
    const o = c as Record<string, unknown>;
    if (typeof o.text !== "string") throw new InvalidReply(`choice ${i} has no text`);
    const t = clean(o.text);
    if (t.length === 0 || t.length > CHOICE_MAX) throw new InvalidReply(`choice ${i} length ${t.length} outside 1..${CHOICE_MAX}`);
    if (o.join === true) marked.push(i);
    const fact = choiceFact(o.fact, i);
    return { id: ids[i]!, text: t, delta: choiceDelta(o.delta, i), ...(fact ? { fact } : {}) };
  });
  if (new Set(choices.map((c) => c.text.toLowerCase())).size !== choices.length) throw new InvalidReply("duplicate choices");
  // A join the brain did not offer is an ordinary reply: the flag is not passed on.
  const out = withJoin(choices, marked, offer);
  return { line, choices: out, end: false, ...(offer ? { happening: offer } : {}) };
}

export function fallback(req: TalkRequest, mustEnd: boolean): TalkResponse {
  if (mustEnd || req.recentChoice) {
    return { v: 1, line: "Ha, fair enough. Anyway, I should get going. See you around.", choices: [], end: true, source: "fallback" };
  }
  return { v: 1, line: "Hm? Sorry, my mind was somewhere else. Good to see you.", choices: [], end: true, source: "fallback" };
}

export function playerTurns(req: TalkRequest): number {
  return req.transcript.filter((t) => t.speaker === "player").length + (req.recentChoice ? 1 : 0);
}

export async function talk(
  req: TalkRequest,
  mem: NpcMemory,
  town: TownState,
  ctx: TalkContext,
  model: ModelAdapter,
  opts: { deadlineMs: number; log: (msg: string) => void; hostKey?: string },
): Promise<TalkResponse> {
  const mustEnd = playerTurns(req) >= MAX_TURNS;
  const offer = joinOffer(req, ctx, mustEnd);
  const { system, user } = buildPrompt(req, mem, town, ctx, mustEnd, offer, opts.hostKey ?? MAIN_FARMER);
  const deadline = Date.now() + opts.deadlineMs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;
    try {
      const raw = await model.complete(system, user, AbortSignal.timeout(remaining));
      return { v: 1, ...validateReply(raw, mustEnd, offer), source: "model" };
    } catch (err) {
      opts.log(`talk ${req.npc} attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }
  return fallback(req, mustEnd);
}
