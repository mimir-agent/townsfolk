// The claude-cli adapter against a stand-in `claude` (no network, no model): a node script that
// speaks the same stream-json protocol, keeps a context like the real process, and empties it on
// "/clear". POSIX only: the stand-in is run through its shebang.

import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCliAdapter, type ModelEvent } from "../src/model.ts";

const skip = process.platform === "win32";

// Answers every user message with "pid|<system prompt>|<everything it remembers>". "/clear" forgets
// everything and answers with an empty result, as the real process does.
const FAKE = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const system = fs.readFileSync(args[args.indexOf("--system-prompt-file") + 1], "utf8");
for (const n of ["-p", "--input-format", "--output-format", "--verbose", "--model", "--tools"]) {
  if (!args.includes(n)) { console.error("missing " + n); process.exit(2); }
}
let memory = [];
let buf = "";
process.stdin.setEncoding("utf8").on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\\n"); i >= 0; i = buf.indexOf("\\n")) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    const text = msg.message.content[0].text;
    console.log(JSON.stringify({ type: "system", subtype: "init" }));
    if (text === "/clear") {
      memory = [];
      console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "" }));
      continue;
    }
    memory.push(text);
    const result = [process.pid, system, ...memory].join("|");
    // With --include-partial-messages the real CLI streams the reply in text deltas first.
    if (args.includes("--include-partial-messages")) {
      for (let i = 0; i < result.length; i += 5) {
        console.log(JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: result.slice(i, i + 5) } } }));
      }
    }
    const thinkingOff = process.env.CLAUDE_CODE_DISABLE_THINKING === "1" && process.env.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING === "1" && process.env.CLAUDE_CODE_EFFORT_LEVEL === "low";
    console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result, usage: { input_tokens: 2, cache_read_input_tokens: 100, cache_creation_input_tokens: 0, output_tokens: 9, output_tokens_details: { thinking_tokens: thinkingOff ? 0 : 50 } } }));
  }
});
`;

async function fakeModel(quick = false) {
  const dir = await mkdtemp(join(tmpdir(), "townsfolk-fake-claude-"));
  const bin = join(dir, "claude");
  await writeFile(bin, FAKE);
  await chmod(bin, 0o755);
  return claudeCliAdapter({ command: { file: bin, viaCmd: false }, model: "haiku", quick });
}

test("claude-cli streams the reply as it is written, and reports usage; /clear's events never reach a call", { skip }, async () => {
  const model = await fakeModel(true);
  try {
    await model.complete("SYS", "first", sig(), undefined, { session: "S" });
    const events: ModelEvent[] = [];
    const reply = await model.complete("SYS", "second", sig(), undefined, { session: "S", onEvent: (e) => events.push(e) });
    assert.equal(events[0]?.kind, "sent", "sent comes first, after the /clear finished");
    const texts = events.flatMap((e) => (e.kind === "text" ? [e.text] : []));
    assert.ok(texts.length > 2, "more than one partial");
    assert.equal(texts.at(-1), reply, "the last partial is the whole reply");
    for (let i = 1; i < texts.length; i++) assert.ok(texts[i]!.startsWith(texts[i - 1]!), "each partial extends the one before");
    assert.ok(texts.every((t) => !t.includes("first")), "nothing from before the /clear");
    const usage = events.find((e) => e.kind === "usage");
    assert.deepEqual(usage, { kind: "usage", input: 2, cacheRead: 100, cacheWrite: 0, output: 9, thinking: 0 }, "talk runs with thinking off");
  } finally {
    model.close?.();
  }
});

test("claude-cli without quick (the plan) keeps the model's own thinking", { skip }, async () => {
  const model = await fakeModel(false);
  try {
    const events: ModelEvent[] = [];
    await model.complete("SYS", "plan", sig(), undefined, { session: "plan", onEvent: (e) => events.push(e) });
    const usage = events.find((e) => e.kind === "usage");
    assert.equal(usage?.kind === "usage" ? usage.thinking : -1, 50);
  } finally {
    model.close?.();
  }
});

const sig = () => AbortSignal.timeout(10_000);

test("claude-cli keeps one warm process per session, never shared, with the system prompt passed by file", { skip }, async () => {
  const model = await fakeModel();
  try {
    const system = 'Line one.\nSay "hi" at 100% & mean it.';
    const [pidA1, sysA1, textA1] = (await model.complete(system, "hello", sig(), undefined, { session: "A" })).split("|");
    const [pidA2] = (await model.complete(system, "again", sig(), undefined, { session: "A" })).split("|");
    const [pidB] = (await model.complete(system, "other", sig(), undefined, { session: "B" })).split("|");
    assert.equal(pidA1, pidA2, "the same session reuses its process");
    assert.notEqual(pidA1, pidB, "another session never shares it");
    assert.equal(sysA1, system);
    assert.equal(textA1, "hello");
  } finally {
    model.close?.();
  }
});

test("a second call on a session clears the process first: a new NPC's call never sees the previous chat", { skip }, async () => {
  const model = await fakeModel();
  try {
    await model.complete("SYS", "ABIGAIL-PRIVATE-CHAT", sig(), undefined, { session: "talk|farm|host" });
    const next = await model.complete("SYS", "PIERRE-FULL-CONTEXT", sig(), undefined, { session: "talk|farm|host" });
    assert.deepEqual(next.split("|").slice(1), ["SYS", "PIERRE-FULL-CONTEXT"]);
    assert.ok(!next.includes("ABIGAIL"), `leaked: ${next}`);
  } finally {
    model.close?.();
  }
});

test("after close, the next call starts a new process that remembers nothing", { skip }, async () => {
  const model = await fakeModel();
  try {
    const first = (await model.complete("SYS", "one", sig(), undefined, { session: "S" })).split("|");
    model.close?.();
    const second = (await model.complete("SYS", "two", sig(), undefined, { session: "S" })).split("|");
    assert.notEqual(first[0], second[0]);
    assert.deepEqual(second.slice(1), ["SYS", "two"]);
  } finally {
    model.close?.();
  }
});

test("a call that times out kills its process, and the next call gets a fresh one", { skip }, async () => {
  const model = await fakeModel();
  try {
    const first = (await model.complete("SYS", "one", sig(), undefined, { session: "S" })).split("|");
    await assert.rejects(model.complete("SYS", "slow", AbortSignal.abort(), undefined, { session: "S" }));
    const again = (await model.complete("SYS", "three", sig(), undefined, { session: "S" })).split("|");
    assert.notEqual(first[0], again[0]);
    assert.deepEqual(again.slice(1), ["SYS", "three"]);
  } finally {
    model.close?.();
  }
});
