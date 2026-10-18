using System;

namespace Townsfolk;

/// <summary>What the player and the SMAPI log are told when the brain cannot do its job: once at save load, and per failed talk. No game types, so tests/Launcher.Tests runs it.</summary>
public sealed record BrainNotice(string Log, string Hud);

public static class BrainCheck
{
    /// <summary>
    /// The notice for a save load, from the brain's /v1/health answer (null: no answer). Null when
    /// all is well. A version check comes first: a brain older than 0.1.2 reports no version and
    /// no readiness at all.
    /// </summary>
    public static BrainNotice? AtLoad(HealthResponse? health, string modVersion, string brainUrl)
    {
        if (health is null)
            return new BrainNotice(
                $"The brain did not answer at {brainUrl} when the save loaded, so villagers use their usual lines. See brain.log next to the mod, or start the brain by hand.",
                "Townsfolk: the brain is not running, so villagers use their usual lines.");
        if (health.Version != modVersion)
        {
            string theirs = health.Version ?? "older than 0.1.2";
            string port = Uri.TryCreate(brainUrl, UriKind.Absolute, out Uri? uri) ? uri.Port.ToString() : brainUrl;
            return new BrainNotice(
                $"A brain from version {theirs} is already running on port {port}; this mod is {modVersion}. Stop it (close its window, or end the node process) and reload the save.",
                $"Townsfolk: an old brain ({theirs}) is running. Close it, then reload the save.");
        }
        if (health.Ready == false)
        {
            string reason = string.IsNullOrWhiteSpace(health.Reason) ? "no reason given" : health.Reason;
            return new BrainNotice($"The brain is running but cannot talk: {reason}", $"Townsfolk: {reason}");
        }
        return null;
    }

    /// <summary>
    /// Why a talk gave nothing to show, or null when the reply is a real one. reply null: no
    /// answer reached this game (the request failed, ran past the timeout, or the host relayed
    /// none). A fallback from a brain older than 0.1.2 carries no reason.
    /// </summary>
    public static string? TalkFailure(TalkResponse? reply, bool overdue, int timeoutSeconds, bool onHost)
    {
        if (reply is null)
            return overdue ? $"no reply within {timeoutSeconds} s" : onHost ? "the request to the brain failed" : "the host sent no reply";
        if (reply.Source != "fallback")
            return null;
        return string.IsNullOrWhiteSpace(reply.Reason) ? "the brain gave no reason (it may be older than 0.1.2)" : reply.Reason;
    }
}
