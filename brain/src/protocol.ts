// Wire protocol v1 between the SMAPI bridge (mod/) and the brain.
// protocol/*.schema.json is the source of truth; these types and parsers mirror it, and
// test/protocol.test.ts checks every request and response the tests use against the schemas.
// Every request body is parsed here and nowhere else; handlers only see typed values.

export const PROTOCOL_VERSION = 1;

export const SEASONS = ["spring", "summer", "fall", "winter"] as const;
export type Season = (typeof SEASONS)[number];

// A calendar day, without time or place.
export type DayRef = { season: Season; day: number; year: number };

export type GameDay = DayRef & {
  time: number;
  weather: string;
  location: string;
};

export type TranscriptLine = { speaker: "npc" | "player"; text: string };

// Game stats the bridge can read cheaply. The bridge sends all of them; the brain decides which
// ones each NPC may know (stats.ts). Every field is optional: a stat the bridge could not read
// is left out, never guessed.
export type GameStats = {
  farmName?: string;
  daysPlayed?: number;
  communityCenterRooms?: number;
  deepestMineLevel?: number;
  farmBuildings?: string[];
  money?: number;
};

export type TalkRequest = {
  v: 1;
  saveId: string;
  npc: string;
  playerName: string;
  day: GameDay;
  friendship: { hearts: number; points: number };
  recentChoice?: { id: string; text: string };
  transcript: TranscriptLine[];
  stats: GameStats;
};

export type Choice = { id: string; text: string };

export type TalkResponse = {
  v: 1;
  line: string;
  choices: Choice[];
  end: boolean;
  source: "model" | "fallback";
};

// npc took part; witnesses are the other NPCs in the same location at the time.
type EventBase = { npc: string; location: string; time: number; witnesses: string[] };

export type DayEvent =
  | (EventBase & { type: "talk"; npcLine: string; playerChoice?: string })
  | (EventBase & { type: "gift"; item: string; taste?: string });

// NPCs the bridge saw on the same map at the same time during the day, whether or not the
// player was there. Gossip passes between them overnight.
export type Together = { location: string; npcs: string[] };

export type DayEndRequest = { v: 1; saveId: string; playerName: string; day: GameDay; events: DayEvent[]; together?: Together[] };
export type DayEndResponse = { v: 1; ok: true; pending: string[] };

export type SavedRequest = { v: 1; saveId: string; day: DayRef };
export type SavedResponse = { v: 1; ok: true; outcome: "committed" | "nothing-pending" | "stale-discarded"; committed: string[] };

export type HealthResponse = { v: 1; ok: true; model: string };
export type ErrorResponse = { v: 1; error: string };

export class BadRequest extends Error {}

// Names become file names, so the allowed alphabet is closed: letters, digits, space, dot,
// apostrophe, underscore, hyphen. A leading dot is refused so "." and ".." cannot appear.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$/u;
const MAX_WITNESSES = 40;
const MAX_TOGETHER = 200;
const MAX_BUILDINGS = 100;

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

function int(v: unknown, where: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new BadRequest(`${where} must be an integer in ${min}..${max}`);
  return v;
}

function name(v: unknown, where: string): string {
  const s = str(v, where, 60);
  if (!NAME.test(s)) throw new BadRequest(`${where} has characters outside the allowed set`);
  return s;
}

function optStr(v: unknown, where: string, max: number): string | undefined {
  return v === undefined || v === null ? undefined : str(v, where, max);
}

// Body plus version check. Any v other than 1 (or none) is a 400, which the bridge treats as brain down.
function body(v: unknown): Record<string, unknown> {
  const b = obj(v, "body");
  if (b.v !== PROTOCOL_VERSION) throw new BadRequest(`unsupported protocol version ${JSON.stringify(b.v ?? null)}; this brain speaks v${PROTOCOL_VERSION}`);
  return b;
}

export function parseDayRef(v: unknown, where: string): DayRef {
  const d = obj(v, where);
  if (!SEASONS.includes(d.season as Season)) throw new BadRequest(`${where}.season must be one of ${SEASONS.join(", ")}`);
  return { season: d.season as Season, day: int(d.day, `${where}.day`, 1, 28), year: int(d.year, `${where}.year`, 1, Number.MAX_SAFE_INTEGER) };
}

export function parseDay(v: unknown): GameDay {
  const d = obj(v, "day");
  return {
    ...parseDayRef(d, "day"),
    time: int(d.time, "day.time", 600, 2600),
    weather: str(d.weather, "day.weather", 20),
    location: str(d.location, "day.location", 80),
  };
}

