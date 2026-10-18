# Changelog

One version number covers the whole release: `mod/manifest.json`, `mod/Townsfolk.csproj` and `brain/package.json` must match, and each release has a heading here. `npm run release` (in `brain/`) refuses to build otherwise. The release merge is tagged `vX.Y.Z`.

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
