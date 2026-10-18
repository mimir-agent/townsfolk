// Manual latency bench for one talk turn against the real `claude` CLI. Not part of `npm test`:
// it spends real model calls on the CLI's own login (this code never reads a token).
//
//   node scripts/talk-bench.ts [--turns 6] [--model haiku] [--flags "--strict-mcp-config ..."]
//
// It builds a realistic mid-game prompt with the brain's own buildPrompt (a full card, 14 memory
// entries, gossip, a 3-turn transcript), then drives ONE warm stream-json process exactly as the
// adapter does (/clear before every call after the first) and prints, per turn: ms to the first
// text token, ms until the "line" field is complete, ms to the result, the usage numbers, and
// whether the process was the same one as the turn before.

import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { emptyMemory, type NpcMemory } from "../src/memory.ts";
import { MAIN_FARMER, type TalkRequest } from "../src/protocol.ts";
import { buildPrompt, NO_CONTEXT } from "../src/talk.ts";
import { emptyTown, newFact } from "../src/town.ts";
import { lineWhenComplete } from "../src/stream.ts";

const { values } = parseArgs({
  options: {
    turns: { type: "string", default: "6" },
    model: { type: "string", default: "haiku" },
    flags: { type: "string", default: "" },
  },
});

export function benchPrompt(): { system: string; user: string } {
  const mem: NpcMemory = emptyMemory("Abigail");
  const days = Array.from({ length: 14 }, (_, i) => i + 1);
  mem.farmers[MAIN_FARMER] = {
    farmerName: "Tae",
    firstMet: "spring 2, year 1",
    talks: 31,
    gifts: 9,
    years: "",
    seasons: [{ season: "spring", year: 1, text: "Tae arrived in early spring and kept showing up at the shop. 4: gave me an amethyst, my favorite. 11: we talked about the mines; Tae promised to tell me what is past level 40. 20: Tae saw me practicing with my sword and did not laugh. 27: the egg festival, Tae won the hunt and teased me about it." }],
    entries: days.map((d) => ({
      day: { season: "summer" as const, day: d, year: 1 },
      text: `Tae stopped by the shop around noon. We talked about ${["the mines", "Sebastian's new song", "the rain", "Dad's prices", "the flute", "video games", "the graveyard", "frogs", "the beach", "Linus", "Haley's photos", "the saloon", "the bus stop", "the tower"][d - 1]}. Tae picked the warm reply and I felt a bit more at ease; I told them a little about how ${["I want to leave town some day", "Mom worries about me", "I miss adventures", "I hate being told what to do"][d % 4]}.`,
    })),
  };
  const town = emptyTown();
  const gossip = [
    "The farmer gave Emily a bunch of daffodils at the saloon.",
    "The farmer joined Sam's band practice and played the tambourine badly.",
    "The farmer promised Pierre a crate of parsnips by Friday.",
    "The farmer was seen in the mines past level 60.",
    "The farmer and Leah walked along the river at dusk.",
    "The farmer fixed the broken bridge to the quarry.",
  ];
  gossip.forEach((text, i) => {
    town.facts.push(newFact(`g${i}`, { season: "summer", day: 8 + i, year: 1 }, text, true, { Abigail: { kind: "heard", from: "Sebastian" } }));
  });
  const req: TalkRequest = {
    v: 1,
    saveId: "Bench_1",
    npc: "Abigail",
    playerName: "Tae",
    day: { season: "summer", day: 15, year: 1, time: 1330, weather: "sunny", location: "SeedShop" },
    friendship: { hearts: 5, points: 1300 },
    transcript: [
      { speaker: "npc", text: "Oh, it's you. I was just about to sneak out to the mines, honestly." },
      { speaker: "player", text: "Want some company down there?" },
      { speaker: "npc", text: "Maybe. Depends if you can keep up with me." },
      { speaker: "player", text: "I made it past level 60 last week." },
      { speaker: "npc", text: "Wait, seriously? Sebastian said something about that. I thought he was joking." },
    ],
    recentChoice: { id: "b", text: "Want to see what I found down there?" },
    gameLines: ["Hey. Dad's been on my case all morning."],
    stats: { farmName: "Moonfield", daysPlayed: 43, deepestMineLevel: 64, communityCenterRooms: 2, money: 18250 },
    eventsSeen: ["1", "2"],
  };
  return buildPrompt(req, mem, town, NO_CONTEXT, false, null);
}

