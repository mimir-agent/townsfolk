// v0.1.3: the NPC's line is shown before the choices are written, the prompt prefix stays the
// same across turns (so the CLI's prompt cache hits), and talk runs without thinking or MCP.
// All offline: fake adapters, no model, no network.

import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyMemory } from "../src/memory.ts";
import { claudeArgs, DEFAULT_FAKE_REPLY, fakeAdapter, QUICK_ENV, type ModelAdapter } from "../src/model.ts";
import { NDJSON } from "../src/server.ts";
import { lineWhenComplete } from "../src/stream.ts";
import { buildPrompt, earlyLine, LINE_MAX, NO_CONTEXT, talk, TALK_SYSTEM } from "../src/talk.ts";
import { emptyTown } from "../src/town.ts";
import { assertValid, talkReq, withServer } from "./helpers.ts";

const quiet = { deadlineMs: 5000, log: () => {} };

test("lineWhenComplete: nothing until the closing quote, then the decoded line", () => {
  const full = JSON.stringify({ line: 'Hi "you", see\\this?', choices: [] });
  const quoteAt = full.indexOf('", "choices"') >= 0 ? full.indexOf('", "choices"') : full.indexOf('","choices"');
  for (let n = 0; n <= quoteAt; n++) assert.equal(lineWhenComplete(full.slice(0, n)), null, `cut at ${n}: ${full.slice(0, n)}`);
  assert.equal(lineWhenComplete(full.slice(0, quoteAt + 1)), 'Hi "you", see\\this?');
  assert.equal(lineWhenComplete(full), 'Hi "you", see\\this?');
});

test("lineWhenComplete: an escaped quote at the cut is not the end of the line", () => {
  assert.equal(lineWhenComplete('{"line": "She said \\"'), null);
  assert.equal(lineWhenComplete('{"line": "She said \\"hi\\""'), 'She said "hi"');
  assert.equal(lineWhenComplete('{"line": "ends with a backslash \\\\"'), "ends with a backslash \\");
});

test("lineWhenComplete: only a line that is the first key counts", () => {
  assert.equal(lineWhenComplete('{"choices": [{"text": "x", "line": "no"}]'), null);
  assert.equal(lineWhenComplete('```json\n{"line": "fenced is fine"'), "fenced is fine");
  assert.equal(lineWhenComplete('{\n  "line" : "spaced"'), "spaced");
});

test("earlyLine: cleaned and fitted the way validation does it, null when it could not pass", () => {
  assert.equal(earlyLine('{"line": "Hey $there #friend."'), "Hey there friend.");
  const long = "Word ".repeat(60).trim();
  assert.equal(earlyLine(JSON.stringify({ line: long })), null, "over the cap with no sentence end: validation would refuse it");
  const sentences = "Short one. " + "x".repeat(LINE_MAX);
  assert.equal(earlyLine(JSON.stringify({ line: sentences })), "Short one.");
  assert.equal(earlyLine('{"line": ""'), null);
});

// A model that writes its reply in small pieces, the way the claude stream does.
function chunkedModel(reply: string, size = 7): ModelAdapter & { seen: string[] } {
  const seen: string[] = [];
  return {
    name: "chunked",
    seen,
    async complete(_s, _u, _sig, _m, o) {
      o?.onEvent?.({ kind: "sent" });
      for (let i = size; i < reply.length + size; i += size) {
        const text = reply.slice(0, i);
        seen.push(text);
        o?.onEvent?.({ kind: "text", text });
      }
      return reply;
    },
  };
}

test("talk passes the line on once, before the reply is finished, equal to the final line", async () => {
  const model = chunkedModel(DEFAULT_FAKE_REPLY);
  const lines: { line: string; seenSoFar: number }[] = [];
  const reply = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, {
    ...quiet,
    onLine: (line) => lines.push({ line, seenSoFar: model.seen.length }),
  });
  assert.equal(lines.length, 1);
  assert.equal(lines[0]!.line, reply.line);
  const seenThen = model.seen[lines[0]!.seenSoFar - 1]!;
  assert.ok(!seenThen.includes('"id":"c"'), `the line came before the choices were written: ${seenThen}`);
  assert.equal(reply.choices.at(-1)?.bye, true, "the goodbye is still last");
});

