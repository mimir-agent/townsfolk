// Entry point. Configuration comes from environment variables only:
//   TOWNSFOLK_MODEL        claude-cli (default) | anthropic | fake
//   TOWNSFOLK_PORT         default 7341 (always bound to 127.0.0.1)
//   TOWNSFOLK_STATE_DIR    default ~/.local/state/townsfolk, on Windows %LOCALAPPDATA%\townsfolk
//   TOWNSFOLK_TALK_MS      per-turn deadline in ms, default 20000 (the mod gives up at 25s)
//   TOWNSFOLK_PLAN_MS      deadline for one night's plan in ms (all attempts and the regen), default 120000
//   TOWNSFOLK_CLAUDE_BIN   default "claude" (on Windows found on PATH as claude.exe, .cmd or .bat)
//   TOWNSFOLK_CLAUDE_MODEL default "haiku": talk (one warm claude process per player)
//   TOWNSFOLK_PLAN_MODEL   default "sonnet": the overnight plan only (claude-cli); with the API, TOWNSFOLK_ANTHROPIC_PLAN_MODEL
//   TOWNSFOLK_PARENT_PID   set by the mod: the brain stops when that process is gone
//   ANTHROPIC_API_KEY      required only when TOWNSFOLK_MODEL=anthropic
//   TOWNSFOLK_ANTHROPIC_MODEL default "claude-haiku-4-5": talk. TOWNSFOLK_ANTHROPIC_PLAN_MODEL default "claude-sonnet-4-5": plan

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { checkClaude, type Readiness } from "./claude-check.ts";
import { MemoryStore } from "./memory.ts";
import { anthropicAdapter, claudeCliAdapter, DEFAULT_FAKE_REPLY, fakeAdapter, type ModelAdapter } from "./model.ts";
import { type Command, defaultStateDir, isFile, resolveCommand } from "./platform.ts";
import { createBrain } from "./server.ts";

const env = process.env;

// talk: Haiku, one warm process per player, thinking off (model.ts QUICK_ENV). plan: Sonnet,
// used only by /v1/plan, with the model's own thinking.
// claude: the command the claude-cli adapters run, checked at start (claude-check.ts).
// notFound: Windows found no claude.exe/.cmd/.bat on PATH. The brain still starts so the mod can
// show why; the bare name is kept, so every talk fails with ENOENT and says so.
function pickModels(): { talk: ModelAdapter; plan: ModelAdapter; claude?: Command; notFound?: string } {
  const kind = env.TOWNSFOLK_MODEL ?? "claude-cli";
  if (kind === "claude-cli") {
    const bin = env.TOWNSFOLK_CLAUDE_BIN ?? "claude";
    let command: Command;
    let notFound: string | undefined;
    try {
      command = resolveCommand(bin, process.platform, env, isFile);
    } catch (err) {
      command = { file: bin, viaCmd: false };
      notFound = (err as Error).message;
    }
    return {
      ...(notFound !== undefined ? { notFound } : {}),
      talk: claudeCliAdapter({ command, model: env.TOWNSFOLK_CLAUDE_MODEL ?? "haiku", quick: true }),
      plan: claudeCliAdapter({ command, model: env.TOWNSFOLK_PLAN_MODEL ?? "sonnet" }),
      claude: command,
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
const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;

// With the claude CLI, check once before listening that it is found and logged in. When it is
// not, the brain still starts (so the mod can read why from /v1/health and tell the player), and
// the reason is printed here in plain words.
const readiness: Readiness =
  models.notFound !== undefined
    ? { ready: false, reason: models.notFound.slice(0, 300) }
    : models.claude
      ? await checkClaude(models.claude, env)
      : { ready: true };
if (!readiness.ready) {
  log(`NOT READY: ${readiness.reason}`);
  log("Every conversation will use the game's own lines until this is fixed and the brain is restarted.");
}

const server = createBrain({
  store: new MemoryStore(stateDir),
  model: models.talk,
  planModel: models.plan,
  talkDeadlineMs,
  planDeadlineMs,
  log,
  version,
  readiness: () => readiness,
});
server.listen(port, "127.0.0.1", () => {
  log(`townsfolk brain ${version} on http://127.0.0.1:${port} model=${models.talk.name} ready=${readiness.ready} state=${stateDir}`);
});

// Ends the warm claude processes with the brain, so none outlive it.
function stop(): void {
  models.talk.close?.();
  models.plan.close?.();
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

// Started by the mod: when the game process that started this brain is gone (even if it was
// killed and could not stop us), stop too, so no brain or claude process is left behind.
const parentPid = Number(env.TOWNSFOLK_PARENT_PID ?? 0);
if (Number.isInteger(parentPid) && parentPid > 0) {
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      log(`parent process ${parentPid} is gone; stopping`);
      stop();
    }
  }, 5000).unref();
}
