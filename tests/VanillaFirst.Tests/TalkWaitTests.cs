using Townsfolk;
using Xunit;

namespace Townsfolk.Tests;

public class TalkWaitTests
{
    [Fact]
    public void A_reply_inside_the_timeout_is_still_waited_for() =>
        Assert.False(TalkWait.Overdue(sentAtMs: 1_000, nowMs: 8_999, timeoutSeconds: 8));

    [Fact]
    public void A_reply_at_the_timeout_is_given_up_on() =>
        Assert.True(TalkWait.Overdue(sentAtMs: 1_000, nowMs: 9_000, timeoutSeconds: 8));

    // The hang in the smoke test lasted minutes; the wait must end however long it has been.
    [Fact]
    public void A_reply_minutes_late_is_given_up_on() =>
        Assert.True(TalkWait.Overdue(sentAtMs: 1_000, nowMs: 1_000 + 5 * 60_000, timeoutSeconds: 8));

    // Environment.TickCount64 is large after a long uptime; no overflow at that scale.
    [Fact]
    public void Works_with_a_large_monotonic_clock() =>
        Assert.True(TalkWait.Overdue(sentAtMs: long.MaxValue - 20_000, nowMs: long.MaxValue - 11_000, timeoutSeconds: 8));
}
