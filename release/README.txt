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

5. Start the game through SMAPI and load your farm. That is all.
   The mod starts the brain by itself when the save loads, with no window, and stops it when you
   quit the game. Its log is Mods\Townsfolk\brain.log. You install Node.js and Claude Code once
   and never open the brain by hand.

   Fallback, only if the mod cannot start it (the SMAPI log says why): double-click
   start-brain.cmd in Mods\Townsfolk and leave the window open (Mac or Linux: sh start-brain.sh).
   If you do, you can set "StartBrain": false in config.json so the mod does not try as well.
   If node is not found, set "NodePath" in config.json to the full path of node.

6. Talk to anyone in town. A box with their name and portrait and moving dots stays up while the
   reply is written, and the world waits, as in any conversation. Press Escape to leave. The last
   reply is always a plain goodbye.

   The first time you talk to each villager on a new save, you get the game's own introduction.
   That is on purpose: it counts as meeting them and keeps the story intact. Claude takes over
   from the second talk.


JOINING PLAYER (you join someone else's game)
---------------------------------------------

1. Install SMAPI (step 1 above).
2. Install the mod (step 2 above). You do not need Node.js, Claude Code, an API key, or
   start-brain.cmd. The host's computer does that work.
3. Join the host's game as usual.


GOOD TO KNOW
------------

- If the brain is not running, or Claude is slow (more than 25 seconds), people say their normal
  game lines. Nothing breaks. When a save loads, a red message at the bottom left says so if the
  brain is not running, Claude Code is missing or not logged in, or an old brain from another
  version is still running (close the window or Terminal tab you started it in, then reload). The first meeting with someone, birthdays, quests and story
  scenes always use the game's own dialogue.
- Memory is kept on the host's computer, one file per person, in
    %LOCALAPPDATA%\townsfolk\<save name>\        (Windows)
    ~/.local/state/townsfolk/<save name>/        (Mac, Linux)
  Delete a file to make that person forget. A day is remembered only after the game saves it.
- Mod settings are in Mods\Townsfolk\config.json, created the first time the game starts with
  the mod. "AllNpcs": true lets every villager talk through the brain, not only the 26 villagers voiced by default.
- Problems: the brain window shows one line per reply or error. The game writes its log to
    %APPDATA%\StardewValley\ErrorLogs\SMAPI-latest.txt
- "could not find claude": Claude Code is not installed, or was installed after the brain
  window opened. Close the window, check that   claude --version   works in a new Command
  Prompt, and start the brain again.

Version and changes: see manifest.json for the version. Source and history:
https://github.com/mimir-agent/townsfolk
