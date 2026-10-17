// Localhost HTTP server: POST /v1/talk, POST /v1/day-end, GET /v1/health.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { MemoryStore } from "./memory.ts";
import type { ModelAdapter } from "./model.ts";
import { BadRequest, parseDayEnd, parseTalk } from "./protocol.ts";
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

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

export function createBrain(deps: BrainDeps): Server {
  return createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.method === "GET" && req.url === "/v1/health") {
        return send(res, 200, { ok: true, model: deps.model.name });
      }
      if (req.method === "POST" && req.url === "/v1/talk") {
        const body = parseTalk(await readJson(req));
        const mem = await deps.store.load(body.saveId, body.npc);
        const reply = await talk(body, mem, deps.model, { deadlineMs: deps.talkDeadlineMs, log: deps.log });
        deps.log(`talk ${body.npc} ${reply.source} ${Date.now() - started}ms end=${reply.end}`);
        return send(res, 200, reply);
      }
      if (req.method === "POST" && req.url === "/v1/day-end") {
        const body = parseDayEnd(await readJson(req));
        const npcs = await deps.store.recordDay(body.saveId, body.day, body.events, body.playerName);
        deps.log(`day-end ${body.saveId} ${body.events.length} events -> ${npcs.join(", ") || "none"}`);
        return send(res, 200, { ok: true, updated: npcs });
      }
      return send(res, 404, { error: "not found" });
    } catch (err) {
      if (err instanceof BadRequest) return send(res, 400, { error: err.message });
      deps.log(`500 ${req.method} ${req.url}: ${(err as Error).stack ?? String(err)}`);
      return send(res, 500, { error: "internal error" });
    }
  });
}
