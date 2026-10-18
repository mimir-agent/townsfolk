using System;
using System.Collections.Generic;
using System.Linq;
#if !VOICED_PURE
using Microsoft.Xna.Framework;
using StardewValley;
#endif

namespace Townsfolk;

/// <summary>
/// Who may ever be Claude-voiced. The lists follow the roster audit (roster.md, 2026-10-17):
/// 34 giftable villagers, minus 6 who gate progression, minus the 2 children, leaves 26.
/// brain/src/voices.ts holds the same three lists and its test reads this file to check they agree.
/// No game types in this class, so tests/Voiced.Tests can run it without the game.
/// </summary>
public static class Voiced
{
    /// <summary>The 26 villagers voiced by default.</summary>
    public static readonly IReadOnlySet<string> Roster = new HashSet<string>(StringComparer.Ordinal)
    {
        // Marriage candidates.
        "Alex", "Elliott", "Harvey", "Sam", "Sebastian", "Shane",
        "Abigail", "Emily", "Haley", "Leah", "Maru", "Penny",
        // Other giftable villagers.
        "Caroline", "Clint", "Demetrius", "Evelyn", "George", "Gus",
        "Jodi", "Lewis", "Linus", "Marnie", "Pam", "Pierre", "Robin", "Willy",
    };

    /// <summary>
    /// Never voiced, whatever the config says: each gates progression by talking (a language to
    /// learn, a key, a quest step, a shop, a year-2 return) or has no heart meter at all.
    /// Mr. Qi and Professor Snail are listed under their display names and under the internal
    /// names the game is believed to use for them (MrQi, SafariGuy), since the check runs on
    /// NPC.Name. Listing a name that never occurs costs nothing.
    /// </summary>
    public static readonly IReadOnlySet<string> HardDeny = new HashSet<string>(StringComparer.Ordinal)
    {
        "Dwarf", "Krobus", "Wizard", "Sandy", "Leo", "Kent",
        "Birdie", "Bouncer", "Fizz", "Gil", "Governor", "Grandpa", "Gunther", "Henchman",
        "Marlon", "Morris", "Mr. Qi", "MrQi", "Professor Snail", "SafariGuy",
    };

    /// <summary>The two children, kept vanilla for tone in this version. Never voiced either.</summary>
    public static readonly IReadOnlySet<string> SoftDeny = new HashSet<string>(StringComparer.Ordinal)
    {
        "Jas", "Vincent",
    };

    /// <summary>config.json "Voiced": "roster", the 26 above. The default, and what a config with no Voiced key gets.</summary>
    public const string RosterMode = "roster";

    /// <summary>config.json "Voiced": "list", only the names in EnabledNpcs.</summary>
    public const string ListMode = "list";

    public static bool IsDenied(string name) => HardDeny.Contains(name) || SoftDeny.Contains(name);

    /// <summary>
    /// Whether this NPC's talk may go to the brain. The deny lists are checked first and win over
    /// everything. Then AllNpcs (every other villager; the caller has already checked it can
    /// socialize), then the Voiced mode, compared ignoring case. A null mode ("Voiced": null in
    /// config.json) is treated like a missing key: roster. Any other value (a typo) voices nobody,
    /// because the game's own dialogue is the safe side.
    /// </summary>
    public static bool Allows(string name, string? mode, bool allNpcs, IReadOnlyCollection<string> enabledNpcs)
    {
        if (IsDenied(name))
            return false;
        if (allNpcs)
            return true;
        return mode?.ToLowerInvariant() switch
        {
            null or RosterMode => Roster.Contains(name),
            ListMode => enabledNpcs.Contains(name),
            _ => false,
        };
    }
}

#if !VOICED_PURE
/// <summary>
/// Shop counters open from a tile action on the Buildings layer ("Action OpenShop" and friends),
/// not from the shopkeeper. The bridge looks for an NPC on the clicked tile and the tile below it
/// (sprites are two tiles tall), so a click on a counter next to its owner could look like a
/// click on the owner. If either tile carries an Action, the click is the game's.
/// Left out of the unit-test build (VOICED_PURE) because it reads the game's map.
/// </summary>
public static class CounterGuard
{
    public static bool IsCounterClick(GameLocation location, Vector2 grabTile)
    {
        foreach (Vector2 tile in new[] { grabTile, grabTile + new Vector2(0, 1) })
        {
            if (location.doesTileHaveProperty((int)tile.X, (int)tile.Y, "Action", "Buildings") is not null)
                return true;
        }
        return false;
    }
}
#endif
