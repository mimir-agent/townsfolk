// v0.1.2: every way a talk can fail says why. Taurean's Mac fell back to vanilla within a fraction
// of a second on every chat and the logs said only "no usable reply". These tests run each fast
// failure (no network, no model) and check the reply carries a reason, the brain logs it with the
// elapsed ms, and /v1/health reports the brain's version and whether claude can answer at all.

import assert from "node:assert/strict";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkClaude, type RunResult } from "../src/claude-check.ts";
import { claudeCliAdapter, DEFAULT_FAKE_REPLY, fakeAdapter, type ModelAdapter } from "../src/model.ts";
import { TEST_VERSION, talkReq, withServer } from "./helpers.ts";

const posixOnly = process.platform === "win32";

// A stand-in claude that answers every message with the given stream-json result line.
async function standIn(script: string): Promise<ModelAdapter> {
  const dir = await mkdtemp(join(tmpdir(), "townsfolk-fail-"));
  const bin = join(dir, "claude");
  await writeFile(bin, script);
  await chmod(bin, 0o755);
  return claudeCliAdapter({ command: { file: bin, viaCmd: false }, model: "haiku" });
}

const answering = (result: object) => `#!/usr/bin/env node
process.stdin.setEncoding("utf8").on("data", (d) => { for (const l of d.split("\\n").filter(Boolean)) console.log(${JSON.stringify(JSON.stringify(result))}); });
`;

async function talkOnce(model: ModelAdapter): Promise<{ status: number; json: any; logs: string[] }> {
  const logs: string[] = [];
  let out!: { status: number; json: any };
  try {
    await withServer(model, async (c) => {
      out = await c.post("/v1/talk", talkReq());
    }, (m) => logs.push(m));
  } finally {
    model.close?.();
  }
  return { ...out, logs };
}

function assertFastFallback(r: { status: number; json: any; logs: string[] }, reason: RegExp): void {
  assert.equal(r.status, 200);
  assert.equal(r.json.source, "fallback");
  assert.match(r.json.reason, reason);
  const line = r.logs.find((l) => l.startsWith("talk Abigail FAILED after "));
  assert.ok(line, `no failure log line in:\n${r.logs.join("\n")}`);
  assert.match(line, /FAILED after \d+ms/);
  assert.match(line, reason);
}

test("model throws (fake adapter): fallback says the model call failed", async () => {
  assertFastFallback(await talkOnce(fakeAdapter(["THROW"])), /model call failed: fake adapter failure/);
});

test("model returns text that is not JSON: fallback says validation failed", async () => {
  assertFastFallback(await talkOnce(fakeAdapter(["Sure! Here is a line."])), /model reply failed validation: no JSON object in reply/);
});

test("model returns JSON of the wrong shape: fallback names the rule it broke", async () => {
  const bad = JSON.stringify({ line: "Hi.", choices: [{ id: "a", text: "x" }], end: false });
  assertFastFallback(await talkOnce(fakeAdapter([bad])), /model reply failed validation: need 3 or 4 choices/);
});

test("claude binary not found: fallback says spawn ENOENT", { skip: posixOnly }, async () => {
  const model = claudeCliAdapter({ command: { file: "/nonexistent/claude", viaCmd: false }, model: "haiku" });
  assertFastFallback(await talkOnce(model), /model call failed: spawn \/nonexistent\/claude ENOENT/);
});

test("claude exits nonzero: fallback carries its exit code and stderr", { skip: posixOnly }, async () => {
  const model = await standIn(`#!/bin/sh\necho "Invalid API key - Please run /login" >&2\nexit 1\n`);
  assertFastFallback(await talkOnce(model), /claude exited 1: Invalid API key - Please run \/login/);
});

test("claude returns an error result (not logged in): fallback carries it", { skip: posixOnly }, async () => {
  const model = await standIn(answering({ type: "result", is_error: true, result: "Not logged in" }));
  assertFastFallback(await talkOnce(model), /claude returned an error result: .*Not logged in/);
});

test("a model reply is not given a reason", async () => {
  const r = await talkOnce(fakeAdapter([DEFAULT_FAKE_REPLY]));
  assert.equal(r.json.source, "model");
  assert.equal(r.json.reason, undefined);
});

test("a long reason is cut to the schema's 300 characters", async () => {
  const r = await talkOnce(fakeAdapter(["x".repeat(50) + "{" + "y".repeat(600)]));
  assert.equal(r.json.source, "fallback");
  assert.ok(r.json.reason.length <= 300);
});

test("/v1/health reports the brain's version and ready; not ready carries the reason", async () => {
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const h = await c.get("/v1/health");
    assert.deepEqual(h.json, { v: 1, ok: true, model: "fake", version: TEST_VERSION, ready: true });
  });
  const why = 'Claude Code is not logged in. Open a terminal, run "claude", log in, then restart the game.';
  await withServer(fakeAdapter([DEFAULT_FAKE_REPLY]), async (c) => {
    const h = await c.get("/v1/health");
    assert.equal(h.json.ready, false);
    assert.equal(h.json.reason, why);
  }, () => {}, () => ({ ready: false, reason: why }));
});

// checkClaude with a scripted runner: no process is started.
function runner(results: Record<string, RunResult>) {
  const asked: string[] = [];
  return {
    asked,
    run: async (_cmd: unknown, args: string[]) => {
      asked.push(args.join(" "));
      return results[args.join(" ")] ?? { code: 0, stdout: "", stderr: "" };
    },
  };
}
const cmd = { file: "claude", viaCmd: false };

test("checkClaude: not found on PATH", async () => {
  const r = runner({ "--version": { code: null, stdout: "", stderr: "", error: "ENOENT" } });
  const out = await checkClaude(cmd, {}, r.run);
  assert.equal(out.ready, false);
  assert.match(out.ready ? "" : out.reason, /Claude Code was not found \(tried "claude"\)/);
  assert.deepEqual(r.asked, ["--version"], "no login check after a missing command");
});

test("checkClaude: --version fails", async () => {
  const out = await checkClaude(cmd, {}, runner({ "--version": { code: 3, stdout: "", stderr: "boom" } }).run);
  assert.deepEqual(out, { ready: false, reason: '"claude --version" failed (exit 3): boom' });
});

test("checkClaude: not logged in", async () => {
  const r = runner({ "--version": { code: 0, stdout: "2.1.0 (Claude Code)", stderr: "" }, "auth status --json": { code: 1, stdout: '{"loggedIn": false}', stderr: "" } });
  const out = await checkClaude(cmd, {}, r.run);
  assert.equal(out.ready, false);
  assert.match(out.ready ? "" : out.reason, /not logged in/);
});

test("checkClaude: logged in, an API key in the environment, or a CLI without auth status are all ready", async () => {
  const ok = { "--version": { code: 0, stdout: "2.1.0", stderr: "" } };
  assert.deepEqual(await checkClaude(cmd, {}, runner({ ...ok, "auth status --json": { code: 0, stdout: '{"loggedIn": true}', stderr: "" } }).run), { ready: true });
  const withKey = runner({ ...ok, "auth status --json": { code: 1, stdout: '{"loggedIn": false}', stderr: "" } });
  assert.deepEqual(await checkClaude(cmd, { ANTHROPIC_API_KEY: "set" }, withKey.run), { ready: true });
  assert.deepEqual(withKey.asked, ["--version"]);
  assert.deepEqual(await checkClaude(cmd, {}, runner({ ...ok, "auth status --json": { code: 1, stdout: "", stderr: "unknown command" } }).run), { ready: true });
});
