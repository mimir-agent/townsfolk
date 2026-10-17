using System.Collections.Generic;

namespace Townsfolk;

/// <summary>config.json, created by SMAPI on first run.</summary>
public sealed class ModConfig
{
    /// <summary>Base URL of the brain. It only ever listens on localhost.</summary>
    public string BrainUrl { get; set; } = "http://127.0.0.1:7341";

    /// <summary>NPCs whose conversations go through the brain. Everyone else stays vanilla.</summary>
    public List<string> EnabledNpcs { get; set; } = new() { "Abigail", "Pierre", "Lewis", "Emily", "Shane" };

    /// <summary>When true, every villager who can socialize goes through the brain.</summary>
    public bool AllNpcs { get; set; } = false;

    /// <summary>How long to wait for one reply before giving up and keeping vanilla dialogue.</summary>
    public int TimeoutSeconds { get; set; } = 8;
}
