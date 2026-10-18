// Entry point. Configuration comes from environment variables only:
//   TOWNSFOLK_MODEL        claude-cli (default) | anthropic | fake
//   TOWNSFOLK_PORT         default 7341 (always bound to 127.0.0.1)
//   TOWNSFOLK_STATE_DIR    default ~/.local/state/townsfolk, on Windows %LOCALAPPDATA%\townsfolk
//   TOWNSFOLK_TALK_MS      per-turn deadline in ms, default 7000 (the mod gives up at 8s)
//   TOWNSFOLK_PLAN_MS      deadline for one night's plan in ms (all attempts and the regen), default 120000
//   TOWNSFOLK_CLAUDE_BIN   default "claude" (on Windows found on PATH as claude.exe, .cmd or .bat)
//   TOWNSFOLK_CLAUDE_MODEL default "haiku" (fast enough to answer inside the deadline)
//   ANTHROPIC_API_KEY      required only when TOWNSFOLK_MODEL=anthropic
//   TOWNSFOLK_ANTHROPIC_MODEL default "claude-haiku-4-5"

import { homedir } from "node:os";
import { MemoryStore } from "./memory.ts";
import { anthropicAdapter, claudeCliAdapter, DEFAULT_FAKE_REPLY, fakeAdapter, type ModelAdapter } from "./model.ts";
import { defaultStateDir, isFile, resolveCommand } from "./platform.ts";
import { createBrain } from "./server.ts";

const env = process.env;

function pickModel(): ModelAdapter {
  const kind = env.TOWNSFOLK_MODEL ?? "claude-cli";
  if (kind === "claude-cli") {
    const command = resolveCommand(env.TOWNSFOLK_CLAUDE_BIN ?? "claude", process.platform, env, isFile);
    return claudeCliAdapter({ command, model: env.TOWNSFOLK_CLAUDE_MODEL ?? "haiku" });
  }
  if (kind === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("TOWNSFOLK_MODEL=anthropic needs ANTHROPIC_API_KEY in the environment");
    return anthropicAdapter({ apiKey, model: env.TOWNSFOLK_ANTHROPIC_MODEL ?? "claude-haiku-4-5" });
  }
  if (kind === "fake") return fakeAdapter([DEFAULT_FAKE_REPLY]);
  throw new Error(`unknown TOWNSFOLK_MODEL "${kind}" (expected claude-cli, anthropic or fake)`);
}

const port = Number(env.TOWNSFOLK_PORT ?? 7341);
const stateDir = env.TOWNSFOLK_STATE_DIR ?? defaultStateDir(process.platform, env, homedir());
const talkDeadlineMs = Number(env.TOWNSFOLK_TALK_MS ?? 7000);
const planDeadlineMs = Number(env.TOWNSFOLK_PLAN_MS ?? 120000);
const model = pickModel();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

createBrain({ store: new MemoryStore(stateDir), model, talkDeadlineMs, planDeadlineMs, log }).listen(port, "127.0.0.1", () => {
  log(`townsfolk brain on http://127.0.0.1:${port} model=${model.name} state=${stateDir}`);
});
