// Entry point. Configuration comes from environment variables only:
//   TOWNSFOLK_MODEL        claude-cli (default) | anthropic | fake
//   TOWNSFOLK_PORT         default 7341 (always bound to 127.0.0.1)
//   TOWNSFOLK_STATE_DIR    default ~/.local/state/townsfolk, on Windows %LOCALAPPDATA%\townsfolk
//   TOWNSFOLK_TALK_MS      per-turn deadline in ms, default 20000 (the mod gives up at 25s)
//   TOWNSFOLK_PLAN_MS      deadline for one night's plan in ms (all attempts and the regen), default 120000
//   TOWNSFOLK_CLAUDE_BIN   default "claude" (on Windows found on PATH as claude.exe, .cmd or .bat)
//   TOWNSFOLK_CLAUDE_MODEL default "haiku": talk (one warm claude process per player)
//   TOWNSFOLK_PLAN_MODEL   default "sonnet": the overnight plan only (claude-cli); with the API, TOWNSFOLK_ANTHROPIC_PLAN_MODEL
//   ANTHROPIC_API_KEY      required only when TOWNSFOLK_MODEL=anthropic
//   TOWNSFOLK_ANTHROPIC_MODEL default "claude-haiku-4-5": talk. TOWNSFOLK_ANTHROPIC_PLAN_MODEL default "claude-sonnet-4-5": plan

import { homedir } from "node:os";
import { MemoryStore } from "./memory.ts";
import { anthropicAdapter, claudeCliAdapter, DEFAULT_FAKE_REPLY, fakeAdapter, type ModelAdapter } from "./model.ts";
import { defaultStateDir, isFile, resolveCommand } from "./platform.ts";
import { createBrain } from "./server.ts";

const env = process.env;

// talk: Haiku, one warm process per player. plan: Sonnet, used only by /v1/plan.
function pickModels(): { talk: ModelAdapter; plan: ModelAdapter } {
  const kind = env.TOWNSFOLK_MODEL ?? "claude-cli";
  if (kind === "claude-cli") {
    const command = resolveCommand(env.TOWNSFOLK_CLAUDE_BIN ?? "claude", process.platform, env, isFile);
    return {
      talk: claudeCliAdapter({ command, model: env.TOWNSFOLK_CLAUDE_MODEL ?? "haiku" }),
      plan: claudeCliAdapter({ command, model: env.TOWNSFOLK_PLAN_MODEL ?? "sonnet" }),
    };
  }
  if (kind === "anthropic") {
    const apiKey = env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("TOWNSFOLK_MODEL=anthropic needs ANTHROPIC_API_KEY in the environment");
    return {
      talk: anthropicAdapter({ apiKey, model: env.TOWNSFOLK_ANTHROPIC_MODEL ?? "claude-haiku-4-5" }),
      plan: anthropicAdapter({ apiKey, model: env.TOWNSFOLK_PLAN_MODEL ?? "claude-sonnet-4-5" }),
    };
  }
  if (kind === "fake") {
    const fake = fakeAdapter([DEFAULT_FAKE_REPLY]);
    return { talk: fake, plan: fake };
  }
  throw new Error(`unknown TOWNSFOLK_MODEL "${kind}" (expected claude-cli, anthropic or fake)`);
}

const port = Number(env.TOWNSFOLK_PORT ?? 7341);
const stateDir = env.TOWNSFOLK_STATE_DIR ?? defaultStateDir(process.platform, env, homedir());
const talkDeadlineMs = Number(env.TOWNSFOLK_TALK_MS ?? 20000);
const planDeadlineMs = Number(env.TOWNSFOLK_PLAN_MS ?? 120000);
const models = pickModels();
const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

const server = createBrain({ store: new MemoryStore(stateDir), model: models.talk, planModel: models.plan, talkDeadlineMs, planDeadlineMs, log });
server.listen(port, "127.0.0.1", () => {
  log(`townsfolk brain on http://127.0.0.1:${port} model=${models.talk.name} state=${stateDir}`);
});

// Ends the warm claude processes with the brain, so none outlive it.
function stop(): void {
  models.talk.close?.();
  models.plan.close?.();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
