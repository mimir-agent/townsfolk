// The release carries one version number: mod manifest, mod project and brain package agree,
// and CHANGELOG.md has an entry for it. scripts/release.ts refuses to build otherwise.

import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { readVersions, versionProblem } from "../scripts/release.ts";

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
