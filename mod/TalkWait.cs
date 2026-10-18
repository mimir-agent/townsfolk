namespace Townsfolk;

/// <summary>
/// How long the bridge waits for one talk reply, measured on the game thread. HttpClient's own
/// timeout runs on the thread pool and did not end the first talk after a load in the 436a094
/// smoke test; this check does not depend on it, so the player is never left waiting with
/// their clicks suppressed.
/// </summary>
public static class TalkWait
{
    /// <summary>True once a reply asked for at sentAtMs is overdue at nowMs (both from one monotonic clock).</summary>
    public static bool Overdue(long sentAtMs, long nowMs, int timeoutSeconds) =>
        nowMs - sentAtMs >= timeoutSeconds * 1000L;

    /// <summary>How many dots the waiting box shows at a given moment: 1, 2, 3, then 1 again, a change every 350 ms.</summary>
    public static int DotsAt(long nowMs) => 1 + (int)(nowMs / 350 % 3);
}
