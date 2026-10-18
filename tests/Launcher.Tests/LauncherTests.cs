using System.Collections.Generic;
using System.Linq;
using Townsfolk;
using Xunit;

public class LauncherTests
{
    private static readonly IReadOnlyList<string> MacExtra = NodeLocator.ExtraDirs(false, "/Users/x", null, null);
    private static readonly IReadOnlyList<string> WinExtra = NodeLocator.ExtraDirs(true, @"C:\Users\x", @"C:\Program Files", @"C:\Users\x\AppData\Roaming");

    [Fact]
    public void Node_on_PATH_wins_over_the_usual_folders()
    {
        var files = new HashSet<string> { "/a/node", "/opt/homebrew/bin/node" };
        Assert.Equal("/a/node", NodeLocator.Find(null, "/b:/a", false, MacExtra, files.Contains));
    }

    [Fact]
    public void A_game_started_without_a_terminal_PATH_still_finds_a_homebrew_node()
    {
        var files = new HashSet<string> { "/opt/homebrew/bin/node" };
        Assert.Equal("/opt/homebrew/bin/node", NodeLocator.Find(null, "/usr/bin:/bin", false, MacExtra, files.Contains));
    }

    [Fact]
    public void On_Windows_the_Program_Files_node_is_found_as_node_exe()
    {
        // Path.Combine joins with this machine's separator, so the comparison ignores which one.
        static string Norm(string? p) => (p ?? "").Replace('\\', '/');
        var files = new HashSet<string> { "C:/Program Files/nodejs/node.exe" };
        Assert.Equal("C:/Program Files/nodejs/node.exe", Norm(NodeLocator.Find(null, @"C:\Windows", true, WinExtra, f => files.Contains(Norm(f)))));
    }

    [Fact]
    public void No_node_anywhere_is_null_not_a_guess()
    {
        Assert.Null(NodeLocator.Find(null, "/usr/bin", false, MacExtra, _ => false));
    }

    [Fact]
    public void A_configured_path_is_used_or_reported_never_replaced()
    {
        var files = new HashSet<string> { "/usr/local/bin/node", "/mine/node" };
        Assert.Equal("/mine/node", NodeLocator.Find("/mine/node", "/usr/local/bin", false, MacExtra, files.Contains));
        Assert.Null(NodeLocator.Find("/typo/node", "/usr/local/bin", false, MacExtra, files.Contains));
    }

    [Fact]
    public void The_brain_PATH_keeps_the_games_then_adds_node_and_the_usual_folders_once()
    {
        string path = NodeLocator.AugmentedPath("/usr/bin:/bin", false, "/opt/homebrew/bin", MacExtra);
        string[] parts = path.Split(':');
        Assert.Equal(new[] { "/usr/bin", "/bin", "/opt/homebrew/bin" }, parts.Take(3));
        Assert.Equal(parts.Length, parts.Distinct().Count());
        Assert.Contains("/Users/x/.local/bin", parts);
    }

    [Fact]
    public void Waiting_dots_cycle_one_two_three_and_repeat()
    {
        Assert.Equal(new[] { 1, 2, 3, 1, 2 }, new long[] { 0, 350, 700, 1050, 1400 }.Select(TalkWait.DotsAt));
        Assert.All(Enumerable.Range(0, 5000).Select(i => TalkWait.DotsAt(i * 37)), n => Assert.InRange(n, 1, 3));
    }
}
