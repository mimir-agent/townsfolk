using System;
using System.Collections.Generic;
using System.Linq;

namespace Townsfolk;

/// <summary>
/// Moves a planned stop onto a tile an NPC can stand on. The brain only knows each location's
/// size, not its walls and furniture, so its tiles are often a step or two off the floor.
/// Pure: the game check is passed in, so this is tested without the game.
/// </summary>
public static class TileSnap
{
    /// <summary>How far a stop may move, in tiles along either axis.</summary>
    public const int Radius = 4;

    /// <summary>
    /// The nearest tile to (x, y), within <see cref="Radius"/>, that <paramref name="standable"/>
    /// accepts; null when there is none. Nearest is by straight-line distance, ties broken by
    /// row then column, so the same plan always lands on the same tile.
    /// </summary>
    public static (int X, int Y)? Nearest(int x, int y, Func<int, int, bool> standable)
    {
        foreach ((int X, int Y) t in Candidates(x, y))
        {
            if (standable(t.X, t.Y))
                return t;
        }
        return null;
    }

    /// <summary>Every tile within <see cref="Radius"/> of (x, y), nearest first. (x, y) itself is first.</summary>
    public static IEnumerable<(int X, int Y)> Candidates(int x, int y)
    {
        var offsets = new List<(int Dx, int Dy)>();
        for (int dy = -Radius; dy <= Radius; dy++)
        {
            for (int dx = -Radius; dx <= Radius; dx++)
                offsets.Add((dx, dy));
        }
        return offsets
            .OrderBy(d => d.Dx * d.Dx + d.Dy * d.Dy)
            .ThenBy(d => d.Dy)
            .ThenBy(d => d.Dx)
            .Select(d => (x + d.Dx, y + d.Dy));
    }
}
