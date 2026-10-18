// Manual latency bench for one talk turn against the real `claude` CLI. Not part of `npm test`:
// it spends real model calls on the CLI's own login (this code never reads a token).
//
//   node scripts/talk-bench.ts [--as 0.1.3|0.1.2] [--turns 8] [--model haiku] [--flags "..."]
//
// It builds the realistic mid-game prompt in talk-fixture.ts with the brain's own buildPrompt,
// then drives ONE warm stream-json process the way the adapter does ("/clear" before every
// call after the first) and prints, per turn: ms to the first text token, ms until the "line"
// field is whole, ms to the result, and the usage numbers including thinking tokens.
//   --as 0.1.3  the arguments and environment this release runs talk with (model.ts)
//   --as 0.1.2  the arguments 0.1.2 ran talk with (no --strict-mcp-config, model's own thinking)
// Both add --include-partial-messages so the line can be timed; it changes what the CLI prints,
// not what the model does. --flags adds more arguments, for trying things.
// Each turn's prompt ends differently, as real turns do, so a cache hit on the whole user
// message never flatters the numbers.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { claudeArgs, QUICK_ENV } from "../src/model.ts";
import { lineWhenComplete } from "../src/stream.ts";
import { benchPrompt } from "./talk-fixture.ts";

const { values } = parseArgs({
  options: {
    as: { type: "string", default: "0.1.3" },
    turns: { type: "string", default: "8" },
    model: { type: "string", default: "haiku" },
    flags: { type: "string", default: "" },
  },
});

function argsFor(as: string, model: string, promptFile: string): { args: string[]; env: NodeJS.ProcessEnv } {
  if (as === "0.1.3") return { args: claudeArgs(model, promptFile), env: { ...process.env, ...QUICK_ENV } };
  if (as === "0.1.2") {
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", model, "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt-file", promptFile];
    return { args, env: process.env };
  }
  throw new Error(`--as must be 0.1.3 or 0.1.2, not ${as}`);
}

type Turn = { clear: number; first: number; line: number; done: number; input: number; cacheWrite: number; cacheRead: number; output: number; thinking: number };
type Msg = { type?: string; subtype?: string; event?: { type?: string; delta?: { type?: string; text?: string } }; usage?: Record<string, any> };

const { system, user } = benchPrompt();
const dir = await mkdtemp(join(tmpdir(), "townsfolk-bench-"));
const promptFile = join(dir, "system.txt");
await writeFile(promptFile, system);
const { args, env } = argsFor(values.as, values.model, promptFile);
args.push(...values.flags.split(" ").filter(Boolean));
console.log(`as ${values.as}: system ${system.length} chars, user ${user.length} chars, model ${values.model}`);

const child = spawn(process.env.TOWNSFOLK_CLAUDE_BIN ?? "claude", args, { stdio: ["pipe", "pipe", "inherit"], env });
let onMsg: (m: Msg) => void = () => {};
let buf = "";
child.stdout.setEncoding("utf8").on("data", (d: string) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    onMsg(JSON.parse(line) as Msg);
  }
});

function ask(text: string): Promise<Omit<Turn, "clear">> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let first = -1;
    let line = -1;
    let acc = "";
    onMsg = (m) => {
      if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
        if (first < 0) first = Date.now() - t0;
        acc += m.event.delta.text ?? "";
        if (line < 0 && lineWhenComplete(acc) !== null) line = Date.now() - t0;
      }
      if (m.type === "result") {
        const u = m.usage ?? {};
        resolve({ first, line, done: Date.now() - t0, input: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, output: u.output_tokens ?? 0, thinking: u.output_tokens_details?.thinking_tokens ?? 0 });
      }
    };
    child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  });
}

const NOTES = ["the player glances at the shelves", "a cart rattles past outside", "the shop bell rings", "the player shifts their pack"];
const turns: Turn[] = [];
const n = Number(values.turns);
for (let i = 0; i < n; i++) {
  let clear = 0;
  if (i > 0) {
    const c0 = Date.now();
    await ask("/clear");
    clear = Date.now() - c0;
  }
  turns.push({ clear, ...(await ask(`${user}\n\n(Turn ${i + 1}: ${NOTES[i % NOTES.length]}.)`)) });
}
child.stdin.end();

console.log("turn | clear ms | first token ms | line ms | done ms | input | cache write | cache read | output | thinking");
turns.forEach((t, i) => console.log([i + 1, t.clear, t.first, t.line, t.done, t.input, t.cacheWrite, t.cacheRead, t.output, t.thinking].join(" | ")));
const warm = turns.slice(1);
const med = (k: keyof Turn) => [...warm.map((t) => t[k])].sort((a, b) => a - b)[Math.floor(warm.length / 2)];
console.log(
  `median of warm turns 2..${n} (one process, pid ${child.pid}): first token ${med("first")}ms, line ${med("line")}ms, done ${med("done")}ms, ` +
    `clear ${med("clear")}ms, cache read ${med("cacheRead")}, output ${med("output")}, thinking ${med("thinking")}; turns that thought: ${warm.filter((t) => t.thinking > 0).length}/${warm.length}`,
);
