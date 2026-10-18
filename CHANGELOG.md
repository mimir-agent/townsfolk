# Changelog

One version number covers the whole release: `mod/manifest.json`, `mod/Townsfolk.csproj` and `brain/package.json` must match, and each release has a heading here. `npm run release` (in `brain/`) refuses to build otherwise. The release merge is tagged `vX.Y.Z`.

## 0.1.0

First release for testing, not yet on Nexus.

- Conversations: Claude writes the line, the player picks one of 3 or 4 replies; replies move friendship a little and can leave a promise the NPC remembers.
- Per-NPC memory with knowledge boundaries, kept bounded over many seasons.
- Overnight planner: schedules, a happening, a mailed item quest and relationship shifts, validated in the brain and again in game.
- Canon cast cards for 8 villagers with heart tiers.
- Brain runs on Windows, macOS and Linux (Node 24+), with the Claude Code CLI or an Anthropic API key.
- Release zip with player instructions for the host and for joining players.
