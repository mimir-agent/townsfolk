// Localhost HTTP server: GET /v1/health, POST /v1/talk, POST /v1/day-end, POST /v1/saved.
// Every response carries "v": 1 and matches its schema in protocol/.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dateLabel, type MemoryStore } from "./memory.ts";
import type { ModelAdapter } from "./model.ts";
import {
  BadRequest,
  parseDayEnd,
  parseSaved,
  parseTalk,
  type DayEndResponse,
  type ErrorResponse,
  type HealthResponse,
  type SavedResponse,
  type TalkResponse,
} from "./protocol.ts";
import { talk } from "./talk.ts";

export type BrainDeps = {
  store: MemoryStore;
  model: ModelAdapter;
  talkDeadlineMs: number;
  log: (msg: string) => void;
};

const MAX_BODY = 256 * 1024;

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

type Body = HealthResponse | TalkResponse | DayEndResponse | SavedResponse | ErrorResponse;

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
        return send(res, 200, { v: 1, ok: true, model: deps.model.name });
      }
      if (req.method === "POST" && req.url === "/v1/talk") {
        const body = parseTalk(await readJson(req));
        const mem = await deps.store.load(body.saveId, body.npc);
        const town = await deps.store.loadTown(body.saveId);
        const reply = await talk(body, mem, town, deps.model, { deadlineMs: deps.talkDeadlineMs, log: deps.log });
        deps.log(`talk ${body.npc} ${reply.source} ${Date.now() - started}ms end=${reply.end}`);
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
      return send(res, 404, { v: 1, error: "not found" });
    } catch (err) {
      if (err instanceof BadRequest) return send(res, 400, { v: 1, error: err.message });
      deps.log(`500 ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      return send(res, 500, { v: 1, error: "internal error" });
    }
  });
}