type Turn = { firstToken: number; line: number; done: number; inTok: number; cacheWrite: number; cacheRead: number; outTok: number; thinking: number; sameProcess: boolean; clearMs: number };

async function main(): Promise<void> {
  const { system, user } = benchPrompt();
  console.log(`prompt: system ${system.length} chars, user ${user.length} chars, flags "${values.flags}"`);
  const dir = await mkdtemp(join(tmpdir(), "townsfolk-bench-"));
  const promptFile = join(dir, "system.txt");
  await writeFile(promptFile, system);
  const extra = values.flags.split(" ").filter(Boolean);
  const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", values.model, "--tools", "", "--no-session-persistence", "--setting-sources", "", "--system-prompt-file", promptFile, ...extra];
  const spawnedAt = Date.now();
  const child = spawn(process.env.TOWNSFOLK_CLAUDE_BIN ?? "claude", args, { stdio: ["pipe", "pipe", "inherit"] });
  let inits = 0;
  let onMsg: (m: any) => void = () => {};
  let buf = "";
  child.stdout.setEncoding("utf8").on("data", (d: string) => {
    buf += d;
    for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const m = JSON.parse(line);
      if (m.type === "system" && m.subtype === "init") inits++;
      onMsg(m);
    }
  });
  const send = (text: string) => child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
  const ask = (text: string) =>
    new Promise<Omit<Turn, "sameProcess" | "clearMs">>((resolve) => {
      const t0 = Date.now();
      let firstToken = -1;
      let lineAt = -1;
      let acc = "";
      onMsg = (m) => {
        if (m.type === "stream_event" && m.event?.type === "content_block_delta" && m.event.delta?.type === "text_delta") {
          if (firstToken < 0) firstToken = Date.now() - t0;
          acc += m.event.delta.text;
          if (lineAt < 0 && lineWhenComplete(acc) !== null) lineAt = Date.now() - t0;
        }
        if (m.type === "result") {
          const u = m.usage ?? {};
          resolve({ firstToken, line: lineAt, done: Date.now() - t0, inTok: u.input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, outTok: u.output_tokens ?? 0, thinking: u.output_tokens_details?.thinking_tokens ?? 0 });
        }
      };
      send(text);
    });
  const turns: Turn[] = [];
  const n = Number(values.turns);
  for (let i = 0; i < n; i++) {
    let clearMs = 0;
    if (i > 0) {
      const c0 = Date.now();
      await ask("/clear");
      clearMs = Date.now() - c0;
    }
    const before = inits;
    // Each turn's prompt ends differently, as real turns do (the transcript grows), so a cache
    // hit on the whole user message never flatters the numbers.
    const t = await ask(`${user}\n\n(Turn ${i + 1}: ${["the player glances at the shelves", "a cart rattles past outside", "the shop bell rings", "the player shifts their pack"][i % 4]}.)`);
    turns.push({ ...t, clearMs, sameProcess: i === 0 ? false : inits - before <= 2 && child.exitCode === null });
    if (i === 0) console.log(`process started ${Date.now() - spawnedAt}ms before the first result (includes startup)`);
  }
  child.stdin.end();
  console.log("turn | clear ms | first token ms | line ready ms | done ms | input | cache write | cache read | output | thinking");
  turns.forEach((t, i) => console.log([i + 1, t.clearMs, t.firstToken, t.line, t.done, t.inTok, t.cacheWrite, t.cacheRead, t.outTok, t.thinking].join(" | ")));
  const med = (k: keyof Turn) => {
    const xs = turns.slice(1).map((t) => t[k] as number).sort((a, b) => a - b);
    return xs[Math.floor(xs.length / 2)];
  };
  console.log(`median of warm turns 2..${n}: first token ${med("firstToken")}ms, line ${med("line")}ms, done ${med("done")}ms, clear ${med("clearMs")}ms, output ${med("outTok")} tokens, pid ${child.pid}`);
}

await main();
