using Townsfolk;
using Xunit;

namespace Townsfolk.Tests;

public class VanillaFirstTests
{
    // A met NPC on an ordinary day with an ordinary line: the brain talks.
    private static readonly PendingDialogue Everyday = new(@"Characters\Dialogue\Shane:Mon", false);
    private static TalkGate Ordinary(PendingDialogue? pending = null) => new("Shane", HasMet: true, QuestForNpc: false, IsBirthday: false, pending ?? Everyday);

    [Fact]
    public void Ordinary_day_goes_to_the_brain() =>
        Assert.Equal(VanillaReason.None, VanillaFirst.Decide(Ordinary()));

    [Fact]
    public void Nothing_left_to_say_today_goes_to_the_brain() =>
        Assert.Equal(VanillaReason.None, VanillaFirst.Decide(Ordinary() with { Pending = null }));

    [Fact]
    public void a_first_meeting_is_vanilla() =>
        Assert.Equal(VanillaReason.FirstMeeting, VanillaFirst.Decide(Ordinary() with { HasMet = false }));

    [Fact]
    public void b_an_active_quest_for_this_npc_is_vanilla() =>
        Assert.Equal(VanillaReason.Quest, VanillaFirst.Decide(Ordinary() with { QuestForNpc = true }));

    [Fact]
    public void c_their_birthday_is_vanilla() =>
        Assert.Equal(VanillaReason.Birthday, VanillaFirst.Decide(Ordinary() with { IsBirthday = true }));

    [Theory]
    // Story keys on the NPC's own sheet: event follow-ups, relationship states, town milestones.
    [InlineData(@"Characters\Dialogue\Shane:eventSeen_3910975")]
    [InlineData(@"Characters\Dialogue\Abigail:eventSeen_2_memory_oneday")]
    [InlineData(@"Characters\Dialogue\Abigail:dating_Abigail")]
    [InlineData(@"Characters\Dialogue\Lewis:cc_Complete")]
    [InlineData(@"Characters\Dialogue\Shane:event_room1")]
    // Another NPC's sheet, or an asset that is not a daily sheet.
    [InlineData(@"Characters\Dialogue\Marnie:Mon")]
    [InlineData(@"Data\ExtraDialogue:SomeQuest_Reply")]
    public void d_story_dialogue_is_vanilla(string key) =>
        Assert.Equal(VanillaReason.Story, VanillaFirst.Decide(Ordinary(new PendingDialogue(key, false))));

    [Fact]
    public void d_a_line_with_commands_is_vanilla_even_on_an_everyday_key() =>
        Assert.Equal(VanillaReason.Story, VanillaFirst.Decide(Ordinary(Everyday with { HasCommands = true })));

    [Fact]
    public void d_a_line_pushed_by_code_with_no_key_is_vanilla() =>
        Assert.Equal(VanillaReason.Story, VanillaFirst.Decide(Ordinary(new PendingDialogue(null, false))));

    [Theory]
    [InlineData(@"Characters\Dialogue\Shane:Mon")]
    [InlineData(@"Characters\Dialogue\Shane:Tue10")]
    [InlineData(@"Characters\Dialogue\Shane:fall_Wed2")]
    [InlineData(@"Characters\Dialogue\Shane:winter_Sun")]
    [InlineData(@"Characters\Dialogue\Shane:spring_12")]
    [InlineData(@"Characters\Dialogue\Shane:Town_57_40")]
    [InlineData(@"Characters\Dialogue\Shane:summer_Town_57_40")]
    [InlineData(@"Characters\Dialogue\rainy:Shane")]
    [InlineData(@"Characters\Dialogue\MarriageDialogueShane:Rainy_Day_0")]
    [InlineData(@"Strings\StringsFromCSFiles:NPC.cs.4080")]
    public void everyday_lines_go_to_the_brain(string key) =>
        Assert.Equal(VanillaReason.None, VanillaFirst.Decide(Ordinary(new PendingDialogue(key, false))));

    [Fact]
    public void first_meeting_wins_over_the_other_reasons() =>
        Assert.Equal(VanillaReason.FirstMeeting, VanillaFirst.Decide(new TalkGate("Shane", false, true, true, new PendingDialogue(null, true))));

    [Theory]
    [InlineData(VanillaReason.FirstMeeting, "first-meeting")]
    [InlineData(VanillaReason.Quest, "quest")]
    [InlineData(VanillaReason.Birthday, "birthday")]
    [InlineData(VanillaReason.Story, "story")]
    public void wire_names_match_the_day_end_schema(VanillaReason r, string wire) =>
        Assert.Equal(wire, VanillaFirst.WireName(r));
}
