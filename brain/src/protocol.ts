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

// Every farmer, host or farmhand, has an independent history with each NPC. farmerId is the
// decimal form of the game's Farmer.UniqueMultiplayerID; farmerName is that farmer's display
// name. Both are optional on the wire: a request without farmerId is from the single-player
// main farmer, whose memory section is keyed MAIN_FARMER until a world request names the host.
export const MAIN_FARMER = "main";
export type FarmerRef = { farmerId?: string; farmerName?: string };

export type TalkRequest = FarmerRef & {
  v: 1;
  saveId: string;
  npc: string;
  playerName: string;
  day: GameDay;
  friendship: { hearts: number; points: number };
  recentChoice?: { id: string; text: string };
  // The player already joined a happening today, so no join choice is offered again.
  joined?: boolean;
  transcript: TranscriptLine[];
  stats: GameStats;
  // Ids of the game's scripted events the player has seen. story.ts keeps only the ones this
  // NPC was in. Empty when the bridge sends none.
  eventsSeen: string[];
};

// Something the NPC remembers from a picked reply (a promise, a confession). shareable false
// means told in confidence.
export type TalkFact = { text: string; shareable: boolean };

// delta is the friendship change the bridge applies when this choice is picked.
export type Choice = { id: string; text: string; delta: number; fact?: TalkFact; join?: true };

// The happening a join choice is about, as the bridge needs it to report the join.
export type HappeningView = { location: string; topic: string; participants: string[] };

export type TalkResponse = {
  v: 1;
  line: string;
  choices: Choice[];
  end: boolean;
  source: "model" | "fallback";
  happening?: HappeningView;
};

// npc took part; witnesses are the other NPCs in the same location at the time. For a join,
// witnesses are the other happening participants only.
// farmerId and farmerName: the farmer it happened with (FarmerRef above).
type EventBase = FarmerRef & { npc: string; location: string; time: number; witnesses: string[] };

export type DayEvent =
  | (EventBase & { type: "talk"; npcLine: string; playerChoice?: string; fact?: TalkFact })
  | (EventBase & { type: "gift"; item: string; taste?: string })
  | (EventBase & { type: "join"; topic: string })
  // The game's own dialogue answered this click, not ours (first meeting, a quest, a birthday,
  // story dialogue). Recorded so memory knows they talked; the game's words are not sent.
  | (EventBase & { type: "chat"; reason: VanillaReason });

export const VANILLA_REASONS = ["first-meeting", "quest", "birthday", "story"] as const;
export type VanillaReason = (typeof VANILLA_REASONS)[number];

// NPCs the bridge saw on the same map at the same time during the day, whether or not the
// player was there. Gossip passes between them overnight.
export type Together = { location: string; npcs: string[] };

export type DayEndRequest = { v: 1; saveId: string; playerName: string; day: GameDay; events: DayEvent[]; together?: Together[] };
export type DayEndResponse = { v: 1; ok: true; pending: string[] };

export type SavedRequest = { v: 1; saveId: string; day: DayRef };
export type SavedResponse = { v: 1; ok: true; outcome: "committed" | "nothing-pending" | "stale-discarded"; committed: string[] };

// The world as the bridge sees it at save load. The planner's validator checks every plan part
// against it; the bridge later re-checks only what needs the live game (is the tile passable).
export type WorldLocation = { name: string; width: number; height: number };
export type WorldItem = { id: string; name: string };
export type CalendarDay = { season: Season; day: number; name: string };
export type WorldRequest = {
  v: 1;
  saveId: string;
  locations: WorldLocation[];
  items: WorldItem[];
  festivals: CalendarDay[];
  married: string[];
  // The host's farmerId. A world request that carries it moves every NPC's MAIN_FARMER memory
  // section to this id (memory.ts MemoryStore.setHost), and from then on a request without a
  // farmerId is the host's.
  hostFarmerId?: string;
};
export type WorldResponse = { v: 1; ok: true };

// day is the date being planned (tomorrow, seen from the night before).
// hearts: the farmer's friendship hearts with each NPC, so the planner picks each card's heart
// tier. An NPC left out (or a bridge that sends no map yet) is planned at 0 hearts, the guarded tier.
// eventsSeen: as in TalkRequest; the planner gives each NPC only its own scenes.
// farmers: every farmer in the game tonight, with that farmer's own hearts. A friendship shift
// may name one of them by farmerId; a shift naming anyone else is dropped. A bridge that
// predates multiplayer sends none.
export type PlanFarmer = { farmerId: string; farmerName: string; hearts: Record<string, number> };
export type PlanRequest = {
  v: 1;
  saveId: string;
  playerName: string;
  day: DayRef;
  stats: GameStats;
  hearts: Record<string, number>;
  eventsSeen: string[];
  farmers?: PlanFarmer[];
};

