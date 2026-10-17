// Model adapters. Each returns the raw text the model produced; talk.ts parses and validates it.

import { spawn } from "node:child_process";

export type ModelAdapter = {
  name: string;
  // maxTokens bounds the reply where the adapter can (the anthropic API); the CLI has no flag for it.
  complete(system: string, user: string, signal: AbortSignal, maxTokens?: number): Promise<string>;
};

export const TALK_MAX_TOKENS = 600;

// Spawns the official Claude Code CLI. It uses its own login; this code never sees a token.
// No tools, no settings, no session files: one prompt in, one JSON envelope out.
export function claudeCliAdapter(opts: { bin: string; model: string }): ModelAdapter {
  return {
    name: "claude-cli",
    complete(system, user, signal) {
      return new Promise((resolve, reject) => {
        const child = spawn(
          opts.bin,
          [
            "-p",
            "--output-format", "json",
            "--model", opts.model,
            "--tools", "",
            "--no-session-persistence",
            "--setting-sources", "",
            "--system-prompt", system,
          ],
          { stdio: ["pipe", "pipe", "pipe"], signal },
        );
        let out = "";
        let err = "";
        child.stdout.setEncoding("utf8").on("data", (d: string) => (out += d));
        child.stderr.setEncoding("utf8").on("data", (d: string) => (err += d));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code !== 0) return reject(new Error(`claude exited ${code}: ${err.slice(0, 300)}`));
          let envelope: { is_error?: boolean; result?: unknown };
          try {
            envelope = JSON.parse(out) as typeof envelope;
          } catch {
            return reject(new Error(`claude printed non-JSON: ${out.slice(0, 200)}`));
          }
          if (envelope.is_error === true || typeof envelope.result !== "string") {
            return reject(new Error(`claude returned an error envelope: ${out.slice(0, 300)}`));
          }
          resolve(envelope.result);
        });
        child.stdin.end(user);
      });
    },
  };
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
export function fakeAdapter(replies: string[]): ModelAdapter & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  let i = 0;
  return {
    name: "fake",
    calls,
    async complete(system, user) {
      calls.push({ system, user });
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
    { id: "a", text: "It really is." },
    { id: "b", text: "Could be better." },
    { id: "c", text: "What are you up to?" },
  ],
  end: false,
});
