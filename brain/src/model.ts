// Model adapters. Each returns the raw text the model produced; talk.ts parses and validates it.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Command, spawnPlan } from "./platform.ts";

export type ModelAdapter = {
  name: string;
  // maxTokens bounds the reply where the adapter can (the anthropic API); the CLI has no flag for it.
  // opts.session names who the call is for (one player, or the night's plan). An adapter that keeps
  // a warm process keeps one per session and never shares it between sessions.
  complete(system: string, user: string, signal: AbortSignal, maxTokens?: number, opts?: { session: string }): Promise<string>;
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
export function claudeCliAdapter(opts: { command: Command; model: string }): ModelAdapter {
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
      return get(o?.session ?? "default", system).ask(user, signal);
    },
    close() {
      for (const p of sessions.values()) p.kill();
      sessions.clear();
    },
  };
}

type Waiter = { resolve: (text: string) => void; reject: (err: Error) => void };

class WarmProcess {
  dead = false;
  private child: ChildProcessWithoutNullStreams | null = null;
  private readonly ready: Promise<void>;
  private readonly waiting: Waiter[] = [];
  private used = false;
  // Calls on one process run one after another, so the results line up with the questions.
  private tail: Promise<unknown> = Promise.resolve();
  private dir = "";

  private readonly opts: { command: Command; model: string };
  readonly system: string;

  constructor(opts: { command: Command; model: string }, system: string) {
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
    const plan = spawnPlan(this.opts.command, [
      "-p",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--verbose",
      "--model", this.opts.model,
      "--tools", "",
      "--no-session-persistence",
      "--setting-sources", "",
      "--system-prompt-file", promptFile,
    ]);
    const child = spawn(plan.file, plan.args, { stdio: ["pipe", "pipe", "pipe"], windowsVerbatimArguments: plan.windowsVerbatimArguments, windowsHide: true });
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
    let msg: { type?: string; is_error?: boolean; result?: unknown };
    try {
      msg = JSON.parse(line) as typeof msg;
    } catch {
      return;
    }
    if (msg.type !== "result") return;
    const w = this.waiting.shift();
    if (w === undefined) return;
    if (msg.is_error === true || typeof msg.result !== "string") w.reject(new Error(`claude returned an error result: ${line.slice(0, 300)}`));
    else w.resolve(msg.result);
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
  private send(text: string, signal: AbortSignal): Promise<string> {
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
      this.waiting.push({ resolve: done(resolve), reject: done(reject) });
      this.child.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");
    });
  }

  ask(user: string, signal: AbortSignal): Promise<string> {
    const run = async (): Promise<string> => {
      await this.ready;
      if (this.used) await this.send("/clear", signal);
      this.used = true;
      return this.send(user, signal);
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
    async complete(system, user, signal, maxTokens = TALK_MAX_TOKENS) {
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
