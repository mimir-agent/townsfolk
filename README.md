# townsfolk

Working title. A Stardew Valley (SMAPI) mod where Claude runs the town: conversations with picked replies, per-character memory that only knows what that character should know, and a nightly planner that shapes schedules, quests, events, relationships and, later, a generational town.

Work in progress (weekend hackathon).

## Playing

Townsfolk runs a host-only brain with farmhand-only SMAPI + mod: only the computer that hosts the game runs the brain and talks to Claude. Single player is the host case. The full player steps ship in the release zip as `README.txt` (source: [`release/README.txt`](release/README.txt)).

Not run on Windows yet. The Windows steps here and in `release/README.txt` (`start-brain.cmd`, finding `claude.cmd` or `claude.exe` on PATH, the Mac-built mod DLL under Windows SMAPI) have not been tried on a Windows PC.

### Host (or playing alone)

On the host only:

1. Install SMAPI.
2. Install the mod: unzip `townsfolk-vX.Y.Z.zip` into the game's `Mods` folder, giving `Mods/Townsfolk`.
3. Install Node.js 24 or newer. The brain ships inside the zip (`Mods/Townsfolk/brain`) with nothing more to install.
4. Let the brain reach Claude: log in to the Claude Code CLI once (`claude`), or set `TOWNSFOLK_MODEL=anthropic` and `ANTHROPIC_API_KEY` (the API key path is untested so far).
5. Start the brain (`start-brain.cmd` on Windows, `sh start-brain.sh` on Mac or Linux) and leave it running. The brain must be running before the host loads the save.
6. Start the game through SMAPI and load the farm.

### Joining player

Install SMAPI and the mod (unzip into `Mods`) only, nothing else: no Node.js, no brain, no Claude login, no API key. The host's brain does that work.

## Layout

- `brain/`: the town brain, TypeScript on Node 24+ with no build step. A localhost HTTP server that writes each conversation turn and keeps per-NPC memory on disk.
- `mod/`: the SMAPI bridge, C#. It reads game state, shows the dialogue the brain writes, and records what each NPC saw. It holds no game logic of its own.

## Try it tonight

On the Mac mini. You need two things running: the brain in a terminal, and the game through SMAPI.

1. Start the brain (leave this terminal open):

   ```sh
   cd brain
   npm install          # first time only; installs TypeScript for the typecheck, nothing at runtime
   npm start
   ```

   It prints `townsfolk brain on http://127.0.0.1:7341 model=claude-cli ...`. It uses the `claude` command line tool and its own login; no key is needed or stored. Each reply takes about 3 to 5 seconds.

   Optional check from another terminal: `sh brain/scripts/smoke.sh` talks to Abigail twice, ends a day, and talks again the next day.

2. Build and install the mod (first time, or after changing `mod/`):

   ```sh
   cd mod
   ~/.dotnet/dotnet build
   ```

   This copies the mod into `.../Stardew Valley/Contents/MacOS/Mods/Townsfolk`.

