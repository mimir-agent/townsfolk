using System.Text.RegularExpressions;

namespace Townsfolk;

/// <summary>Why the game's own dialogue answers a click instead of the brain. None: the brain talks.</summary>
public enum VanillaReason { None, FirstMeeting, Quest, Birthday, Story }

/// <summary>
/// The NPC's next line from the game, as it sits on top of the NPC's dialogue stack.
/// TranslationKey is the asset and key it came from ("Characters\Dialogue\Abigail:Mon"), or null
/// when code pushed it (quest messages do). HasCommands: the line carries side effects (mail,
/// items, actions), an item to grab, or a question with answers.
/// </summary>
public sealed record PendingDialogue(string? TranslationKey, bool HasCommands);

/// <summary>What the click rule reads from the game. Built in ModEntry; this file has no game types so it can be unit-tested.</summary>
public sealed record TalkGate(string Npc, bool HasMet, bool QuestForNpc, bool IsBirthday, PendingDialogue? Pending);

/// <summary>
/// The one rule for who answers a right-click on an enabled NPC. The game's own dialogue wins
/// whenever it can move the game forward or carries the story; the brain talks otherwise.
/// </summary>
public static class VanillaFirst
{
    public static VanillaReason Decide(TalkGate g)
    {
        // No friendship entry yet: the game's introduction creates it, and the Introductions quest counts it.
        if (!g.HasMet)
            return VanillaReason.FirstMeeting;
        // An active quest wants the player to talk to (or report back to) this NPC.
        if (g.QuestForNpc)
            return VanillaReason.Quest;
        if (g.IsBirthday)
            return VanillaReason.Birthday;
        if (g.Pending is { } d && IsStory(g.Npc, d))
            return VanillaReason.Story;
        return VanillaReason.None;
    }

    /// <summary>
    /// A pending line carries the story unless it is one of the game's everyday lines and has no
    /// commands. Everyday: the NPC's own sheet keyed by weekday (optionally season and heart level,
    /// "fall_Wed2"), by date ("spring_12") or by a tile in a location ("Town_57_40"); the shared
    /// rainy-day sheet; a spouse's marriage sheet; and the engine's generic filler strings.
    /// Anything else (event follow-ups, relationship news, quest or mail lines, lines pushed by
    /// code with no key) goes to the game.
    /// </summary>
    public static bool IsStory(string npc, PendingDialogue d)
    {
        if (d.HasCommands)
            return true;
        if (d.TranslationKey is null || !TrySplit(d.TranslationKey, out string asset, out string key))
            return true;
        if (asset == $"Characters/Dialogue/{npc}")
            return !EverydayKey.IsMatch(key);
        return !(asset == "Characters/Dialogue/rainy"
            || asset == $"Characters/Dialogue/MarriageDialogue{npc}"
            || asset == "Characters/Dialogue/MarriageDialogue"
            || asset == "Strings/StringsFromCSFiles");
    }

    private static readonly Regex EverydayKey = new(
        @"^(?:(?:spring|summer|fall|winter)_)?(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\d*$" +
        @"|^(?:spring|summer|fall|winter)_\d{1,2}$" +
        @"|^(?:(?:spring|summer|fall|winter)_)?[A-Za-z]+_\d+_\d+$",
        RegexOptions.CultureInvariant);

    /// <summary>Splits "Asset\Path:Key" at the last colon, with slashes normalized to '/'.</summary>
    public static bool TrySplit(string translationKey, out string asset, out string key)
    {
        int colon = translationKey.LastIndexOf(':');
        asset = colon > 0 ? translationKey[..colon].Replace('\\', '/') : "";
        key = colon > 0 ? translationKey[(colon + 1)..] : "";
        return colon > 0 && key.Length > 0;
    }

    /// <summary>The reason as the day-end protocol spells it (protocol/day-end-request.schema.json).</summary>
    public static string WireName(VanillaReason r) => r switch
    {
        VanillaReason.FirstMeeting => "first-meeting",
        VanillaReason.Quest => "quest",
        VanillaReason.Birthday => "birthday",
        VanillaReason.Story => "story",
        _ => throw new System.ArgumentOutOfRangeException(nameof(r), r, "no wire name: the brain talked"),
    };
}
