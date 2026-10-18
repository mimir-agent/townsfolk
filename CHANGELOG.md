# Changelog

One version number covers the whole release: `mod/manifest.json`, `mod/Townsfolk.csproj` and `brain/package.json` must match, and each release has a heading here. `npm run release` (in `brain/`) refuses to build otherwise. The release merge is tagged `vX.Y.Z`.

## 0.1.3

Faster chat replies. The talk prompt is unchanged: the same card, memory, gossip and transcript.

- Talk no longer loads the Claude account's claude.ai connectors. Even with no tools, `claude -p` loaded every connected MCP server into each call (on the dev Mac about 54,000 extra input tokens a call). Talk and the plan now run with `--strict-mcp-config` and no MCP config.
- Talk no longer thinks before it answers. Haiku spent 400 to 1,300 tokens thinking on about half of the turns, 3 to 5 extra seconds each. The talk process now starts with `CLAUDE_CODE_EFFORT_LEVEL=low`, `CLAUDE_CODE_DISABLE_THINKING=1` and `CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING=1`. The overnight plan (Sonnet) keeps its thinking. Haiku still thinks on some turns despite all three; see the measurements in the PR.
- The NPC's line shows before the choices are ready. On the host the waiting box shows the line as soon as it is written, with the dots under it, and the choices follow (about half a second to a second later). A farmhand's talk still arrives whole.
- Every talk logs its phases in the brain window: `talk <npc> attempt N: queue, first token, line, done` in ms, with input, cache and output tokens (and thinking tokens).
- `node scripts/talk-bench.ts` and `node scripts/talk-e2e.ts` (in `brain/`) measure talk speed with the real `claude` CLI. They are manual and spend real model calls; `npm test` does not run them.

## 0.1.2

Every chat fell back to the game's own line within a fraction of a second on the host's Mac, and nothing said why. The fast ways a talk fails (Claude Code not found, not logged in, exiting with an error, a reply that is not JSON or breaks a rule) all end in a canned fallback within about 5 to 55 ms, so the waiting box opened and closed at once. This release makes each of them visible.

- Each failed talk says why. The brain logs `talk <npc> FAILED after <ms>ms ...: <reason>` and returns the reason with the fallback (`reason` in `talk-response`). The SMAPI log shows `Brain gave no usable reply (reason: ...)` as a warning, with the brain's reason, or the timeout or request failure when no reply came.
- Version check at load. `/v1/health` now returns `version` (from `brain/package.json`), `ready`, and `reason` when not ready. When a save loads, the mod compares the version with its own. If the brain the mod started itself is another version, it is restarted. If one started by hand is running (for example a 0.1.0 brain left open in a Terminal tab, which the 0.1.1 mod quietly used), the SMAPI log says `A brain from version X is already running on port 7341 ...; stop it and reload the save`.
- Claude Code checked at brain start: `claude --version`, then `claude auth status --json`. If it is not found or not logged in, the brain still starts, prints a plain message in its window and log, and reports `ready: false` with the reason.
- One message on screen per load when the brain is not running, is the wrong version, or cannot talk, so the player sees it without reading logs.
- On Windows, a `claude` that is not on PATH no longer stops the brain from starting. It starts and reports why it cannot talk.

## 0.1.1

Changes from the first play.

- Waiting is visible and the world waits: an open box with the villager's portrait and cycling dots stays up from the click until the reply arrives, and between turns. Escape ends the conversation. On a failure the game's own line replaces it.
- Faster talk: one warm `claude` process per player, started when the save loads; switching villagers clears it (`/clear`) and rebuilds the chat from the brain's own memory, so nothing one villager heard reaches another. A walked-away chat resumes the same day from its stored transcript. Talk deadline 20 s in the brain (`TOWNSFOLK_TALK_MS`), 25 s in the mod (`TimeoutSeconds`). Elapsed milliseconds are logged for each answer.
- Talk stays on Haiku. The overnight plan uses Sonnet (`TOWNSFOLK_PLAN_MODEL`, default `sonnet`; API default `claude-sonnet-4-5`) in its own warm process.
- Every reply ends with a fixed plain goodbye (a few short varied wordings, chosen by the brain, not the model). Picking it closes with a short line and makes no further call.
- Every turn carries the whole conversation so far, plus the game's own lines that villager said to that farmer today (first meetings included), which are also remembered as "said (game line)".
- Villagers: no change in who is voiced. The 26 already voiced by default (all giftable villagers except the six who gate progression by talking and the two children) all have full cards, and roster.md allows no one else: Wizard, Krobus, Dwarf, Sandy, Leo, Kent, Jas, Vincent and the non-giftable story characters stay on the deny list. Anyone allowed who has no card (a modded villager with `AllNpcs`) gets the generic card.
- The mod starts the brain itself when a save loads if nothing answers on its port (no window, log in `brain.log` next to the mod) and stops it when the game quits. Needs Node 24+ and Claude Code installed once. `start-brain.cmd` and `start-brain.sh` remain as a manual fallback. New config: `StartBrain`, `NodePath`.
- Fix: the v0.1.0 zip left out `brain/src/cards/roster.ts` (the release script read `brain/src` without subfolders), so the brain failed to start. The release now includes subfolders and refuses to finish unless its own unzipped copy starts with `TOWNSFOLK_MODEL=fake` and answers `/v1/health`.

## 0.1.0

First release for testing, not yet on Nexus.

- Conversations: Claude writes the line, the player picks one of 3 or 4 replies; replies move friendship a little and can leave a promise the NPC remembers.
- Per-NPC memory with knowledge boundaries, kept bounded over many seasons.
- Overnight planner: schedules, a happening, a mailed item quest and relationship shifts, validated in the brain and again in game.
- Canon cast cards for 8 villagers with heart tiers.
- Brain runs on Windows, macOS and Linux (Node 24+), with the Claude Code CLI or an Anthropic API key.
- Release zip with player instructions for the host and for joining players.
