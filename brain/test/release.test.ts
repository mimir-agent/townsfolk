// The release carries one version number: mod manifest, mod project and brain package agree,
// and CHANGELOG.md has an entry for it. scripts/release.ts refuses to build otherwise.

import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readVersions, smokeZip, sourceFiles, versionProblem, zip } from "../scripts/release.ts";

const ROOT = join(import.meta.dirname, "..", "..");

test("mod manifest, mod project and brain package share one version, with a CHANGELOG entry", () => {
  assert.equal(versionProblem(readVersions(ROOT)), null);
});

test("release refuses mismatched versions or a missing CHANGELOG entry", () => {
  const ok = { manifest: "0.2.0", csproj: "0.2.0", brain: "0.2.0", changelog: "0.2.0 0.1.0" };
  assert.equal(versionProblem(ok), null);
  assert.match(versionProblem({ ...ok, manifest: "0.1.0" }) ?? "", /versions differ/);
  assert.match(versionProblem({ ...ok, csproj: "0.3.0" }) ?? "", /versions differ/);
  assert.match(versionProblem({ ...ok, changelog: "0.1.0" }) ?? "", /CHANGELOG.md has no "## 0.2.0"/);
  assert.match(versionProblem({ ...ok, changelog: "0.2.0-beta" }) ?? "", /CHANGELOG/);
});

test("the release lists brain/src subfolders (v0.1.0 lacked cards/roster.ts)", () => {
  const files = sourceFiles(join(ROOT, "brain", "src"));
  assert.ok(files.includes("cards/roster.ts"), files.join(", "));
  assert.ok(files.includes("talk.ts"));
});

test("smokeZip starts the unzipped brain and fails with the brain's own error when a file is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "townsfolk-smoke-test-"));
  const entry = (name: string, data: string) => ({ name, data: Buffer.from(data), executable: false });
  const src = (f: string) => readFileSync(join(ROOT, "brain", "src", ...f.split("/")), "utf8");
  const all = sourceFiles(join(ROOT, "brain", "src")).map((f) => entry(`Townsfolk/brain/src/${f}`, src(f)));
  const base = [entry("Townsfolk/brain/start.mjs", readFileSync(join(ROOT, "brain", "start.mjs"), "utf8")), entry("Townsfolk/brain/package.json", readFileSync(join(ROOT, "brain", "package.json"), "utf8"))];

  const good = join(dir, "good.zip");
  writeFileSync(good, zip([...base, ...all]));
  assert.match(await smokeZip(good), /"ok":true/);

  const bad = join(dir, "bad.zip");
  writeFileSync(bad, zip([...base, ...all.filter((e) => !e.name.endsWith("cards/roster.ts"))]));
  await assert.rejects(smokeZip(bad), /roster|ERR_MODULE_NOT_FOUND/);
});
