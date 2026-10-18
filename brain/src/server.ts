// Localhost HTTP server: GET /v1/health, POST /v1/talk, /v1/day-end, /v1/saved, /v1/world, /v1/plan.
// Every response carries "v": 1 and matches its schema in protocol/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CAST } from "./cast.ts";
import type { Readiness } from "./claude-check.ts";
import { dateLabel, type MemoryStore, type NpcMemory } from "./memory.ts";
import type { ModelAdapter } from "./model.ts";
import { memoriesTonight, PLAN_SESSION, PLAN_SYSTEM, plan, todayFor } from "./plan.ts";
import {
  BadRequest,
  NotReady,
  parseDayEnd,
  parsePlan,
  parseSaved,
  parseTalk,
  parseWorld,
  type DayEndResponse,
  type ErrorResponse,
  type HealthResponse,
  type PlanResponse,
  type SavedResponse,
  type TalkPartial,
  type TalkResponse,
  type WorldResponse,
} from "./protocol.ts";
import { talk, TALK_SYSTEM, talkSession } from "./talk.ts";
import { MAIN_FARMER } from "./protocol.ts";

export type BrainDeps = {
  store: MemoryStore;
  model: ModelAdapter;
  // Used only by /v1/plan. Absent: the plan uses `model`.
  planModel?: ModelAdapter;
  talkDeadlineMs: number;
  planDeadlineMs: number;
  log: (msg: string) => void;
  // The release version (brain/package.json), reported by /v1/health for the mod's version check.
  version: string;
  // Whether talk can work at all (claude-check.ts), reported by /v1/health.
  readiness: () => Readiness;
};

const MAX_BODY = 256 * 1024;

// POST /v1/talk with this in Accept streams (protocol/README.md, "Streamed talk").
export const NDJSON = "application/x-ndjson";

function wantsStream(req: IncomingMessage): boolean {
  return (req.headers.accept ?? "").split(",").some((t) => t.trim().split(";")[0] === NDJSON);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new BadRequest("body too large");
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BadRequest("body is not JSON");
  }
}

type Body = HealthResponse | TalkResponse | DayEndResponse | SavedResponse | WorldResponse | PlanResponse | ErrorResponse;

