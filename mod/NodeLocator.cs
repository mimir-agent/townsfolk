using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Townsfolk;

/// <summary>
/// Where the mod looks for Node.js when it starts the brain itself. A game started from Steam or
/// the Finder does not get the PATH of a terminal, so the usual install folders are tried after
/// PATH. No game types here, so tests/Launcher.Tests can run it.
/// </summary>
public static class NodeLocator
{
    /// <summary>Folders where Node and the Claude Code CLI normally live, besides PATH.</summary>
    public static IReadOnlyList<string> ExtraDirs(bool windows, string home, string? programFiles, string? appData)
    {
        if (windows)
        {
            var dirs = new List<string>();
            if (!string.IsNullOrEmpty(programFiles))
                dirs.Add(Path.Combine(programFiles, "nodejs"));
            if (!string.IsNullOrEmpty(appData))
                dirs.Add(Path.Combine(appData, "npm"));
            dirs.Add(Path.Combine(home, ".local", "bin"));
            return dirs;
        }
        return new[]
        {
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            Path.Combine(home, ".volta", "bin"),
            Path.Combine(home, ".local", "bin"),
            Path.Combine(home, ".claude", "local"),
            Path.Combine(home, ".npm-global", "bin"),
        };
    }

    /// <summary>
    /// The node program to run, or null when there is none. A configured path is used as it is or
    /// not at all (a wrong setting should be reported, not quietly replaced). Otherwise PATH is
    /// searched first, then the extra folders.
    /// </summary>
    public static string? Find(string? configured, string? pathVar, bool windows, IReadOnlyList<string> extraDirs, Func<string, bool> fileExists)
    {
        if (!string.IsNullOrWhiteSpace(configured))
            return fileExists(configured) ? configured : null;
        string name = windows ? "node.exe" : "node";
        char sep = windows ? ';' : ':';
        IEnumerable<string> onPath = (pathVar ?? "").Split(sep, StringSplitOptions.RemoveEmptyEntries).Select(d => d.Trim('"'));
        foreach (string dir in onPath.Concat(extraDirs))
        {
            string file = Path.Combine(dir, name);
            if (fileExists(file))
                return file;
        }
        return null;
    }

    /// <summary>
    /// The PATH the brain runs with: the game's own, then the folder node is in, then the extra
    /// folders, so the brain finds the "claude" command even when the game was not started from a
    /// terminal. Each folder appears once.
    /// </summary>
    public static string AugmentedPath(string? pathVar, bool windows, string nodeDir, IReadOnlyList<string> extraDirs)
    {
        char sep = windows ? ';' : ':';
        var seen = new HashSet<string>(windows ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal);
        var parts = new List<string>();
        foreach (string dir in (pathVar ?? "").Split(sep, StringSplitOptions.RemoveEmptyEntries).Append(nodeDir).Concat(extraDirs))
        {
            if (dir.Length > 0 && seen.Add(dir))
                parts.Add(dir);
        }
        return string.Join(sep, parts);
    }
}
