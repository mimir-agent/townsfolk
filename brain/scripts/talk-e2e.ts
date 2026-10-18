// Manual end-to-end timing through a running brain (any adapter). Not part of `npm test`.
//
//   node scripts/talk-e2e.ts --seed DIR          write the fixture into a brain state dir, then exit
//   node scripts/talk-e2e.ts [--url http://127.0.0.1:7341] [--turns 8] [--stream]
//
// Start the brain with TOWNSFOLK_STATE_DIR=DIR after seeding, so it builds the fixture's prompt
// (talk-fixture.ts). Then this sends that request to POST /v1/talk as the mod does, one turn
// after another on one save and farmer (so one warm process), each with a different last
// choice, and prints ms to the streamed line (with --stream) and to the whole reply.

import { parseArgs } from "node:util";
import { benchRequest, seedState } from "./talk-fixture.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "http://127.0.0.1:7341" },
    turns: { type: "string", default: "8" },
    stream: { type: "boolean", default: false },
    seed: { type: "string" },
  },
});
if (values.seed !== undefined) {
  await seedState(values.seed);
  console.log(`seeded ${values.seed}`);
  process.exit(0);
}

const picks = ["Want to see what I found down there?", "I could use a hand with the mines.", "How's the shop today?", "Your dad seems stressed.", "Have you been practicing?", "I brought you something."];
const rows: { line: number; done: number; source: string }[] = [];
for (let i = 0; i < Number(values.turns); i++) {
  // Two player turns so far, not three: a mid-conversation turn that must write choices (the
  // fixture's full transcript would make every turn the last one, with no choices).
  const base = benchRequest();
  const req = { ...base, transcript: base.transcript.slice(0, 3), recentChoice: { id: "b", text: picks[i % picks.length]! } };
  const t0 = Date.now();
  const res = await fetch(`${values.url}/v1/talk`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: values.stream ? "application/x-ndjson" : "application/json" },
    body: JSON.stringify(req),
  });
  let line = -1;
  let last = "";
  let buf = "";
  const dec = new TextDecoder();
  for await (const chunk of res.body!) {
    buf += dec.decode(chunk, { stream: true });
    for (let n = buf.indexOf("\n"); n >= 0; n = buf.indexOf("\n")) {
      const l = buf.slice(0, n);
      buf = buf.slice(n + 1);
      if (l.includes('"partial":true') && line < 0) line = Date.now() - t0;
      else if (l.trim()) last = l;
    }
  }
  if (buf.trim()) last = buf;
  const done = Date.now() - t0;
  const reply = JSON.parse(last) as { source: string; line: string; choices: { text: string; bye?: boolean }[] };
  if (line < 0) line = done;
  rows.push({ line, done, source: reply.source });
  console.log(`turn ${i + 1}: line ${line}ms, done ${done}ms, ${reply.source}: ${reply.line} | ${reply.choices.map((c) => (c.bye ? `[bye] ${c.text}` : c.text)).join(" / ")}`);
}
const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const warm = rows.slice(1);
console.log(`median of turns 2..${rows.length}: line ${med(warm.map((r) => r.line))}ms, done ${med(warm.map((r) => r.done))}ms, fallbacks ${rows.filter((r) => r.source !== "model").length}`);
