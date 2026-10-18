// The claude-cli adapter against a stand-in `claude` script (no network, no model): the system
// prompt reaches it through --system-prompt-file intact, the user prompt through stdin, and the
// temp file is gone afterwards. POSIX only: the stand-in is a shell script.

import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCliAdapter } from "../src/model.ts";

test("claude-cli passes a multi-line, quoted system prompt by file and cleans it up", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "townsfolk-fake-claude-"));
  const bin = join(dir, "claude");
  const seen = join(dir, "seen.txt");
  // Records the prompt file path and contents, and the stdin, then prints a success envelope.
  await writeFile(
    bin,
    `#!/bin/sh
while [ $# -gt 0 ]; do
  if [ "$1" = "--system-prompt-file" ]; then shift; f="$1"; fi
  shift
done
{ echo "$f"; cat "$f"; echo; echo "---"; cat; } > "${seen}"
echo '{"is_error":false,"result":"PONG"}'
`,
  );
  await chmod(bin, 0o755);
  const system = 'Line one.\nSay "hi" at 100% & mean it.';
  const out = await claudeCliAdapter({ command: { file: bin, viaCmd: false }, model: "haiku" }).complete(system, "hello", AbortSignal.timeout(5000));
  assert.equal(out, "PONG");
  const [promptPath, ...rest] = (await readFile(seen, "utf8")).split("\n");
  assert.equal(rest.join("\n"), `${system}\n---\nhello`);
  assert.ok(promptPath !== undefined && !existsSync(promptPath), "temp prompt file was not removed");
});
