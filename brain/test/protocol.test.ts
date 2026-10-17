// Protocol v1: the version check, and the schemas themselves.
// Every request and response the HTTP tests send through helpers.ts is also checked there.

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_FAKE_REPLY, fakeAdapter } from "../src/model.ts";
import { assertValid, day, SCHEMA_IDS, schema, talkReq, withServer } from "./helpers.ts";

const dayEnd = {
  v: 1,
  saveId: "Farm_123",
  playerName: "Tae",
  day,
  events: [{ type: "gift", npc: "Emily", location: "SeedShop", time: 1030, witnesses: ["Pierre"], item: "Amethyst" }],
};
const saved = { v: 1, saveId: "Farm_123", day: { season: "spring", day: 5, year: 1 } };

test("a request with v: 2 (or no v) gets 400 on every POST endpoint, and the 400 body matches its schema", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const cases: [string, Record<string, unknown>][] = [
      ["/v1/talk", { ...talkReq() }],
      ["/v1/day-end", dayEnd],
      ["/v1/saved", saved],
    ];
    for (const [path, body] of cases) {
      assert.equal((await c.post(path, body)).status, 200, `${path} v1 accepted`);
      const v2 = await c.postRaw(path, { ...body, v: 2 });
      assert.equal(v2.status, 400, `${path} v2`);
      assert.match(v2.json.error, /unsupported protocol version 2/);
      const { v: _v, ...noV } = body;
      assert.equal((await c.postRaw(path, noV)).status, 400, `${path} without v`);
    }
  });
});

test("the schemas reject what the brain rejects", () => {
  const bad: [string, unknown][] = [
    ["talk-request", { ...talkReq(), v: 2 }],
    ["talk-request", { ...talkReq(), npc: "../evil" }],
    ["day-end-request", { ...dayEnd, events: [{ ...dayEnd.events[0], witnesses: undefined }] }],
    ["day-end-request", { ...dayEnd, events: [{ ...dayEnd.events[0], type: "hug" }] }],
    ["day-end-request", { ...dayEnd, events: [{ ...dayEnd.events[0], item: undefined }] }],
    ["saved-request", { ...saved, day: { season: "autumn", day: 5, year: 1 } }],
    ["saved-request", { ...saved, day: { season: "spring", day: 29, year: 1 } }],
    ["talk-response", { v: 1, line: "hi", choices: [], end: false, source: "model" }],
    ["talk-response", { v: 1, line: "hi", choices: [{ id: "a", text: "x" }], end: true, source: "model" }],
  ];
  for (const [id, value] of bad) assert.equal(schema(id)(value), false, `${id} should reject ${JSON.stringify(value)}`);
  assertValid("day-end-request", dayEnd);
  assertValid("saved-request", saved);
});

test("every schema in protocol/ compiles and is used by an endpoint", () => {
  assert.deepEqual(SCHEMA_IDS.sort(), [
    "day-end-request",
    "day-end-response",
    "error-response",
    "health-response",
    "plan-request",
    "plan-response",
    "saved-request",
    "saved-response",
    "talk-request",
    "talk-response",
    "world-request",
    "world-response",
  ]);
});
