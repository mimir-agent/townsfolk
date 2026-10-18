// Model adapters. Each returns the raw text the model produced; talk.ts parses and validates it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, spawnPlan } from "./platform.ts";

// What a call reports while it runs, for timing logs and for showing a reply before it is done.
//   sent   the request left the session's queue and reached the model (after any wait for an
//          earlier call, a process start, or "/clear")
//   text   everything the reply has written so far, each time more arrives. An adapter that does
//          not stream sends it once, whole.
//   usage  the token counts of the finished reply, where the adapter has them.
export type ModelEvent =
  | { kind: "sent" }
  | { kind: "text"; text: string }
  | { kind: "usage"; input: number; cacheRead: number; cacheWrite: number; output: number; thinking: number };

// session names who the call is for (one player, or the night's plan). An adapter that keeps a
// warm process keeps one per session and never shares it between sessions.
export type CallOpts = { session: string; onEvent?: (e: ModelEvent) => void };

export type ModelAdapter = {
  name: string;
  // maxTokens bounds the reply where the adapter can (the anthropic API); the CLI has no flag for it.
  complete(system: string, user: string, signal: AbortSignal, maxTokens?: number, opts?: CallOpts): Promise<string>;
  // Starts a session's process before its first call. Adapters without a process leave it out.
  warm?(session: string, system: string): void;
  // Ends every process this adapter started.
  close?(): void;
};

export const TALK_MAX_TOKENS = 600;

// One long-lived `claude -p` process per session, speaking stream-json on stdin and stdout. It
// uses the CLI's own login; this code never sees a token. No tools, no settings, no session
// files. A process answers a follow-up in a second or two because nothing starts up again.
//
// Knowledge boundary: a session is one player (or the night's plan), and it is only ever asked
// about one NPC at a time. Before every call after the first the process is sent "/clear", which
// drops its whole context, and the call then carries everything the model may know in its own
// prompt, rebuilt from the brain's stores. Nothing a process remembers is relied on.
//
// The system prompt goes through a temp file, not an argument: on Windows claude.cmd runs
// through cmd.exe, which cannot carry line breaks or quotes and caps a line at 8191 characters.
// A call whose system prompt differs from the one the process started with restarts it.
//
// --strict-mcp-config with no --mcp-config: no MCP servers at all. Without it the CLI loads the
// account's claude.ai connectors (on the dev Mac: 73 tools, about 54k input tokens on every
// call, measured with scripts/talk-bench.ts) even with --tools "".
// --include-partial-messages: the reply arrives as it is written, so the NPC's line can be shown
// before the choices are done (ModelEvent "text").
export type ClaudeCliOpts = {
  command: Command;
  model: string;
  // Talk: no extended thinking, low effort. Haiku otherwise thinks 400 to 1300 tokens on about
  // half of the turns (3 to 5 s). The plan leaves it off and keeps the model's own default.
  quick?: boolean;
};

// The environment that turns thinking off. All three are needed on Claude Code 2.1.295: with
// only the two DISABLE variables Haiku still thought on 4 of 7 warm turns, with only the effort
// it thought on 2 of 7, with all three on none of 7 (scripts/talk-bench.ts). Environment
// variables, not flags, so an older claude that does not know them still starts.
export const QUICK_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_EFFORT_LEVEL: "low",
  CLAUDE_CODE_DISABLE_THINKING: "1",
  CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
};

export function claudeArgs(model: string, promptFile: string): string[] {
  return [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model", model,
    "--tools", "",
    "--strict-mcp-config",
    "--no-session-persistence",
    "--setting-sources", "",
    "--system-prompt-file", promptFile,
  ];
}

export function claudeCliAdapter(opts: ClaudeCliOpts): ModelAdapter {
  const sessions = new Map<string, WarmProcess>();
  const get = (session: string, system: string): WarmProcess => {
    let p = sessions.get(session);
    if (p !== undefined && (p.dead || p.system !== system)) {
      p.kill();
      p = undefined;
    }
    if (p === undefined) {
      p = new WarmProcess(opts, system);
      sessions.set(session, p);
    }
    return p;
  };
  return {
    name: "claude-cli",
    warm(session, system) {
      get(session, system);
    },
    complete(system, user, signal, _maxTokens, o) {
      return get(o?.session ?? "default", system).ask(user, signal, o?.onEvent);
    },
    close() {
      for (const p of sessions.values()) p.kill();
      sessions.clear();
    },
  };
}

// onEvent is set only on the call that wants the reply as it is written (never on "/clear").
type Waiter = { resolve: (text: string) => void; reject: (err: Error) => void; onEvent?: (e: ModelEvent) => void; text: string };

// The parts of a stream-json line this adapter reads.
type StreamLine = {
  type?: string;
  is_error?: boolean;
  result?: unknown;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  usage?: {
    input_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
    output_tokens?: number;
    output_tokens_details?: { thinking_tokens?: number };
  };
};

class WarmProcess {
  dead = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly ready: Promise<void>;
  private readonly waiting: Waiter[] = [];
  private used = false;
  // Calls on one process run one after another, so the results line up with the questions.
  private tail: Promise<unknown> = Promise.resolve();
  private dir = "";

  private readonly opts: ClaudeCliOpts;
  readonly system: string;

  constructor(opts: ClaudeCliOpts, system: string) {
    this.opts = opts;
    this.system = system;
    this.ready = this.start();
    // A start that failed is reported by the call that waits on it.
    this.ready.catch(() => {});
  }