function send(res: ServerResponse, status: number, body: Body): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createBrain(deps: BrainDeps): Server {
  return createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.method === "GET" && req.url === "/v1/health") {
        const r = deps.readiness();
        return send(res, 200, { v: 1, ok: true, model: deps.model.name, version: deps.version, ...(r.ready ? { ready: true } : { ready: false, reason: r.reason }) });
      }
      if (req.method === "POST" && req.url === "/v1/talk") {
        const body = parseTalk(await readJson(req));
        const mem = await deps.store.load(body.saveId, body.npc);
        const town = await deps.store.loadTown(body.saveId);
        const ctx = todayFor(await deps.store.loadPlans(body.saveId), body.npc, body.day);
        const hostKey = await deps.store.hostKey(body.saveId);
        const loaded = Date.now() - started;
        // A caller that accepts NDJSON gets the NPC's line on its own first, the moment it is
        // written, then the whole reply. Headers go out with that first line, so everything that
        // can fail with a 4xx has already run.
        const streaming = wantsStream(req);
        let lineAt = -1;
        const onLine = streaming
          ? (line: string) => {
              lineAt = Date.now() - started;
              res.writeHead(200, { "content-type": NDJSON });
              res.write(JSON.stringify({ v: 1, partial: true, line } satisfies TalkPartial) + "\n");
            }
          : undefined;
        const reply = await talk(body, mem, town, ctx, deps.model, { deadlineMs: deps.talkDeadlineMs, log: deps.log, hostKey, onLine });
        const total = Date.now() - started;
        const phases = `load ${loaded}ms, line sent ${lineAt}ms`;
        deps.log(
          reply.source === "fallback"
            ? `talk ${body.npc} FAILED after ${total}ms (${phases}), vanilla or canned line instead: ${reply.reason}`
            : `talk ${body.npc} ${reply.source} ${total}ms (${phases}) end=${reply.end} join=${reply.happening ? "offered" : "no"}`,
        );
        if (res.headersSent) {
          res.end(JSON.stringify(reply) + "\n");
          return;
        }
        return send(res, 200, reply);
      }
      if (req.method === "POST" && req.url === "/v1/day-end") {
        const body = parseDayEnd(await readJson(req));
        const npcs = await deps.store.stage(body);
        deps.log(`day-end ${body.saveId} ${dateLabel(body.day)}: ${body.events.length} events pending for ${npcs.join(", ") || "none"}`);
        return send(res, 200, { v: 1, ok: true, pending: npcs });
      }
      if (req.method === "POST" && req.url === "/v1/saved") {
        const body = parseSaved(await readJson(req));
        const { outcome, committed } = await deps.store.commit(body.saveId, body.day);
        deps.log(`saved ${body.saveId} ${dateLabel(body.day)}: ${outcome} ${committed.join(", ")}`);
        return send(res, 200, { v: 1, ok: true, outcome, committed });
      }
      if (req.method === "POST" && req.url === "/v1/world") {
        const { v: _v, saveId, hostFarmerId, ...world } = parseWorld(await readJson(req));
        await deps.store.saveWorld(saveId, world);
        deps.log(`world ${saveId}: ${world.locations.length} locations, ${world.items.length} items, ${world.festivals.length} festivals`);
        // Save loaded: start the host's talk process and the night's plan process now, so the first
        // chat and the first night do not wait for a process to start. A farmhand's is started by
        // their first talk.
        deps.model.warm?.(talkSession(saveId, hostFarmerId ?? MAIN_FARMER), TALK_SYSTEM);
        (deps.planModel ?? deps.model).warm?.(PLAN_SESSION, PLAN_SYSTEM);
        if (hostFarmerId !== undefined) {
          const { moved, kept } = await deps.store.setHost(saveId, hostFarmerId);
          if (moved.length > 0) deps.log(`world ${saveId}: host ${hostFarmerId}; moved single-player memory to the host for ${moved.join(", ")}`);
          if (kept.length > 0) deps.log(`world ${saveId}: ${kept.join(", ")} already had a section for host ${hostFarmerId}; the single-player section was left as is`);
        }
        return send(res, 200, { v: 1, ok: true });
      }
      if (req.method === "POST" && req.url === "/v1/plan") {
        const body = parsePlan(await readJson(req));
        const world = await deps.store.loadWorld(body.saveId);
        if (world === null) throw new NotReady(`no world snapshot for ${body.saveId}; POST /v1/world at save load first`);
        const stored = new Map<string, NpcMemory>();
        for (const npc of CAST) stored.set(npc, await deps.store.load(body.saveId, npc));
        const hostKey = await deps.store.hostKey(body.saveId);
        const ctx = {
          world,
          town: await deps.store.loadTown(body.saveId),
          memories: memoriesTonight(stored, await deps.store.pending(body.saveId), body.day, hostKey),
          state: await deps.store.loadPlans(body.saveId),
          hostKey,
        };
        const { response, night } = await plan(body, ctx, deps.planModel ?? deps.model, { deadlineMs: deps.planDeadlineMs, log: deps.log });
        if (night !== null) await deps.store.recordPlan(body.saveId, night);
        for (const d of response.dropped) deps.log(`plan ${body.saveId} ${dateLabel(body.day)} dropped ${d.part}: ${d.reason}`);
        deps.log(
          `plan ${body.saveId} ${dateLabel(body.day)}: ${response.source}, ${response.schedules.length} schedules, ` +
            `happening=${response.happening ? "yes" : "no"}, quest=${response.quest ? "yes" : "no"}, ${response.dropped.length} dropped, ${Date.now() - started}ms`,
        );
        return send(res, 200, response);
      }
      return send(res, 404, { v: 1, error: "not found" });
    } catch (err) {
      // A streamed talk already sent its status; the caller sees the body end without a reply.
      if (res.headersSent) {
        deps.log(`streamed ${req.url} failed after its first line: ${(err as Error).stack ?? String(err)}`);
        res.end();
        return;
      }
      if (err instanceof BadRequest) return send(res, 400, { v: 1, error: err.message });
      if (err instanceof NotReady) return send(res, 409, { v: 1, error: err.message });
      deps.log(`500 ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      return send(res, 500, { v: 1, error: "internal error" });
    }
  });
}
