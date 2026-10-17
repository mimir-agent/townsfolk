// One conversation turn: build the prompt from this NPC's voice and memory, ask the model,
// validate, retry once, and fall back to a safe canned line so the game never waits forever.

import type { ModelAdapter } from "./model.ts";
import type { NpcMemory } from "./memory.ts";
import { dateLabel } from "./memory.ts";
import type { Choice, TalkRequest, TalkResponse } from "./protocol.ts";
import { voiceFor } from "./voices.ts";

export const MAX_TURNS = 3;
export const LINE_MAX = 220;
// The prompt asks for CHOICE_ASK; validation allows up to CHOICE_MAX so a slightly long
// choice costs nothing, while a runaway one is still refused.
export const CHOICE_ASK = 45;
export const CHOICE_MAX = 80;

const SYSTEM = `You write dialogue for one character in Stardew Valley's Pelican Town.
Reply with ONE JSON object and nothing else: no prose, no markdown fences.
Shape: {"line": string, "choices": [{"id": string, "text": string}], "end": boolean}
Rules:
- "line" is what the character says now: 1 to 3 short sentences, at most ${LINE_MAX} characters, in their voice. No stage directions, no quotation marks around it, no "$" or "#" characters.
- If "end" is false, give 3 or 4 "choices": things the player could say back, each a short phrase of at most ${CHOICE_ASK} characters, clearly different in tone (for example warm, playful, curious, blunt). ids are "a", "b", "c", "d".
- If "end" is true the conversation closes after this line and "choices" is [].
- The character only knows what is in their memory below and what happens in this conversation. Never invent past events with the player that are not in memory. Do not mention being an AI.`;

export function buildPrompt(req: TalkRequest, mem: NpcMemory, mustEnd: boolean): { system: string; user: string } {
  const card = voiceFor(req.npc);
  const memory =
    mem.entries.length === 0 && mem.seasons.length === 0 && mem.years === ""
      ? `You have no memories of ${req.playerName} yet; treat them as someone you are just getting to know.`
      : [
          mem.firstMet
            ? `First met ${req.playerName}: ${mem.firstMet}. Talks so far: ${mem.talks}. Gifts received: ${mem.gifts}.`
            : `You have never spoken with ${req.playerName}; you have only seen them around.`,
          mem.years ? `Long ago: ${mem.years}` : "",
          ...mem.seasons.map((s) => `Earlier, ${s.season} of year ${s.year} (by day of month): ${s.text}`),
          mem.entries.length > 0 ? "Recent days:" : "",
          ...mem.entries.map((e) => `- ${dateLabel(e.day)}: ${e.text}`),
        ]
          .filter(Boolean)
          .join("\n");
  const convo = req.transcript.map((t) => `${t.speaker === "npc" ? req.npc : req.playerName}: ${t.text}`).join("\n");
  const user = [
    `Character: ${card.name}`,
    `Voice: ${card.voice}`,
    `Now: ${dateLabel(req.day)}, ${req.day.time} (24h clock), weather ${req.day.weather}, at ${req.day.location}.`,
    `Talking with: ${req.playerName}, friendship ${req.friendship.hearts} hearts.`,
    `Memory (only what ${card.name} took part in or saw):\n${memory}`,
    convo ? `Conversation so far:\n${convo}` : `${req.playerName} just walked up to start a conversation.`,
    req.recentChoice ? `${req.playerName} just said: "${req.recentChoice.text}". Respond to that.` : "",
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

export function validateReply(raw: string, mustEnd: boolean): Omit<TalkResponse, "v" | "source"> {
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
  const line = clean(p.line);
  if (line.length === 0 || line.length > LINE_MAX) throw new InvalidReply(`line length ${line.length} outside 1..${LINE_MAX}`);
  const ending = mustEnd || p.end === true;
  if (ending) return { line, choices: [], end: true };
  if (!Array.isArray(p.choices) || p.choices.length < 3 || p.choices.length > 4) throw new InvalidReply("need 3 or 4 choices");
  const ids = ["a", "b", "c", "d"];
  const choices: Choice[] = p.choices.map((c, i) => {
    const text = typeof c === "object" && c !== null ? (c as Record<string, unknown>).text : undefined;
    if (typeof text !== "string") throw new InvalidReply(`choice ${i} has no text`);
    const t = clean(text);
    if (t.length === 0 || t.length > CHOICE_MAX) throw new InvalidReply(`choice ${i} length ${t.length} outside 1..${CHOICE_MAX}`);
    return { id: ids[i]!, text: t };
  });
  if (new Set(choices.map((c) => c.text.toLowerCase())).size !== choices.length) throw new InvalidReply("duplicate choices");
  return { line, choices, end: false };
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
  model: ModelAdapter,
  opts: { deadlineMs: number; log: (msg: string) => void },
): Promise<TalkResponse> {
  const mustEnd = playerTurns(req) >= MAX_TURNS;
  const { system, user } = buildPrompt(req, mem, mustEnd);
  const deadline = Date.now() + opts.deadlineMs;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const remaining = deadline - Date.now();
    if (remaining < 500) break;
    try {
      const raw = await model.complete(system, user, AbortSignal.timeout(remaining));
      return { v: 1, ...validateReply(raw, mustEnd), source: "model" };
    } catch (err) {
      opts.log(`talk ${req.npc} attempt ${attempt} failed: ${(err as Error).message}`);
    }
  }
  return fallback(req, mustEnd);
}
