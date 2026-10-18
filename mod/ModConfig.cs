using System.Collections.Generic;

namespace Townsfolk;

/// <summary>config.json, created by SMAPI on first run.</summary>
public sealed class ModConfig
{
    /// <summary>
    /// Base URL of the brain. It only ever listens on localhost, and only the host computer uses
    /// it; a farmhand's game talks to the host's mod instead and never opens this URL.
    /// </summary>
    public string BrainUrl { get; set; } = "http://127.0.0.1:7341";

    /// <summary>NPCs whose conversations go through the brain. Everyone else stays vanilla.</summary>
    public List<string> EnabledNpcs { get; set; } = new() { "Abigail", "Pierre", "Lewis", "Emily", "Shane" };

    /// <summary>
    /// Who goes through the brain: "roster" (the 26 villagers in Voiced.cs) or "list" (EnabledNpcs).
    /// A config.json without this key gets "roster". The deny lists in Voiced.cs win either way.
    /// </summary>
    public string Voiced { get; set; } = global::Townsfolk.Voiced.RosterMode;

    /// <summary>When true, every villager who can socialize goes through the brain.</summary>
    public bool AllNpcs { get; set; } = false;

    /// <summary>How long to wait for one reply before giving up and keeping vanilla dialogue.</summary>
    public int TimeoutSeconds { get; set; } = 8;

    /// <summary>
    /// When false, the bridge never sends the world or asks for a plan: schedules, quests and
    /// overnight friendship stay vanilla. Conversations are not affected.
    /// </summary>
    public bool Planning { get; set; } = true;

    /// <summary>
    /// How long to wait for tomorrow's plan. The brain gives up on its own at 120 seconds
    /// (TOWNSFOLK_PLAN_MS); this is a little longer so the brain's answer, even a fallback, arrives.
    /// </summary>
    public int PlanTimeoutSeconds { get; set; } = 150;
}
