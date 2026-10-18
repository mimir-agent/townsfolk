Townsfolk
=========

A Stardew Valley mod where Claude writes what the townspeople say. You talk to someone, they
answer, and you pick one of a few replies. They remember what happened with you, and overnight
the town plans tomorrow: where people go, small happenings, letters asking for help.

Townsfolk has two parts:
- the mod, which runs inside the game (SMAPI loads it), and
- the brain, a small program that talks to Claude and keeps each person's memory.

Only one computer runs the brain: the one that hosts the game (or the only computer, if you play
alone). Players who join someone else's game install only SMAPI and the mod.


HOST (or playing alone)
-----------------------

1. Install SMAPI.
   Follow the guide at https://stardewvalleywiki.com/Modding:Player_Guide/Getting_Started
   Start the game once through SMAPI to check it works, then close it.

2. Install the mod.
   Unzip this download into your Mods folder. You should end up with Mods\Townsfolk, holding
   manifest.json, Townsfolk.dll, start-brain.cmd and a brain folder.
   On Windows with Steam the Mods folder is usually:
     C:\Program Files (x86)\Steam\steamapps\common\Stardew Valley\Mods

3. Install Node.js (version 24 or newer).
   Download the LTS version from https://nodejs.org and run the installer with its default
   choices.

4. Pick how the brain reaches Claude. Choose ONE:

   a) Claude Code, already logged in (uses your Claude subscription).
      Install Claude Code from https://claude.com/claude-code and log in once by opening
      Command Prompt, typing   claude   and following the steps. Then type   /exit
      Nothing else to set: this is what the brain uses by default.

   b) Your own Anthropic API key (pay per use, from https://console.anthropic.com).
      UNTESTED SO FAR: nobody has played with this option yet. Option a) is the tried one.
      Open Command Prompt and type these two lines, with your key in place of YOUR-KEY:
        setx TOWNSFOLK_MODEL anthropic
        setx ANTHROPIC_API_KEY YOUR-KEY
      Close Command Prompt. The setting applies to windows you open afterwards.
      The key stays on your computer. Never share it or post a screenshot of it.

5. Start the brain.
   Double-click start-brain.cmd in Mods\Townsfolk. A black window opens and says
     townsfolk brain on http://127.0.0.1:7341 ...
   Leave it open while you play. Close it when you are done.
   (Mac or Linux: run   sh start-brain.sh   in a terminal from that folder.)

6. Start the brain before you load your farm. Then start Stardew Valley through SMAPI and load
   your farm. Talk to Abigail, Pierre, Lewis, Emily or Shane. They pause for a moment while the
   brain writes, then you pick a reply.


JOINING PLAYER (you join someone else's game)
---------------------------------------------

1. Install SMAPI (step 1 above).
2. Install the mod (step 2 above). You do not need Node.js, Claude Code, an API key, or
   start-brain.cmd. The host's computer does that work.
3. Join the host's game as usual.


GOOD TO KNOW
------------

- If the brain is not running, or Claude is slow (more than 8 seconds), people say their normal
  game lines. Nothing breaks. The first meeting with someone, birthdays, quests and story
  scenes always use the game's own dialogue.
- Memory is kept on the host's computer, one file per person, in
    %LOCALAPPDATA%\townsfolk\<save name>\        (Windows)
    ~/.local/state/townsfolk/<save name>/        (Mac, Linux)
  Delete a file to make that person forget. A day is remembered only after the game saves it.
- Mod settings are in Mods\Townsfolk\config.json, created the first time the game starts with
  the mod. "AllNpcs": true lets every villager talk through the brain, not only the five above.
- Problems: the brain window shows one line per reply or error. The game writes its log to
    %APPDATA%\StardewValley\ErrorLogs\SMAPI-latest.txt
- "could not find claude": Claude Code is not installed, or was installed after the brain
  window opened. Close the window, check that   claude --version   works in a new Command
  Prompt, and start the brain again.

Version and changes: see manifest.json for the version. Source and history:
https://github.com/mimir-agent/townsfolk
