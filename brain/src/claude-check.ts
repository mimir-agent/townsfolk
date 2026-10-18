// A cheap check at brain start that the claude command can answer at all: it is found, it runs,
// and it is logged in. Every talk would otherwise fail within milliseconds and the player would
// only see the game's own line. The result goes to /v1/health (ready, reason) and the mod shows it.

import { spawn } from "node:child_process";
import { type Command, spawnPlan } from "./platform.ts";

export type Readiness = { ready: true } | { ready: false; reason: string };

export type RunResult = { code: number | null; stdout: string; stderr: string; error?: string };
export type Runner = (cmd: Command, args: string[]) => Promise<RunResult>;

const CHECK_MS = 15_000;

// Runs a command to completion, never throws: a spawn failure (ENOENT) comes back as error.
export const runCommand: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const plan = spawnPlan(cmd, args);
    const child = spawn(plan.file, plan.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsVerbatimArguments: plan.windowsVerbatimArguments,
      windowsHide: true,
      signal: AbortSignal.timeout(CHECK_MS),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", (e: NodeJS.ErrnoException) => resolve({ code: null, stdout, stderr, error: e.code ?? e.message }));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

// "claude --version" proves the command is found and runs. "claude auth status --json" says
// whether it is logged in; it prints {"loggedIn": false, ...} and exits 1 when not.
// Two outputs are not read as a failure: a CLI too old to have "auth status" (no JSON comes back),
// and an ANTHROPIC_API_KEY in the environment, which claude uses without a login.
export async function checkClaude(cmd: Command, env: NodeJS.ProcessEnv, run: Runner = runCommand): Promise<Readiness> {
  const version = await run(cmd, ["--version"]);
  if (version.error === "ENOENT") {
    return { ready: false, reason: `Claude Code was not found (tried "${cmd.file}"). Install it, check that "claude" works in a new terminal, or set TOWNSFOLK_CLAUDE_BIN to its full path.` };
  }
  if (version.error !== undefined || version.code !== 0) {
    const why = version.error ?? `exit ${version.code}`;
    return { ready: false, reason: `"${cmd.file} --version" failed (${why}): ${(version.stderr || version.stdout).trim().slice(0, 200)}` };
  }
  if (env.ANTHROPIC_API_KEY) return { ready: true };
  const auth = await run(cmd, ["auth", "status", "--json"]);
  let status: { loggedIn?: unknown };
  try {
    status = JSON.parse(auth.stdout) as typeof status;
  } catch {
    return { ready: true };
  }
  if (status.loggedIn === false) return { ready: false, reason: `Claude Code is not logged in. Open a terminal, run "claude", log in, then restart the game.` };
  return { ready: true };
}
