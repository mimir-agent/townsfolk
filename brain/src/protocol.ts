// Wire protocol v1 between the SMAPI bridge (mod/) and the brain.
// Every request body is parsed here and nowhere else; handlers only see typed values.

export type GameDay = {
  season: string;
  day: number;
  year: number;
  time: number;
  weather: string;
  location: string;
};

export type TranscriptLine = { speaker: "npc" | "player"; text: string };

export type TalkRequest = {
  saveId: string;
  npc: string;
  playerName: string;
  day: GameDay;
  friendship: { hearts: number; points: number };
  recentChoice?: { id: string; text: string };
  transcript: TranscriptLine[];
};

export type Choice = { id: string; text: string };

export type TalkResponse = {
  line: string;
  choices: Choice[];
  end: boolean;
  source: "model" | "fallback";
};

export type DayEvent =
  | { type: "talk"; npc: string; location: string; time: number; npcLine: string; playerChoice?: string }
  | { type: "gift"; npc: string; location: string; time: number; item: string; taste?: string };

export type DayEndRequest = { saveId: string; playerName: string; day: GameDay; events: DayEvent[] };

export class BadRequest extends Error {}

// Names become file names, so the allowed alphabet is closed: letters, digits, space, dot,
// apostrophe, underscore, hyphen. A leading dot is refused so "." and ".." cannot appear.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$/u;

function obj(v: unknown, where: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BadRequest(`${where} must be an object`);
  return v as Record<string, unknown>;
}

function str(v: unknown, where: string, max: number): string {
  if (typeof v !== "string" || v.length === 0 || v.length > max) throw new BadRequest(`${where} must be a string of 1..${max} chars`);
  return v;
}

function num(v: unknown, where: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new BadRequest(`${where} must be a number`);
  return v;
}

function name(v: unknown, where: string): string {
  const s = str(v, where, 60);
  if (!NAME.test(s)) throw new BadRequest(`${where} has characters outside the allowed set`);
  return s;
}

export function parseDay(v: unknown): GameDay {
  const d = obj(v, "day");
  return {
    season: str(d.season, "day.season", 20),
    day: num(d.day, "day.day"),
    year: num(d.year, "day.year"),
    time: num(d.time, "day.time"),
    weather: str(d.weather, "day.weather", 20),
    location: str(d.location, "day.location", 80),
  };
}

export function parseTalk(v: unknown): TalkRequest {
  const b = obj(v, "body");
  const f = obj(b.friendship, "friendship");
  const transcriptRaw = b.transcript ?? [];
  if (!Array.isArray(transcriptRaw) || transcriptRaw.length > 12) throw new BadRequest("transcript must be an array of at most 12 lines");
  const transcript = transcriptRaw.map((t, i): TranscriptLine => {
    const o = obj(t, `transcript[${i}]`);
    if (o.speaker !== "npc" && o.speaker !== "player") throw new BadRequest(`transcript[${i}].speaker must be npc or player`);
    return { speaker: o.speaker, text: str(o.text, `transcript[${i}].text`, 400) };
  });
  let recentChoice: TalkRequest["recentChoice"];
  if (b.recentChoice !== undefined && b.recentChoice !== null) {
    const c = obj(b.recentChoice, "recentChoice");
    recentChoice = { id: str(c.id, "recentChoice.id", 20), text: str(c.text, "recentChoice.text", 200) };
  }
  return {
    saveId: name(b.saveId, "saveId"),
    npc: name(b.npc, "npc"),
    playerName: str(b.playerName, "playerName", 40),
    day: parseDay(b.day),
    friendship: { hearts: num(f.hearts, "friendship.hearts"), points: num(f.points, "friendship.points") },
    recentChoice,
    transcript,
  };
}

export function parseDayEnd(v: unknown): DayEndRequest {
  const b = obj(v, "body");
  if (!Array.isArray(b.events) || b.events.length > 500) throw new BadRequest("events must be an array of at most 500");
  const events = b.events.map((e, i): DayEvent => {
    const o = obj(e, `events[${i}]`);
    const base = {
      npc: name(o.npc, `events[${i}].npc`),
      location: str(o.location, `events[${i}].location`, 80),
      time: num(o.time, `events[${i}].time`),
    };
    if (o.type === "talk") {
      return {
        type: "talk",
        ...base,
        npcLine: str(o.npcLine, `events[${i}].npcLine`, 400),
        playerChoice: o.playerChoice === undefined || o.playerChoice === null ? undefined : str(o.playerChoice, `events[${i}].playerChoice`, 200),
      };
    }
    if (o.type === "gift") {
      return {
        type: "gift",
        ...base,
        item: str(o.item, `events[${i}].item`, 80),
        taste: o.taste === undefined || o.taste === null ? undefined : str(o.taste, `events[${i}].taste`, 20),
      };
    }
    throw new BadRequest(`events[${i}].type must be talk or gift`);
  });
  return { saveId: name(b.saveId, "saveId"), playerName: str(b.playerName, "playerName", 40), day: parseDay(b.day), events };
}