export type ScheduleStop = { time: number; location: string; x: number; y: number; facing: number };
export type PlannedSchedule = { npc: string; stops: ScheduleStop[] };
export type GoalView = { npc: string; text: string; progress: number; isNew: boolean };
export type Happening = { location: string; start: number; end: number; participants: string[]; topic: string };
export type MailQuest = { id: string; item: string; from: string; reward: number; text: string };
// farmerId absent: the shift is for the host.
export type FriendshipShift = { npc: string; delta: number; reason: string; farmerId?: string };
export type RelationshipShift = { a: string; b: string; delta: number; reason: string };
export type DroppedPart = { part: string; reason: string };

export type PlanResponse = {
  v: 1;
  day: DayRef;
  // model: planned by the model (some parts may be dropped). fallback: the model gave nothing
  // usable twice, so the whole town runs vanilla. festival: festival days are never planned.
  source: "model" | "fallback" | "festival";
  schedules: PlannedSchedule[];
  goals: GoalView[];
  happening: Happening | null;
  quest: MailQuest | null;
  friendship: FriendshipShift[];
  relationships: RelationshipShift[];
  dropped: DroppedPart[];
};

export type HealthResponse = { v: 1; ok: true; model: string };
export type ErrorResponse = { v: 1; error: string };

export class BadRequest extends Error {}
// The request is well formed but the brain lacks state it needs first (HTTP 409).
export class NotReady extends Error {}

// Names become file names, so the allowed alphabet is closed: letters, digits, space, dot,
// apostrophe, underscore, hyphen. A leading dot is refused so "." and ".." cannot appear.
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$/u;
const MAX_WITNESSES = 40;
const MAX_TOGETHER = 200;
const MAX_BUILDINGS = 100;
const MAX_LOCATIONS = 200;
// The bridge sends the items the planner may use in quests, not every item in the game.
const MAX_ITEMS = 300;
const MAX_FESTIVALS = 40;
// A long save has seen a few hundred events at most; the cap only bounds the body.
const MAX_EVENTS_SEEN = 2000;
const EVENT_ID = /^[A-Za-z0-9_.-]{1,60}$/;
// Farmer.UniqueMultiplayerID is a signed 64-bit integer, sent in decimal.
const FARMER_ID = /^-?[0-9]{1,20}$/;
// The game allows at most 8 farmers in one save.
export const MAX_FARMERS = 8;
// Location names end up in game schedule strings, which split on spaces and slashes.
export const LOCATION_NAME = /^[A-Za-z0-9_.-]{1,80}$/;

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

function farmerId(v: unknown, where: string): string {
  const s = str(v, where, 21);
  if (!FARMER_ID.test(s)) throw new BadRequest(`${where} must be a decimal farmer id`);
  return s;
}

// Both or neither. A name alone cannot say whose memory section it is, and an id alone leaves
// the NPC without a name to remember the farmer by.
function farmerRef(o: Record<string, unknown>, where: string): FarmerRef {
  const hasId = o.farmerId !== undefined && o.farmerId !== null;
  const hasName = o.farmerName !== undefined && o.farmerName !== null;
  if (hasId !== hasName) throw new BadRequest(`${where}farmerId and ${where}farmerName come together or not at all`);
  if (!hasId) return {};
  return { farmerId: farmerId(o.farmerId, `${where}farmerId`), farmerName: str(o.farmerName, `${where}farmerName`, 40) };
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
  if (b.joined !== undefined && typeof b.joined !== "boolean") throw new BadRequest("joined must be a boolean");
  return {
    v: 1,
    saveId: name(b.saveId, "saveId"),
    npc: name(b.npc, "npc"),
    playerName: str(b.playerName, "playerName", 40),
    ...farmerRef(b, ""),
    day: parseDay(b.day),
    friendship: { hearts: num(f.hearts, "friendship.hearts"), points: num(f.points, "friendship.points") },
    recentChoice,
    ...(b.joined === true ? { joined: true } : {}),
    transcript,
    stats: parseStats(b.stats),
    eventsSeen: parseEventsSeen(b.eventsSeen),
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

function parseTalkFact(v: unknown, where: string): TalkFact | undefined {
  if (v === undefined || v === null) return undefined;
  const o = obj(v, where);
  if (typeof o.shareable !== "boolean") throw new BadRequest(`${where}.shareable must be a boolean`);
  return { text: str(o.text, `${where}.text`, 200), shareable: o.shareable };
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
      ...farmerRef(o, `events[${i}].`),
      npc,
      location: str(o.location, `events[${i}].location`, 80),
      time: int(o.time, `events[${i}].time`, 600, 2600),
      witnesses: parseWitnesses(o.witnesses, `events[${i}].witnesses`, npc),
    };
    if (o.type === "talk") {
      const fact = parseTalkFact(o.fact, `events[${i}].fact`);
      return {
        type: "talk",
        ...base,
        npcLine: str(o.npcLine, `events[${i}].npcLine`, 400),
        playerChoice: optStr(o.playerChoice, `events[${i}].playerChoice`, 200),
        ...(fact ? { fact } : {}),
      };
    }
    if (o.type === "gift") {
      return { type: "gift", ...base, item: str(o.item, `events[${i}].item`, 80), taste: optStr(o.taste, `events[${i}].taste`, 20) };
    }
    if (o.type === "join") {
      return { type: "join", ...base, topic: str(o.topic, `events[${i}].topic`, 120) };
    }
    if (o.type === "chat") {
      if (!VANILLA_REASONS.includes(o.reason as VanillaReason)) throw new BadRequest(`events[${i}].reason must be one of ${VANILLA_REASONS.join(", ")}`);
      return { type: "chat", ...base, reason: o.reason as VanillaReason };
    }
    throw new BadRequest(`events[${i}].type must be talk, gift, join or chat`);
  });
  const together = parseTogether(b.together);
  return { v: 1, saveId: name(b.saveId, "saveId"), playerName: str(b.playerName, "playerName", 40), day: parseDay(b.day), events, ...(together ? { together } : {}) };
}