export function parseTalk(v: unknown): TalkRequest {
  const b = body(v);
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
    v: 1,
    saveId: name(b.saveId, "saveId"),
    npc: name(b.npc, "npc"),
    playerName: str(b.playerName, "playerName", 40),
    day: parseDay(b.day),
    friendship: { hearts: num(f.hearts, "friendship.hearts"), points: num(f.points, "friendship.points") },
    recentChoice,
    transcript,
    stats: parseStats(b.stats),
  };
}

// Only the known keys are read, so a stat a newer bridge adds can never reach a prompt until
// stats.ts says who may know it.
export function parseStats(v: unknown): GameStats {
  if (v === undefined || v === null) return {};
  const s = obj(v, "stats");
  const out: GameStats = {};
  if (s.farmName !== undefined) out.farmName = str(s.farmName, "stats.farmName", 40);
  if (s.daysPlayed !== undefined) out.daysPlayed = int(s.daysPlayed, "stats.daysPlayed", 0, Number.MAX_SAFE_INTEGER);
  if (s.communityCenterRooms !== undefined) out.communityCenterRooms = int(s.communityCenterRooms, "stats.communityCenterRooms", 0, 6);
  if (s.deepestMineLevel !== undefined) out.deepestMineLevel = int(s.deepestMineLevel, "stats.deepestMineLevel", 0, Number.MAX_SAFE_INTEGER);
  if (s.farmBuildings !== undefined) {
    if (!Array.isArray(s.farmBuildings) || s.farmBuildings.length > MAX_BUILDINGS) throw new BadRequest(`stats.farmBuildings must be an array of at most ${MAX_BUILDINGS}`);
    out.farmBuildings = s.farmBuildings.map((x, i) => str(x, `stats.farmBuildings[${i}]`, 40));
  }
  if (s.money !== undefined) out.money = int(s.money, "stats.money", 0, Number.MAX_SAFE_INTEGER);
  return out;
}

function parseTogether(v: unknown): Together[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > MAX_TOGETHER) throw new BadRequest(`together must be an array of at most ${MAX_TOGETHER}`);
  return v.map((g, i): Together => {
    const o = obj(g, `together[${i}]`);
    if (!Array.isArray(o.npcs) || o.npcs.length < 2 || o.npcs.length > MAX_WITNESSES) {
      throw new BadRequest(`together[${i}].npcs must be an array of 2..${MAX_WITNESSES} names`);
    }
    const npcs = o.npcs.map((n, j) => name(n, `together[${i}].npcs[${j}]`));
    if (new Set(npcs).size !== npcs.length) throw new BadRequest(`together[${i}].npcs has duplicates`);
    return { location: str(o.location, `together[${i}].location`, 80), npcs };
  });
}

function parseWitnesses(v: unknown, where: string, npc: string): string[] {
  if (!Array.isArray(v) || v.length > MAX_WITNESSES) throw new BadRequest(`${where} must be an array of at most ${MAX_WITNESSES} names`);
  const names = v.map((w, i) => name(w, `${where}[${i}]`));
  if (new Set(names).size !== names.length) throw new BadRequest(`${where} has duplicates`);
  if (names.includes(npc)) throw new BadRequest(`${where} must not include the event's own npc`);
  return names;
}

export function parseDayEnd(v: unknown): DayEndRequest {
  const b = body(v);
  if (!Array.isArray(b.events) || b.events.length > 500) throw new BadRequest("events must be an array of at most 500");
  const events = b.events.map((e, i): DayEvent => {
    const o = obj(e, `events[${i}]`);
    const npc = name(o.npc, `events[${i}].npc`);
    const base: EventBase = {
      npc,
      location: str(o.location, `events[${i}].location`, 80),
      time: int(o.time, `events[${i}].time`, 600, 2600),
      witnesses: parseWitnesses(o.witnesses, `events[${i}].witnesses`, npc),
    };
    if (o.type === "talk") {
      return { type: "talk", ...base, npcLine: str(o.npcLine, `events[${i}].npcLine`, 400), playerChoice: optStr(o.playerChoice, `events[${i}].playerChoice`, 200) };
    }
    if (o.type === "gift") {
      return { type: "gift", ...base, item: str(o.item, `events[${i}].item`, 80), taste: optStr(o.taste, `events[${i}].taste`, 20) };
    }
    throw new BadRequest(`events[${i}].type must be talk or gift`);
  });
  const together = parseTogether(b.together);
  return { v: 1, saveId: name(b.saveId, "saveId"), playerName: str(b.playerName, "playerName", 40), day: parseDay(b.day), events, ...(together ? { together } : {}) };
}

export function parseSaved(v: unknown): SavedRequest {
  const b = body(v);
  return { v: 1, saveId: name(b.saveId, "saveId"), day: parseDayRef(b.day, "day") };
}
