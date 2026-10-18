// Windows startup rules, run on any machine: platform, env and the file check are passed in.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cmdLine, defaultStateDir, resolveCommand, spawnPlan } from "../src/platform.ts";

const only = (...files: string[]) => (path: string) => files.includes(path);

test("state dir: %LOCALAPPDATA%\\townsfolk on Windows, ~/.local/state/townsfolk elsewhere", () => {
  assert.equal(defaultStateDir("win32", { LOCALAPPDATA: "C:\\Users\\Tae\\AppData\\Local" }, "C:\\Users\\Tae"), "C:\\Users\\Tae\\AppData\\Local\\townsfolk");
  assert.equal(defaultStateDir("darwin", {}, "/Users/tae"), "/Users/tae/.local/state/townsfolk");
  assert.equal(defaultStateDir("linux", { LOCALAPPDATA: "ignored" }, "/home/tae"), "/home/tae/.local/state/townsfolk");
});

test("state dir: Windows without LOCALAPPDATA says to set TOWNSFOLK_STATE_DIR", () => {
  assert.throws(() => defaultStateDir("win32", {}, "C:\\Users\\Tae"), /TOWNSFOLK_STATE_DIR/);
});

test("claude: macOS and Linux leave the lookup to spawn", () => {
  assert.deepEqual(resolveCommand("claude", "darwin", {}, () => false), { file: "claude", viaCmd: false });
});

test("claude: Windows finds the npm claude.cmd on PATH and runs it through cmd.exe", () => {
  const env = { PATH: "C:\\Windows\\system32;\"C:\\Users\\Tae\\AppData\\Roaming\\npm\";;" };
  const cmd = resolveCommand("claude", "win32", env, only("C:\\Users\\Tae\\AppData\\Roaming\\npm\\claude.cmd"));
  assert.deepEqual(cmd, { file: "C:\\Users\\Tae\\AppData\\Roaming\\npm\\claude.cmd", viaCmd: true });
});

test("claude: Windows prefers claude.exe (native installer) over a .cmd in the same folder", () => {
  const env = { PATH: "C:\\Users\\Tae\\.local\\bin" };
  const cmd = resolveCommand("claude", "win32", env, only("C:\\Users\\Tae\\.local\\bin\\claude.exe", "C:\\Users\\Tae\\.local\\bin\\claude.cmd"));
  assert.deepEqual(cmd, { file: "C:\\Users\\Tae\\.local\\bin\\claude.exe", viaCmd: false });
});

test("claude: Windows takes the first PATH folder that has it", () => {
  const env = { PATH: "C:\\a;C:\\b" };
  assert.equal(resolveCommand("claude", "win32", env, only("C:\\b\\claude.exe", "C:\\a\\claude.cmd")).file, "C:\\a\\claude.cmd");
});

test("claude: a full path in TOWNSFOLK_CLAUDE_BIN is used as given, with or without extension", () => {
  assert.deepEqual(resolveCommand("D:\\tools\\claude.cmd", "win32", { PATH: "" }, only("D:\\tools\\claude.cmd")), { file: "D:\\tools\\claude.cmd", viaCmd: true });
  assert.deepEqual(resolveCommand("D:\\tools\\claude", "win32", {}, only("D:\\tools\\claude.exe")), { file: "D:\\tools\\claude.exe", viaCmd: false });
});

test("claude: not on PATH on Windows is a clear error", () => {
  assert.throws(() => resolveCommand("claude", "win32", { PATH: "C:\\Windows" }, () => false), /could not find "claude".*TOWNSFOLK_CLAUDE_BIN/);
});

test("spawn plan: .exe runs directly, .cmd runs as one quoted cmd.exe line", () => {
  assert.deepEqual(spawnPlan({ file: "claude", viaCmd: false }, ["-p", ""]), { file: "claude", args: ["-p", ""], windowsVerbatimArguments: false });
  const plan = spawnPlan({ file: "C:\\Program Files\\npm\\claude.cmd", viaCmd: true }, ["-p", "--tools", "", "--system-prompt-file", "C:\\Temp\\townsfolk-x\\system.txt"]);
  assert.deepEqual(plan, {
    file: "cmd.exe",
    args: ["/d", "/s", "/c", '""C:\\Program Files\\npm\\claude.cmd" "-p" "--tools" "" "--system-prompt-file" "C:\\Temp\\townsfolk-x\\system.txt""'],
    windowsVerbatimArguments: true,
  });
});

test("cmd line: refuses what cmd.exe would mangle", () => {
  for (const bad of ['say "hi"', "100%", "two\nlines"]) assert.throws(() => cmdLine("claude.cmd", [bad]), /cannot pass/);
  assert.equal(cmdLine("claude.cmd", ["a & b", "x^y"]), '"claude.cmd" "a & b" "x^y"');
});
