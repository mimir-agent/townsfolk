using System.Collections.Generic;
using System.Linq;
using Townsfolk;
using Xunit;

namespace Townsfolk.Tests;

public class VoicedTests
{
    private static readonly string[] OldFiveNames = { "Abigail", "Pierre", "Lewis", "Emily", "Shane" };

    public static IEnumerable<object[]> Denied() =>
        Voiced.HardDeny.Concat(Voiced.SoftDeny).Select(n => new object[] { n });

    [Fact]
    public void Roster_is_26_and_shares_no_name_with_either_deny_list()
    {
        Assert.Equal(26, Voiced.Roster.Count);
        Assert.DoesNotContain(Voiced.Roster, Voiced.IsDenied);
    }

    [Theory]
    [MemberData(nameof(Denied))]
    public void A_denied_name_never_reaches_the_brain_whatever_the_config(string name)
    {
        string[] everyone = { name };
        foreach (string? mode in new[] { null, "roster", "list", "LIST", "nonsense" })
        {
            Assert.False(Voiced.Allows(name, mode, allNpcs: true, everyone), $"{mode} AllNpcs");
            Assert.False(Voiced.Allows(name, mode, allNpcs: false, everyone), $"{mode} EnabledNpcs");
        }
    }

    [Fact]
    public void Roster_mode_with_the_old_five_name_list_voices_all_26()
    {
        // A config.json with no Voiced key gets ModConfig's initializer, Voiced.RosterMode.
        foreach (string name in Voiced.Roster)
            Assert.True(Voiced.Allows(name, Voiced.RosterMode, false, OldFiveNames), name);
    }

    [Fact]
    public void Voiced_null_is_treated_like_a_missing_key()
    {
        Assert.True(Voiced.Allows("Clint", null, false, OldFiveNames));
    }

    [Fact]
    public void List_mode_voices_only_EnabledNpcs()
    {
        Assert.True(Voiced.Allows("Abigail", "list", false, OldFiveNames));
        Assert.False(Voiced.Allows("Clint", "list", false, OldFiveNames));
    }

    [Fact]
    public void Mode_is_compared_ignoring_case()
    {
        Assert.True(Voiced.Allows("Clint", "Roster", false, OldFiveNames));
        Assert.True(Voiced.Allows("Abigail", "List", false, OldFiveNames));
    }

    [Fact]
    public void An_unknown_mode_voices_nobody()
    {
        Assert.False(Voiced.Allows("Abigail", "everyone", false, OldFiveNames));
    }

    [Fact]
    public void AllNpcs_voices_a_villager_off_the_roster_that_is_not_denied()
    {
        // The caller (ModEntry.IsEnabled) has already checked IsVillager and CanSocialize.
        Assert.True(Voiced.Allows("SomeModdedVillager", "roster", allNpcs: true, OldFiveNames));
        Assert.False(Voiced.Allows("SomeModdedVillager", "roster", allNpcs: false, OldFiveNames));
    }

    [Fact]
    public void Roster_mode_constant_is_the_documented_value() =>
        Assert.Equal("roster", Voiced.RosterMode);
}
