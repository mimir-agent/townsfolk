using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using Townsfolk;
using Xunit;

namespace Townsfolk.Tests;

public class RelayRulesTests
{
    // Same rule as ModEntry.ProtocolName and "name" in protocol/common.schema.json.
    private static readonly Regex Name = new(@"^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$", RegexOptions.CultureInvariant);
    private static DayEvent? Clean(DayEvent e) => RelayRules.Clean(e, Name.IsMatch, 40);

    private static readonly DayEvent Talk = new("talk", "Abigail", "Town", 1200, new List<string> { "Sam" }, NpcLine: "Hi.", PlayerChoice: "Hello.");
    private static readonly DayRef Day = new("spring", 3, 1);
    private const string Host = "123";

    [Fact]
    public void A_good_talk_event_passes_unchanged()
    {
        DayEvent? c = Clean(Talk);
        Assert.NotNull(c);
        Assert.Equal(Talk.NpcLine, c!.NpcLine);
        Assert.Equal(new[] { "Sam" }, c.Witnesses);
    }

    [Theory]
    [InlineData("scene")]
    [InlineData("hack")]
    [InlineData("")]
    public void An_event_type_the_day_end_protocol_does_not_know_is_dropped(string type) =>
        Assert.Null(Clean(Talk with { Type = type }));

    [Fact]
    public void Text_past_the_protocol_limits_is_dropped()
    {
        Assert.Null(Clean(Talk with { NpcLine = new string('a', 401) }));
        Assert.Null(Clean(Talk with { PlayerChoice = new string('a', 201) }));
        Assert.Null(Clean(Talk with { Location = new string('a', 81) }));
        Assert.Null(Clean(Talk with { Time = 599 }));
        Assert.Null(Clean(Talk with { Npc = "<script>" }));
    }

    [Fact]
    public void A_chat_needs_a_known_reason()
    {
        var chat = new DayEvent("chat", "Shane", "Saloon", 1900, new List<string>(), Reason: "birthday");
        Assert.NotNull(Clean(chat));
        Assert.Null(Clean(chat with { Reason = "anything" }));
    }

    [Fact]
    public void Witnesses_are_trimmed_not_refused()
    {
        var many = Enumerable.Range(0, 60).Select(i => $"V{i}").Append("Abigail").Append("V1").Append("bad|name").ToList();
        DayEvent? c = Clean(Talk with { Witnesses = many });
        Assert.NotNull(c);
        Assert.Equal(40, c!.Witnesses.Count);
        Assert.DoesNotContain("Abigail", c.Witnesses);
        Assert.DoesNotContain("bad|name", c.Witnesses);
        Assert.Equal(c.Witnesses.Count, c.Witnesses.Distinct().Count());
    }

    [Fact]
    public void Shifts_with_no_farmer_or_the_host_id_stay_with_the_host()
    {
        var shifts = new List<FriendshipShift> { new("Abigail", 5, "a"), new("Shane", -3, "b", Host) };
        PlanSplit s = RelayRules.Split(Day, shifts, null, Host);
        Assert.Equal(2, s.HostFriendship.Count);
        Assert.Empty(s.Others);
        Assert.Empty(s.Dropped);
    }

    [Fact]
    public void Each_other_farmer_gets_only_their_own_parts()
    {
        var shifts = new List<FriendshipShift> { new("Abigail", 5, "a"), new("Shane", 4, "b", "456"), new("Emily", 2, "c", "-789"), new("Lewis", 1, "d", "456") };
        var quest = new MailQuest("townsfolk_1", "(O)24", "Pierre", 100, "Please.", "456");
        PlanSplit s = RelayRules.Split(Day, shifts, quest, Host);

        Assert.Single(s.HostFriendship);
        Assert.Null(s.HostQuest);
        Assert.Equal(2, s.Others.Count);
        (long id, FarmerApply a) = s.Others.Single(o => o.Id == 456);
        Assert.Equal("456", a.FarmerId);
        Assert.Equal(Day, a.Day);
        Assert.Equal(new[] { "Shane", "Lewis" }, a.Friendship.Select(f => f.Npc));
        Assert.Equal(quest, a.Quest);
        FarmerApply other = s.Others.Single(o => o.Id == -789).Apply;
        Assert.Equal(new[] { "Emily" }, other.Friendship.Select(f => f.Npc));
        Assert.Null(other.Quest);
    }

    [Fact]
    public void A_quest_with_no_farmer_is_the_hosts() =>
        Assert.NotNull(RelayRules.Split(Day, new List<FriendshipShift>(), new MailQuest("townsfolk_2", "(O)24", "Pierre", 100, "Please."), Host).HostQuest);

    [Theory]
    [InlineData("main")]
    [InlineData("12x")]
    [InlineData("007")]
    [InlineData("99999999999999999999")]
    public void A_farmer_id_that_is_not_a_multiplayer_id_is_dropped_with_a_reason(string id)
    {
        PlanSplit s = RelayRules.Split(Day, new List<FriendshipShift> { new("Shane", 4, "b", id) }, null, Host);
        Assert.Empty(s.HostFriendship);
        Assert.Empty(s.Others);
        Assert.Single(s.Dropped);
        Assert.Contains(id, s.Dropped[0]);
    }

    [Fact]
    public void A_relayed_reply_with_a_null_choice_is_not_usable()
    {
        var good = new TalkResponse(1, "Hi.", new List<TalkChoice> { new("a", "Hello.", 1) }, false, "model");
        Assert.True(BrainClient.IsUsable(good));
        Assert.False(BrainClient.IsUsable(good with { Choices = new List<TalkChoice> { null! } }));
        Assert.False(BrainClient.IsUsable(good with { V = 2 }));
        Assert.False(BrainClient.IsUsable(good with { Line = " " }));
    }
}