test("talk: a first attempt that fails after its line, then a retry, sends the line once; the final reply has the retry's line", async () => {
  const bad = JSON.stringify({ line: "First try line.", choices: [{ id: "a", text: "only one" }], end: false });
  const good = JSON.stringify({ ...JSON.parse(DEFAULT_FAKE_REPLY), line: "Second try line." });
  let call = 0;
  const model: ModelAdapter = {
    name: "retry",
    async complete(_s, _u, _sig, _m, o) {
      const r = call++ === 0 ? bad : good;
      o?.onEvent?.({ kind: "text", text: r });
      return r;
    },
  };
  const lines: string[] = [];
  const reply = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, model, { ...quiet, onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, ["First try line."]);
  assert.equal(reply.line, "Second try line.", "the final reply is what the bridge keeps");
});

test("talk never passes on a line from a reply with no whole line", async () => {
  const lines: string[] = [];
  const reply = await talk(talkReq(), emptyMemory("Abigail"), emptyTown(), NO_CONTEXT, chunkedModel("Sure! Here is a line."), { ...quiet, onLine: (l) => lines.push(l) });
  assert.deepEqual(lines, []);
  assert.equal(reply.source, "fallback");
});

async function streamedTalk(model: ModelAdapter, accept: string): Promise<{ type: string; lines: unknown[] }> {
  let out!: { type: string; lines: unknown[] };
  await withServer(model, async (c) => {
    const res = await fetch(`${c.url}/v1/talk`, { method: "POST", headers: { "content-type": "application/json", accept }, body: JSON.stringify(talkReq()) });
    const text = await res.text();
    out = { type: res.headers.get("content-type") ?? "", lines: text.trim().split("\n").map((l) => JSON.parse(l)) };
  });
  return out;
}

test("/v1/talk with Accept NDJSON: the partial line first, then the whole reply, each valid against its schema", async () => {
  const { type, lines } = await streamedTalk(chunkedModel(DEFAULT_FAKE_REPLY), NDJSON);
  assert.equal(type, NDJSON);
  assert.equal(lines.length, 2);
  assertValid("talk-partial", lines[0]);
  assertValid("talk-response", lines[1]);
  const [partial, whole] = lines as [{ line: string }, { line: string; choices: { bye?: boolean }[] }];
  assert.equal(partial.line, whole.line);
  assert.equal(whole.choices.at(-1)?.bye, true);
});

test("/v1/talk with Accept NDJSON and no usable line: a plain JSON fallback, no partial", async () => {
  const { type, lines } = await streamedTalk(fakeAdapter(["THROW"]), NDJSON);
  assert.match(type, /application\/json/);
  assert.equal(lines.length, 1);
  assertValid("talk-response", lines[0]);
  assert.equal((lines[0] as { source: string }).source, "fallback");
});

test("/v1/talk without Accept NDJSON is the same single JSON body as before", async () => {
  const { type, lines } = await streamedTalk(chunkedModel(DEFAULT_FAKE_REPLY), "application/json");
  assert.match(type, /application\/json/);
  assert.equal(lines.length, 1);
  assertValid("talk-response", lines[0]);
});

test("the prompt prefix is the same across the turns of one conversation, so the prompt cache can hit", () => {
  const mem = emptyMemory("Abigail");
  const turns = [
    talkReq(),
    talkReq({ transcript: [{ speaker: "npc", text: "Hey." }], recentChoice: { id: "a", text: "Hi!" } }),
    talkReq({
      transcript: [
        { speaker: "npc", text: "Hey." },
        { speaker: "player", text: "Hi!" },
        { speaker: "npc", text: "What's up?" },
      ],
      recentChoice: { id: "b", text: "Not much." },
    }),
  ];
  const prompts = turns.map((r) => buildPrompt(r, mem, emptyTown(), NO_CONTEXT, false, null));
  for (const p of prompts) assert.equal(p.system, TALK_SYSTEM, "one system prompt for every talk, so the warm process is never restarted for it");
  // Everything before the conversation block is the same on every turn.
  const prefix = (u: string) => u.slice(0, u.search(/Conversation so far:|Tae just walked up/));
  assert.ok(prefix(prompts[0]!.user).length > 200);
  assert.equal(prefix(prompts[1]!.user), prefix(prompts[0]!.user));
  assert.equal(prefix(prompts[2]!.user), prefix(prompts[0]!.user));
});

test("talk runs claude with no MCP servers, streaming partial messages, and thinking off by environment", () => {
  const args = claudeArgs("haiku", "/tmp/x/system.txt");
  for (const flag of ["--strict-mcp-config", "--include-partial-messages", "--no-session-persistence"]) assert.ok(args.includes(flag), flag);
  assert.ok(!args.includes("--mcp-config"), "no MCP config at all");
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.deepEqual(QUICK_ENV, { CLAUDE_CODE_EFFORT_LEVEL: "low", CLAUDE_CODE_DISABLE_THINKING: "1", CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1" });
});
