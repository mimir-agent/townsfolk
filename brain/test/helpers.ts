// Shared test helpers. post() checks every request a test sends and every response it gets
// against protocol/*.schema.json, so a fixture or a handler that drifts from the schema fails.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { MemoryStore } from "../src/memory.ts";
import type { ModelAdapter } from "../src/model.ts";
import type { GameDay, TalkRequest } from "../src/protocol.ts";
import { createBrain } from "../src/server.ts";

const PROTOCOL_DIR = join(import.meta.dirname, "..", "..", "protocol");

const ajv = new Ajv2020({ strict: true, allErrors: true, unicodeRegExp: true });
for (const file of readdirSync(PROTOCOL_DIR).filter((f) => f.endsWith(".schema.json"))) {
  ajv.addSchema(JSON.parse(readFileSync(join(PROTOCOL_DIR, file), "utf8")));
}

export const SCHEMA_IDS = readdirSync(PROTOCOL_DIR)
  .filter((f) => f.endsWith(".schema.json") && f !== "common.schema.json")
  .map((f) => f.replace(".schema.json", ""));

export function schema(id: string): ValidateFunction {
  const v = ajv.getSchema(`https://github.com/mimir-agent/townsfolk/protocol/${id}.schema.json`);
  if (!v) throw new Error(`no schema ${id}`);
  return v;
}

export function assertValid(id: string, value: unknown): void {
  const v = schema(id);
  assert.ok(v(value), `${id} schema: ${ajv.errorsText(v.errors)}\n${JSON.stringify(value)}`);
}

// Endpoint -> [request schema, response schema].
const ROUTES: Record<string, [string | null, string]> = {
  "/v1/health": [null, "health-response"],
  "/v1/talk": ["talk-request", "talk-response"],
  "/v1/day-end": ["day-end-request", "day-end-response"],
  "/v1/saved": ["saved-request", "saved-response"],
};

export const day: GameDay = { season: "spring", day: 5, year: 1, time: 1130, weather: "sunny", location: "Town" };

export function talkReq(over: Partial<TalkRequest> = {}): TalkRequest {
  return { v: 1, saveId: "Farm_123", npc: "Abigail", playerName: "Tae", day, friendship: { hearts: 2, points: 500 }, transcript: [], ...over };
}

export async function tempStore(): Promise<MemoryStore> {
  return new MemoryStore(await mkdtemp(join(tmpdir(), "townsfolk-test-")));
}

export type Client = {
  url: string;
  store: MemoryStore;
  // Schema-checked: the request must match its request schema and a 200 its response schema.
  post(path: string, body: unknown): Promise<{ status: number; json: any }>;
  // Unchecked request, for sending deliberately bad input. Error bodies are still checked.
  postRaw(path: string, body: unknown): Promise<{ status: number; json: any }>;
  get(path: string): Promise<{ status: number; json: any }>;
};

export async function withServer(model: ModelAdapter, fn: (c: Client) => Promise<void>): Promise<void> {
  const store = await tempStore();
  const server = createBrain({ store, model, talkDeadlineMs: 5000, log: () => {} });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;
  const check = async (path: string, res: Response) => {
    const json = await res.json();
    const route = ROUTES[path];
    assertValid(res.status === 200 && route ? route[1] : "error-response", json);
    return { status: res.status, json };
  };
  const postRaw = async (path: string, body: unknown) =>
    check(path, await fetch(`${url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const client: Client = {
    url,
    store,
    postRaw,
    async post(path, body) {
      const route = ROUTES[path];
      if (!route?.[0]) throw new Error(`no request schema for ${path}`);
      assertValid(route[0], body);
      return postRaw(path, body);
    },
    async get(path) {
      return check(path, await fetch(`${url}${path}`));
    },
  };
  try {
    await fn(client);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}
