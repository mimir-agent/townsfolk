# townsfolk

Working title. A Stardew Valley (SMAPI) mod where Claude runs the town: conversations with picked replies, per-character memory that only knows what that character should know, and a nightly planner that shapes schedules, quests, events, relationships and, later, a generational town.

Work in progress (weekend hackathon).

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

What to expect when something is off:

- Brain not running or slower than 8 seconds: the NPC says their normal game line. Nothing crashes.
- Everyone else in town keeps their normal dialogue. To route every villager through the brain, set `"AllNpcs": true` in `Mods/Townsfolk/config.json` (created after the first launch) and restart the game.
- Memory lives in `~/.local/state/townsfolk/<save folder>/<NPC>.json`, one file per NPC, holding only what that NPC took part in or saw (other villagers in the same location witness a talk or a gift). Delete a file to make them forget.
- A day is remembered only once the game has saved it. If you quit without saving and replay the day, only the replayed version is kept. Each file stays under 32 KB: the last 14 days in full, a summary per season, and one short summary for anything older.
- The bridge and brain speak protocol v1 (schemas in `protocol/`). A brain on another version answers 400, and the game treats that as the brain being down.
- Logs: the brain terminal prints one line per reply; the game side writes to `~/.config/StardewValley/ErrorLogs/SMAPI-latest.txt`.

`config.json` settings: `BrainUrl` (default `http://127.0.0.1:7341`), `EnabledNpcs`, `AllNpcs`, `TimeoutSeconds` (default 8).

Brain settings are environment variables, listed at the top of `brain/src/main.ts`. `TOWNSFOLK_MODEL=fake` runs with canned lines and no model at all; `TOWNSFOLK_MODEL=anthropic` uses `ANTHROPIC_API_KEY` (for players; not tried yet).

## Overnight planner (brain only so far)

`POST /v1/plan` writes tomorrow for the cast of 8 (Abigail, Emily, Gus, Haley, Lewis, Pierre, Robin, Shane): a schedule and a goal per NPC, at most one happening, at most one mailed item quest, and friendship and NPC relationship shifts. The brain checks every part against the world snapshot from `POST /v1/world` and drops what fails, one part at a time, with a reason in the log. A schedule that repeats one of the NPC's last 7 gets one regen, then that NPC runs vanilla. Plan history is kept in `_plans.json` next to the memory files. The mod does not call these endpoints yet (slice 6), so nothing changes in game.

## Development

```sh
cd brain && npm test && npm run typecheck   # no network, no model: tests use a fake adapter
cd mod && ~/.dotnet/dotnet build -p:EnableModDeploy=false   # branch builds never touch the game's Mods folder
```