  private async start(): Promise<void> {
    this.dir = await mkdtemp(join(tmpdir(), "townsfolk-"));
    const promptFile = join(this.dir, "system.txt");
    await writeFile(promptFile, this.system);
    const plan = spawnPlan(this.opts.command, claudeArgs(this.opts.model, promptFile));
    const env = this.opts.quick === true ? { ...process.env, ...QUICK_ENV } : process.env;
    const child = spawn(plan.file, plan.args, { stdio: ["pipe", "pipe", "pipe"], env, windowsVerbatimArguments: plan.windowsVerbatimArguments, windowsHide: true });
    this.child = child;
    let err = "";
    let buf = "";
    child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      buf += d;
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.onLine(line);
      }
    });
    child.on("error", (e) => this.die(e));
    child.on("close", (code) => this.die(new Error(`claude exited ${code}: ${err.slice(0, 300)}`)));
    child.stdin.on("error", () => {});
  }

  private onLine(line: string): void {
    let msg: StreamLine;
    try {
      msg = JSON.parse(line) as StreamLine;
    } catch {
      return;
    }
    // Partial text of the reply being written, for the call at the head of the queue.
    if (msg.type === "stream_event" && msg.event?.type === "content_block_delta" && msg.event.delta?.type === "text_delta") {
      const w = this.waiting[0];
      if (w?.onEvent !== undefined && typeof msg.event.delta.text === "string") {
        w.text += msg.event.delta.text;
        w.onEvent({ kind: "text", text: w.text });
      }
      return;
    }
    if (msg.type !== "result") return;
    const w = this.waiting.shift();
    if (w === undefined) return;
    if (msg.is_error === true || typeof msg.result !== "string") return w.reject(new Error(`claude returned an error result: ${line.slice(0, 300)}`));
    const u = msg.usage;
    if (u !== undefined)
      w.onEvent?.({
        kind: "usage",
        input: u.input_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        thinking: u.output_tokens_details?.thinking_tokens ?? 0,
      });
    w.resolve(msg.result);
  }

  // The process is gone (crashed, killed, or never started): every waiting call fails, and the
  // adapter starts a new process for the next call.
  private die(err: Error): void {
    if (this.dead) return;
    this.dead = true;
    for (const w of this.waiting.splice(0)) w.reject(err);
    if (this.dir !== "") void rm(this.dir, { recursive: true, force: true });
  }

  kill(): void {
    this.child?.kill();
    this.die(new Error("claude process stopped"));
  }

  // Sends one user message and waits for the one result it produces.
  private send(text: string, signal: AbortSignal, onEvent?: (e: ModelEvent) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      if (this.dead || this.child === null) return reject(new Error("claude process is not running"));
      const onAbort = () => {
        // Its state is unknown once cut off mid-answer, so the whole process goes.
        this.kill();
        reject(new Error("model call aborted or timed out"));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      const done = <T>(f: (v: T) => void) => (v: T) => {
        signal.removeEventListener("abort", onAbort);
        f(v);
      };
      this.waiting.push({ resolve: done(resolve), reject: done(reject), onEvent, text: "" });
      onEvent?.({ kind: "sent" });
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    });
  }

  ask(user: string, signal: AbortSignal, onEvent?: (e: ModelEvent) => void): Promise<string> {
    const run = async (): Promise<string> => {
      await this.ready;
      if (this.used) await this.send("/clear", signal);
      this.used = true;
      return this.send(user, signal, onEvent);
    };
    const next = this.tail.then(run, run);
    this.tail = next.catch(() => {});
    return next;
  }
}

// For players: their own key from ANTHROPIC_API_KEY. Not exercised in the tonight slice.
export function anthropicAdapter(opts: { apiKey: string; model: string }): ModelAdapter {
  return {
    name: "anthropic",
    async complete(system, user, signal, maxTokens = TALK_MAX_TOKENS, o) {
      const onEvent = o?.onEvent;
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: opts.model,
          max_tokens: maxTokens,
          system,
          messages: [{ role: "user", content: user }],
        }),
      });
      if (!res.ok) throw new Error(`anthropic HTTP ${res.status}`);
      const body = (await res.json()) as { content?: { type: string; text?: string }[] };
      const text = body.content?.find((c) => c.type === "text")?.text;
      if (typeof text !== "string") throw new Error("anthropic response had no text block");
      // Not streamed: the whole reply arrives at once, so the line is ready when it is done.
      onEvent?.({ kind: "sent" });
      onEvent?.({ kind: "text", text });
      return text;
    },
  };
}

// Tests and offline runs: returns queued replies in order, then repeats the last one.
export function fakeAdapter(replies: string[]): ModelAdapter & { calls: { system: string; user: string; session?: string }[] } {
  const calls: { system: string; user: string; session?: string }[] = [];
  let i = 0;
  return {
    name: "fake",
    calls,
    async complete(system, user, _signal, _max, opts) {
      calls.push({ system, user, session: opts?.session });
      const reply = replies[Math.min(i, replies.length - 1)];
      i++;
      if (reply === undefined) throw new Error("fake adapter has no replies");
      if (reply === "THROW") throw new Error("fake adapter failure");
      opts?.onEvent?.({ kind: "sent" });
      opts?.onEvent?.({ kind: "text", text: reply });
      return reply;
    },
  };
}

export const DEFAULT_FAKE_REPLY = JSON.stringify({
  line: "Oh, hello there. Nice day for it, isn't it?",
  choices: [
    { id: "a", text: "It really is.", delta: 2 },
    { id: "b", text: "Could be better.", delta: -1 },
    { id: "c", text: "What are you up to?", delta: 1 },
  ],
  end: false,
});
