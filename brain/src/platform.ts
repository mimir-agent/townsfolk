// Startup paths that differ between Windows and macOS/Linux. Pure functions (platform, env and
// the file check are passed in) so the tests can run the Windows rules on any machine.

import { statSync } from "node:fs";
import { posix, win32 } from "node:path";

// The real file check for resolveCommand.
export function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() === true;
}

// Where memory lives when TOWNSFOLK_STATE_DIR is not set.
export function defaultStateDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (!local) throw new Error("LOCALAPPDATA is not set; set TOWNSFOLK_STATE_DIR to the folder the brain should keep memory in");
    return win32.join(local, "townsfolk");
  }
  return posix.join(home, ".local", "state", "townsfolk");
}

// How to start a command-line program. viaCmd: it is a .cmd or .bat file (the npm install of
// Claude Code puts claude.cmd on PATH), which Windows can only run through cmd.exe.
export type Command = { file: string; viaCmd: boolean };

const WINDOWS_EXTS = [".exe", ".cmd", ".bat"];

// On macOS and Linux spawn finds the program on PATH itself. On Windows it does not try
// .cmd/.bat, so look the program up the way Command Prompt would.
export function resolveCommand(
  bin: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
): Command {
  if (platform !== "win32") return { file: bin, viaCmd: false };
  const names = win32.extname(bin) ? [bin] : WINDOWS_EXTS.map((ext) => bin + ext);
  const hasDir = bin.includes("\\") || bin.includes("/");
  const dirs = hasDir ? [""] : (env.PATH ?? "").split(";").map((d) => d.replace(/^"(.*)"$/, "$1")).filter((d) => d !== "");
  for (const dir of dirs) {
    for (const name of names) {
      const file = dir === "" ? name : win32.join(dir, name);
      if (isFile(file)) return { file, viaCmd: /\.(cmd|bat)$/i.test(file) };
    }
  }
  throw new Error(
    `could not find "${bin}" (as .exe, .cmd or .bat) on PATH. Install Claude Code, check that "claude" works in a new Command Prompt, or set TOWNSFOLK_CLAUDE_BIN to its full path`,
  );
}

// What to hand to child_process.spawn. A .cmd/.bat goes through cmd.exe as one verbatim line,
// the same way Node's own shell option does it, but with every argument quoted.
export type SpawnPlan = { file: string; args: string[]; windowsVerbatimArguments: boolean };

export function spawnPlan(cmd: Command, args: string[]): SpawnPlan {
  if (!cmd.viaCmd) return { file: cmd.file, args, windowsVerbatimArguments: false };
  return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${cmdLine(cmd.file, args)}"`], windowsVerbatimArguments: true };
}

// One command line for cmd.exe /d /s /c "...". Every part is quoted. A double quote, a percent
// sign or a line break cannot be passed through cmd.exe safely, so those are refused.
export function cmdLine(file: string, args: string[]): string {
  return [file, ...args]
    .map((part) => {
      if (/["%\r\n]/.test(part)) throw new Error(`cannot pass ${JSON.stringify(part)} through cmd.exe (it holds a quote, a % or a line break)`);
      return `"${part}"`;
    })
    .join(" ");
}
