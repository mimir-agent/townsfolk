// npm run sim -- --days N --seed S [--adapter fake|claude-cli] [--out FILE]
//
// Runs the year simulator (run.ts) and writes the diary as one Markdown file. Prints the
// summary, the wall time and the model call count to stdout. Exit code 1 when any check fails,
// 2 for bad arguments.
//
// --adapter fake (default) is offline: no network, no model, no key.
// --adapter claude-cli spawns the official `claude -p` CLI (TOWNSFOLK_CLAUDE_BIN, default
// "claude"; TOWNSFOLK_CLAUDE_MODEL, default "haiku"). It uses the CLI's own login; this code never
// reads or prints a token. The simulated player still picks replies with the seeded RNG, but the
// model's answers vary, so a claude-cli diary does not replay.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { claudeCliAdapter } from "../src/model.ts";
import { fakeTownAdapter } from "./fake-town.ts";
import { runSim } from "./run.ts";

function fail(msg: string): never {
  console.error(`sim: ${msg}`);
  console.error("usage: npm run sim -- --days N --seed S [--adapter fake|claude-cli] [--out FILE]");
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    days: { type: "string", default: "112" },
    seed: { type: "string", default: "1" },
    adapter: { type: "string", default: "fake" },
    out: { type: "string" },
    verbose: { type: "boolean", default: false },
  },
  strict: true,
});

const days = Number(values.days);
const seed = Number(values.seed);
if (!Number.isInteger(days) || days < 1 || days > 1120) fail("--days must be a whole number from 1 to 1120");
if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) fail("--seed must be a whole number from 0 to 4294967295");
const adapter = values.adapter;
if (adapter !== "fake" && adapter !== "claude-cli") fail(`unknown --adapter "${adapter}"`);
const out = resolve(values.out ?? `sim-out/diary-${adapter}-seed${seed}-${days}d.md`);

const env = process.env;
const real = adapter === "claude-cli";
const started = Date.now();
const result = await runSim({
  days,
  seed,
  model: real ? () => claudeCliAdapter({ bin: env.TOWNSFOLK_CLAUDE_BIN ?? "claude", model: env.TOWNSFOLK_CLAUDE_MODEL ?? "haiku" }) : fakeTownAdapter,
  // The bridge's deadlines for a real model; the fake answers at once.
  talkDeadlineMs: real ? 30_000 : 5_000,
  planDeadlineMs: real ? 240_000 : 5_000,
  log: values.verbose ? (m) => console.error(m) : undefined,
});
const wallMs = Date.now() - started;

await mkdir(dirname(out), { recursive: true });
await writeFile(out, result.diary);

console.log(`diary: ${out}`);
console.log(`days ${days}, seed ${seed}, adapter ${adapter}, wall time ${(wallMs / 1000).toFixed(1)}s, model calls ${result.modelCalls}, parts dropped ${result.drops}, schedule regens ${result.regens}`);
for (const c of result.checks) console.log(`${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`);
process.exit(result.checks.every((c) => c.ok) ? 0 : 1);
