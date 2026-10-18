using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;

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

/// <summary>townsfolk.event: one talk, gift, join or chat a farmhand made. The host stamps the sender's farmerId.</summary>
public sealed record EventRelay(DayEvent Event);

/// <summary>townsfolk.farmer.apply: the plan parts for Day that belong to one farmer, applied by that farmer's own game.</summary>
public sealed record FarmerApply(string FarmerId, DayRef Day, List<FriendshipShift> Friendship, MailQuest? Quest);

/// <summary>A plan's per-farmer parts: the host's own, one FarmerApply per other farmer, and what was dropped.</summary>
public sealed record PlanSplit(List<FriendshipShift> HostFriendship, MailQuest? HostQuest, List<(long Id, FarmerApply Apply)> Others, List<string> Dropped);

public static class RelayRules
{
    /// <summary>
    /// A farmhand's event checked against protocol/day-end-request.schema.json, because the brain
    /// refuses the whole day for one bad event. Null when it cannot be sent at all. Witnesses are
    /// trimmed, not refused, as the host does for its own events. The farmer fields are left for
    /// the host to overwrite with the sender's.
    /// </summary>
    public static DayEvent? Clean(DayEvent ev, Func<string, bool> isName, int maxWitnesses)
    {
        bool known = ev.Type switch
        {
            "talk" => Fits(ev.NpcLine, 400) && OptFits(ev.PlayerChoice, 200) && (ev.Fact is null || Fits(ev.Fact.Text, 200)),
            "gift" => Fits(ev.Item, 80) && OptFits(ev.Taste, 20),
            "join" => Fits(ev.Topic, 120),
            "chat" => ev.Reason is "first-meeting" or "quest" or "birthday" or "story",
            _ => false,
        };
        if (!known || ev.Npc is null || !isName(ev.Npc) || !Fits(ev.Location, 80) || ev.Time < 600 || ev.Time > 2600)
            return null;
        List<string> witnesses = (ev.Witnesses ?? new List<string>())
            .Where(w => w is not null && w != ev.Npc && isName(w))
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

    private static bool Fits(string? s, int max) => !string.IsNullOrEmpty(s) && s.Length <= max;

    private static bool OptFits(string? s, int max) => s is null || Fits(s, max);
}