export function parseSaved(v: unknown): SavedRequest {
  const b = body(v);
  return { v: 1, saveId: name(b.saveId, "saveId"), day: parseDayRef(b.day, "day") };
}

function list(v: unknown, where: string, max: number): unknown[] {
  if (!Array.isArray(v) || v.length > max) throw new BadRequest(`${where} must be an array of at most ${max}`);
  return v;
}

export function parseWorld(v: unknown): WorldRequest {
  const b = body(v);
  const locations = list(b.locations, "locations", MAX_LOCATIONS).map((l, i): WorldLocation => {
    const o = obj(l, `locations[${i}]`);
    const n = str(o.name, `locations[${i}].name`, 80);
    if (!LOCATION_NAME.test(n)) throw new BadRequest(`locations[${i}].name has characters outside A-Z a-z 0-9 _ . -`);
    return { name: n, width: int(o.width, `locations[${i}].width`, 1, 1000), height: int(o.height, `locations[${i}].height`, 1, 1000) };
  });
  if (new Set(locations.map((l) => l.name)).size !== locations.length) throw new BadRequest("locations has duplicate names");
  const items = list(b.items, "items", MAX_ITEMS).map((it, i): WorldItem => {
    const o = obj(it, `items[${i}]`);
    return { id: str(o.id, `items[${i}].id`, 60), name: str(o.name, `items[${i}].name`, 80) };
  });
  const festivals = list(b.festivals, "festivals", MAX_FESTIVALS).map((f, i): CalendarDay => {
    const o = obj(f, `festivals[${i}]`);
    if (!SEASONS.includes(o.season as Season)) throw new BadRequest(`festivals[${i}].season must be one of ${SEASONS.join(", ")}`);
    return { season: o.season as Season, day: int(o.day, `festivals[${i}].day`, 1, 28), name: str(o.name, `festivals[${i}].name`, 60) };
  });
  const married = list(b.married, "married", MAX_WITNESSES).map((n, i) => name(n, `married[${i}]`));
  const host = b.hostFarmerId === undefined || b.hostFarmerId === null ? {} : { hostFarmerId: farmerId(b.hostFarmerId, "hostFarmerId") };
  return { v: 1, saveId: name(b.saveId, "saveId"), locations, items, festivals, married, ...host };
}

export function parsePlan(v: unknown): PlanRequest {
  const b = body(v);
  const farmers = parseFarmers(b.farmers);
  return {
    v: 1,
    saveId: name(b.saveId, "saveId"),
    playerName: str(b.playerName, "playerName", 40),
    day: parseDayRef(b.day, "day"),
    stats: parseStats(b.stats),
    hearts: parseHearts(b.hearts, "hearts"),
    eventsSeen: parseEventsSeen(b.eventsSeen),
    ...(farmers ? { farmers } : {}),
  };
}

function parseFarmers(v: unknown): PlanFarmer[] | undefined {
  if (v === undefined || v === null) return undefined;
  const farmers = list(v, "farmers", MAX_FARMERS).map((f, i): PlanFarmer => {
    const o = obj(f, `farmers[${i}]`);
    return {
      farmerId: farmerId(o.farmerId, `farmers[${i}].farmerId`),
      farmerName: str(o.farmerName, `farmers[${i}].farmerName`, 40),
      hearts: parseHearts(o.hearts, `farmers[${i}].hearts`),
    };
  });
  if (new Set(farmers.map((f) => f.farmerId)).size !== farmers.length) throw new BadRequest("farmers has duplicate farmerIds");
  return farmers;
}

// Event ids the player has seen. Duplicates are dropped; order does not matter.
function parseEventsSeen(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  const ids = list(v, "eventsSeen", MAX_EVENTS_SEEN).map((id, i) => {
    const s = str(id, `eventsSeen[${i}]`, 60);
    if (!EVENT_ID.test(s)) throw new BadRequest(`eventsSeen[${i}] has characters outside A-Z a-z 0-9 _ . -`);
    return s;
  });
  return [...new Set(ids)];
}

// 0 to 14: 10 is the cap for a friend, 14 for a spouse.
function parseHearts(v: unknown, where: string): Record<string, number> {
  if (v === undefined || v === null) return {};
  const h = obj(v, where);
  const out: Record<string, number> = {};
  for (const [npc, n] of Object.entries(h)) out[name(npc, `${where} key`)] = int(n, `${where}.${npc}`, 0, 14);
  return out;
}