3. Launch the game through SMAPI. Either start Stardew Valley from Steam as usual (SMAPI is installed over the game's launcher), or run it directly:

   ```sh
   "$HOME/Library/Application Support/Steam/steamapps/common/Stardew Valley/Contents/MacOS/StardewModdingAPI"
   ```

   The SMAPI console should list `Townsfolk 0.1.0`.

4. In game, talk to Abigail, Pierre, Lewis, Emily or Shane. They show a thinking bubble while the brain writes, then a line with 3 or 4 replies to pick from. A conversation runs up to 3 replies. Talk, give a gift, sleep, and talk to the same person the next day: they remember.

The game's own dialogue still answers when it matters, so the mod never holds back the story or a quest. That is the first meeting with someone (so the Introductions quest counts them), anyone an active quest sends you to, a villager's birthday, and any line tied to an event, relationship or town milestone, or one that gives an item or asks a question. Those talks are remembered too ("we met for the first time"), without the game's words. Each villager also knows the heart events you saw with them, and the ones they were in for someone else's, so Shane can bring up the day at the cliffs. Nobody else knows that scene unless they were in it.

What to expect when something is off:

- Brain not running or slower than 8 seconds: the NPC says their normal game line. Nothing crashes.
- Everyone else in town keeps their normal dialogue. To route every villager through the brain, set `"AllNpcs": true` in `Mods/Townsfolk/config.json` (created after the first launch) and restart the game.
- Memory lives in `~/.local/state/townsfolk/<save folder>/<NPC>.json` (Windows: `%LOCALAPPDATA%\townsfolk\...`), one file per NPC, holding only what that NPC took part in or saw (other villagers in the same location witness a talk or a gift). Delete a file to make them forget.
- A day is remembered only once the game has saved it. If you quit without saving and replay the day, only the replayed version is kept. Each file stays under 32 KB: the last 14 days in full, a summary per season, and one short summary for anything older.
- The bridge and brain speak protocol v1 (schemas in `protocol/`). A brain on another version answers 400, and the game treats that as the brain being down.
- Logs: the brain terminal prints one line per reply; the game side writes to `~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt`.

`config.json` settings: `BrainUrl` (default `http://127.0.0.1:7341`), `EnabledNpcs`, `AllNpcs`, `TimeoutSeconds` (default 8), `Planning` (default true; false turns off the overnight plan entirely, conversations keep working), `PlanTimeoutSeconds` (default 150).

Brain settings are environment variables, listed at the top of `brain/src/main.ts`. `TOWNSFOLK_MODEL=fake` runs with canned lines and no model at all; `TOWNSFOLK_MODEL=anthropic` uses `ANTHROPIC_API_KEY` (for players; not tried yet).

## Release zip (Windows, macOS, Linux)

```sh
cd brain
DOTNET=~/.dotnet/dotnet npm run release
```

Writes `dist/townsfolk-vX.Y.Z.zip`: one `Townsfolk/` folder the player unzips into `Mods`, holding the mod (`manifest.json`, `Townsfolk.dll`), the player instructions (`README.txt`, from `release/README.txt`), `start-brain.cmd` and `start-brain.sh`, and the brain source in `brain/` (no dependencies to install at runtime). The mod is built with `EnableModDeploy=false`, so nothing is copied into a Mods folder.

One version number covers the release: `mod/manifest.json`, `mod/Townsfolk.csproj` and `brain/package.json` must match and `CHANGELOG.md` needs a `## X.Y.Z` heading. A test checks this and the script refuses to build otherwise. The release merge is tagged `vX.Y.Z`.

`UpdateKeys` in `mod/manifest.json` stays empty until there is a Nexus page. Then set it to `["Nexus:<mod id>"]`, where the id is the number in the page URL (`nexusmods.com/stardewvalley/mods/<mod id>`).

Only the host runs the brain. Joining players install SMAPI and the mod only. On Windows the brain keeps memory in `%LOCALAPPDATA%\townsfolk` and finds `claude` on PATH as `claude.exe` or the npm `claude.cmd`.

## Overnight planner

`POST /v1/plan` writes tomorrow for the cast of 8 (Abigail, Emily, Gus, Haley, Lewis, Pierre, Robin, Shane): a schedule and a goal per NPC, at most one happening, at most one mailed item quest, and friendship and NPC relationship shifts. The brain checks every part against the world snapshot from `POST /v1/world` and drops what fails, one part at a time, with a reason in the log. A schedule that repeats one of the NPC's last 7 gets one regen, then that NPC runs vanilla. Plan history is kept in `_plans.json` next to the memory files.

In game (`mod/Planner.cs`): at save load the mod sends the world (locations with sizes, quest-worthy items, festival days, married NPCs). When the day ends it asks for tomorrow's plan without waiting. About a second after the next morning starts, if the plan is in, the mod applies it:

- Schedules: each planned NPC gets a schedule for today's date through `Characters/schedules/<Name>`. The mod first re-checks every stop against the live game: the location exists, the tile is on the map, and there is a walking route from the NPC's home. A stop on a tile an NPC cannot stand on moves to the nearest tile they can, within 4 tiles; with none in reach the stop fails. One failing stop keeps that NPC on their vanilla day. A vanilla schedule already written for this exact date wins.
- Quest: one item-delivery quest with a `townsfolk_` id, added to `Data/Quests` and `Data/mail` and sent as a letter that adds the quest when read. Only from someone the player has met. The mod keeps the quests it has sent in `Mods/Townsfolk/data/<save folder>.json` so they still exist after a restart. Vanilla quest and mail entries are never edited.
- Friendship: each shift is added toward the player, for NPCs the player has already met.

If the plan is not in by morning, the day starts vanilla; a plan that arrives before noon still applies (the NPCs walk to their planned stop from wherever they are). Brain down, a wrong day, a fallback plan or a festival: the day stays vanilla. Each failure is one line in the SMAPI log.

## Conversations with consequences

Each reply the player can pick moves that NPC's friendship a little (at most 15 points a pick, at most 40 points a day from talk), and some replies leave something the NPC remembers, such as a promise. Promises reach that NPC's memory, its prompts and tomorrow's plan, and can travel as gossip unless they were said in confidence. Talk prompts also carry the NPC's own goal and today's happening if they are in it. Talking to someone at a happening, during it, offers one "join in" reply: picking it gives everyone there a small friendship gain and they all remember the player joined. The happening comes from the night's plan, so the join choice appears only on days the mod applied a plan.

## Year simulator and town diary

```sh
cd brain
npm run sim -- --days 112 --seed 1          # offline, fake model, a few seconds
npm run sim -- --adapter claude-cli --days 14 --seed 1   # real model through the claude CLI, slow
```

The sim starts a real brain on a free localhost port with a throwaway state folder and drives it the way the bridge does: world snapshot once, then each day 2 or 3 seeded conversations (with the join choice when the player walks into a happening), day-end with who spent time together, tomorrow's plan, and the save. The offline fake model builds varied plans from hand-written pieces in `brain/sim/world.ts` with the same seeded RNG, copies yesterday's schedule now and then (so the repeat guard runs), and slips in an invalid part about one night in six (so the validator has something to drop). The same seed always gives the same diary.

It writes one Markdown diary (default `brain/sim-out/`, not committed): per day the plan with each NPC's stops and goal, the happening, the quest, what the player did, gossip that moved overnight, relationship changes and every dropped plan part. The summary at the end lists the checks, and the exit code is 1 if any fails:

- every memory file at most 32 KB on every day
- the slice 2 canary (told to Emily in confidence on day 1) never reaches another NPC's prompt, memory file or facts
- no NPC has an identical planned schedule on more than 3 consecutive planned days
- at least 8 distinct goals started across the cast (enforced for runs of 112 days or more)
- every plan part the brain returns passes the validator again

With `--adapter claude-cli` the player's picks are still seeded, but the model's answers vary, so that diary does not replay.

## Development

```sh
cd brain && npm test && npm run typecheck   # no network, no model: tests use a fake adapter
cd mod && ~/.dotnet/dotnet build -p:EnableModDeploy=false   # branch builds never touch the game's Mods folder
~/.dotnet/dotnet test tests/VanillaFirst.Tests   # who answers a click; no game needed
```
