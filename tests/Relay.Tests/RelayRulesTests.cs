using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Townsfolk;
using Xunit;

namespace Townsfolk.Tests;

public class RelayRulesTests
{
    // Same rule as ModEntry.ProtocolName and "name" in protocol/common.schema.json.
    private static readonly Regex Name = new(@"^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$", RegexOptions.CultureInvariant);
    // Every regex-valid name stands in for a villager here, except the ones in NotVillagers and
    // NotVoiced; the host checks Game1.getCharacterFromName and its config in their place.
    private static readonly HashSet<string> NotVillagers = new() { "NUL", "CON", "Zzz" };
    private static readonly HashSet<string> NotVoiced = new() { "Krobus" };
    private static bool Villager(string n) => Name.IsMatch(n) && !NotVillagers.Contains(n);
    private static bool Voiced(string n) => Villager(n) && !NotVoiced.Contains(n);
    private static DayEvent? Clean(DayEvent e) => RelayRules.Clean(e, Villager, Voiced, 40);

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

    [Theory]
    [InlineData("NUL")]
    [InlineData("CON")]
    [InlineData("Zzz")]
    public void An_event_whose_npc_is_not_a_villager_here_is_dropped(string npc)
    {
        Assert.Null(Clean(Talk with { Npc = npc }));
        Assert.Null(Clean(new DayEvent("gift", npc, "Town", 1200, new List<string>(), Item: "Daffodil")));
    }

    [Fact]
    public void Witnesses_that_are_not_villagers_here_are_dropped_and_the_event_kept()
    {
        DayEvent? c = Clean(Talk with { Witnesses = new List<string> { "Sam", "NUL", "Zzz", "CON", "Penny" } });
        Assert.NotNull(c);
        Assert.Equal(new[] { "Sam", "Penny" }, c!.Witnesses);
    }

    [Fact]
    public void Talk_and_join_need_an_npc_the_host_voices_but_gift_and_chat_do_not()
    {
        Assert.Null(Clean(Talk with { Npc = "Krobus" }));
        Assert.Null(Clean(new DayEvent("join", "Krobus", "Sewer", 1200, new List<string>(), Topic: "a walk")));
        Assert.NotNull(Clean(new DayEvent("gift", "Krobus", "Sewer", 1200, new List<string>(), Item: "Void Egg")));
        Assert.NotNull(Clean(new DayEvent("chat", "Krobus", "Sewer", 1200, new List<string>(), Reason: "birthday")));
    }

    [Fact]
    public void A_relayed_talk_waits_until_the_timeout_then_expires_with_no_reply()
    {
        var never = new TaskCompletionSource<TalkResponse?>().Task;
        Assert.Equal(RelayedState.Waiting, RelayRules.Settle(never, 1_000, 1_000 + 7_999, 8).State);
        (RelayedState state, TalkResponse? reply) = RelayRules.Settle(never, 1_000, 1_000 + 8_000, 8);
        Assert.Equal(RelayedState.Expired, state);
        Assert.Null(reply);
    }

    [Fact]
    public void A_relayed_talk_that_finished_is_answered_even_when_late()
    {
        var line = new TalkResponse(1, "Hi.", new List<TalkChoice> { new("a", "Hello.", 1) }, false, "model");
        Assert.Equal((RelayedState.Answered, line), RelayRules.Settle(Task.FromResult<TalkResponse?>(line), 0, 60_000, 8));
        Assert.Equal((RelayedState.Answered, (TalkResponse?)null), RelayRules.Settle(Task.FromException<TalkResponse?>(new System.Exception("down")), 0, 0, 8));
    }

    [Fact]
    public void A_farmhand_gets_at_most_the_daily_cap_of_relayed_talks()
    {
        var b = new TalkBudget();
        long t = 0;
        for (int i = 0; i < TalkBudget.DailyCap; i++)
        {
            Assert.Equal(TalkAdmit.Accepted, b.Admit(456, t));
            t += 2_000;
            b.Replied(456, t);
            t += 2_000;
        }
        Assert.Equal(TalkAdmit.Capped, b.Admit(456, t));
        // Another farmhand has its own count.
        Assert.Equal(TalkAdmit.Accepted, b.Admit(789, t));
        b.NewDay();
        Assert.Equal(TalkAdmit.Accepted, b.Admit(456, t));
    }

    [Fact]
    public void A_talk_asked_inside_the_gap_after_a_reply_is_refused_and_not_counted()
    {
        var b = new TalkBudget();
        Assert.Equal(TalkAdmit.Accepted, b.Admit(456, 10_000));
        b.Replied(456, 12_000);
        Assert.Equal(TalkAdmit.TooSoon, b.Admit(456, 12_000 + TalkBudget.MinGapMs - 1));
        Assert.Equal(TalkAdmit.Accepted, b.Admit(456, 12_000 + TalkBudget.MinGapMs));
        // Two accepted, the refused one not counted: the cap still allows DailyCap - 2 more.
        long t = 20_000;
        for (int i = 0; i < TalkBudget.DailyCap - 2; i++, t += 2_000)
            Assert.Equal(TalkAdmit.Accepted, b.Admit(456, t));
        Assert.Equal(TalkAdmit.Capped, b.Admit(456, t));
    }

    [Fact]
    public void A_talk_still_waiting_on_the_brain_stays_counted()
    {
        var b = new TalkBudget();
        for (int i = 0; i < TalkBudget.DailyCap; i++)
            Assert.Equal(TalkAdmit.Accepted, b.Admit(456, i * 10_000L));
        Assert.Equal(TalkAdmit.Capped, b.Admit(456, 10_000_000));
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
