using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;

namespace Townsfolk;

// SMAPI mod messages between the host's mod and each farmhand's mod (spec-v2 section 2), and
// the rules that need no game types, so tests/Relay.Tests can run them without the game.
// Every req carries a requestId and its resp echoes it.

/// <summary>townsfolk.hello, both ways: the farmhand's mod version, then the host's.</summary>
public sealed record HelloMessage(string RequestId, string Version);

/// <summary>townsfolk.talk.req: a farmhand's talk request. The host replaces every farmer field with the sender's.</summary>
public sealed record TalkRelayRequest(string RequestId, TalkRequest Request);

/// <summary>townsfolk.talk.resp: the brain's reply, or null when there is none (the farmhand then runs vanilla).</summary>
public sealed record TalkRelayResponse(string RequestId, TalkResponse? Response);

/// <summary>townsfolk.event: one talk, gift, join, chat or scene a farmhand made or watched. The host stamps the sender's farmerId.</summary>
public sealed record EventRelay(DayEvent Event);

/// <summary>townsfolk.farmer.apply: the plan parts for Day that belong to one farmer, applied by that farmer's own game.</summary>
public sealed record FarmerApply(string FarmerId, DayRef Day, List<FriendshipShift> Friendship, MailQuest? Quest);

/// <summary>A plan's per-farmer parts: the host's own, one FarmerApply per other farmer, and what was dropped.</summary>
public sealed record PlanSplit(List<FriendshipShift> HostFriendship, MailQuest? HostQuest, List<(long Id, FarmerApply Apply)> Others, List<string> Dropped);

public static class RelayRules
{
    // "eventId" in protocol/common.schema.json.
    private static readonly System.Text.RegularExpressions.Regex EventIdRule =
        new(@"^[A-Za-z0-9_.-]{1,60}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    /// <summary>
    /// A farmhand's event checked against protocol/day-end-request.schema.json, because the brain
    /// refuses the whole day for one bad event. Null when it cannot be sent at all. Every name
    /// becomes a memory file on the host, so the NPC and each witness must be a villager in the
    /// host's game (isVillager), and a talk or join NPC must also be voiced by the host's config
    /// (isVoiced). Witnesses are trimmed, not refused, as the host does for its own events. The
    /// farmer fields are left for the host to overwrite with the sender's.
    /// </summary>
    public static DayEvent? Clean(DayEvent ev, Func<string, bool> isVillager, Func<string, bool> isVoiced, int maxWitnesses)
    {
        bool known = ev.Type switch
        {
            "talk" => Fits(ev.NpcLine, 400) && OptFits(ev.PlayerChoice, 200) && (ev.Fact is null || Fits(ev.Fact.Text, 200)),
            "gift" => Fits(ev.Item, 80) && OptFits(ev.Taste, 20),
            "join" => Fits(ev.Topic, 120),
            "chat" => ev.Reason is "first-meeting" or "quest" or "birthday" or "story",
            "scene" => ev.EventId is not null && EventIdRule.IsMatch(ev.EventId) && ev.Festival is not null,
            _ => false,
        };
        if (!known || ev.Npc is null || !isVillager(ev.Npc) || !Fits(ev.Location, 80) || ev.Time < 600 || ev.Time > 2600)
            return null;
        if (ev.Type is "talk" or "join" && !isVoiced(ev.Npc))
            return null;
        List<string> witnesses = (ev.Witnesses ?? new List<string>())
            .Where(w => w is not null && w != ev.Npc && isVillager(w))
            .Distinct()
            .Take(maxWitnesses)
            .ToList();
        return ev with { Witnesses = witnesses };
    }

    /// <summary>
    /// Splits a plan's friendship shifts and quest by farmer. No farmerId, or the host's, is the
    /// host's (spec-v2 section 2). Every other id gets one FarmerApply. An id that is not a
    /// Farmer.UniqueMultiplayerID in decimal is dropped with a reason.
    /// </summary>
    public static PlanSplit Split(DayRef day, List<FriendshipShift> shifts, MailQuest? quest, string hostId)
    {
        bool IsHost(string? id) => id is null || id == hostId;
        var dropped = new List<string>();
        var others = new List<(long, FarmerApply)>();
        IEnumerable<string> ids = shifts.Select(f => f.FarmerId)
            .Append(quest?.FarmerId)
            .Where(id => !IsHost(id))
            .Select(id => id!)
            .Distinct();
        foreach (string id in ids)
        {
            if (!long.TryParse(id, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long parsed) || parsed.ToString(CultureInfo.InvariantCulture) != id)
            {
                dropped.Add($"farmer id {id} is not a multiplayer id");
                continue;
            }
            others.Add((parsed, new FarmerApply(id, day, shifts.Where(f => f.FarmerId == id).ToList(), quest?.FarmerId == id ? quest : null)));
        }
        return new PlanSplit(
            shifts.Where(f => IsHost(f.FarmerId)).ToList(),
            quest is not null && IsHost(quest.FarmerId) ? quest : null,
            others,
            dropped);
    }

    /// <summary>
    /// Where a farmhand's relayed talk stands on the host's tick: still waiting on the brain,
    /// answered (Reply is the brain's reply, or null when the call failed), or expired after
    /// timeoutSeconds with no reply. An expired talk is answered null, so the farmhand runs
    /// vanilla and its next talk is not refused as busy.
    /// </summary>
    public static (RelayedState State, TalkResponse? Reply) Settle(Task<TalkResponse?> reply, long askedAtMs, long nowMs, int timeoutSeconds)
    {
        if (reply.IsCompleted)
            return (RelayedState.Answered, reply.Status == TaskStatus.RanToCompletion ? reply.Result : null);
        return TalkWait.Overdue(askedAtMs, nowMs, timeoutSeconds) ? (RelayedState.Expired, null) : (RelayedState.Waiting, null);
    }

    private static bool Fits(string? s, int max) => !string.IsNullOrEmpty(s) && s.Length <= max;

    private static bool OptFits(string? s, int max) => s is null || Fits(s, max);
}

public enum RelayedState { Waiting, Answered, Expired }

public enum TalkAdmit { Accepted, TooSoon, Capped }

/// <summary>
/// How much relayed talk one farmhand may spend of the host's model budget: at most DailyCap
/// accepted talks per game day, and none asked less than MinGapMs after that farmhand's last
/// reply. A talk is counted when it is accepted, so a stuck brain call cannot give the count
/// back. Kept across a disconnect, so leaving and rejoining does not reset the day.
/// </summary>
public sealed class TalkBudget
{
    public const int DailyCap = 150;
    public const long MinGapMs = 1000;

    private readonly Dictionary<long, int> talksToday = new();
    private readonly Dictionary<long, long> lastReplyMs = new();

    public TalkAdmit Admit(long farmerId, long nowMs)
    {
        this.talksToday.TryGetValue(farmerId, out int count);
        if (count >= DailyCap)
            return TalkAdmit.Capped;
        if (this.lastReplyMs.TryGetValue(farmerId, out long last) && nowMs - last < MinGapMs)
            return TalkAdmit.TooSoon;
        this.talksToday[farmerId] = count + 1;
        return TalkAdmit.Accepted;
    }

    /// <summary>The host replied to this farmhand at nowMs, with a line or with null.</summary>
    public void Replied(long farmerId, long nowMs) => this.lastReplyMs[farmerId] = nowMs;

    public void NewDay()
    {
        this.talksToday.Clear();
        this.lastReplyMs.Clear();
    }
}
