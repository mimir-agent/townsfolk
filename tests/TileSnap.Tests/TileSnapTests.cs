using System.Collections.Generic;
using System.Linq;
using Townsfolk;
using Xunit;

public class TileSnapTests
{
    // A 10x10 room: a wall on the outer ring, a counter across row 4 from x 2 to 7.
    private static bool Room(int x, int y) =>
        x > 0 && y > 0 && x < 9 && y < 9 && !(y == 4 && x >= 2 && x <= 7);

    [Fact]
    public void A_standable_tile_is_kept()
    {
        Assert.Equal((5, 6), TileSnap.Nearest(5, 6, Room));
    }

    [Fact]
    public void A_tile_on_the_counter_moves_one_step_to_the_floor()
    {
        // Up and down are both one step; the tie goes to the row above.
        Assert.Equal((5, 3), TileSnap.Nearest(5, 4, Room));
    }

    [Fact]
    public void A_tile_in_the_wall_moves_inside()
    {
        Assert.Equal((1, 5), TileSnap.Nearest(0, 5, Room));
    }

    [Fact]
    public void Nothing_standable_within_the_radius_is_null()
    {
        Assert.Null(TileSnap.Nearest(5, 5, (_, _) => false));
        // The only floor is one step past the radius.
        int far = TileSnap.Radius + 1;
        Assert.Null(TileSnap.Nearest(0, 0, (x, y) => x == far && y == 0));
        Assert.Equal((TileSnap.Radius, 0), TileSnap.Nearest(0, 0, (x, y) => x == TileSnap.Radius && y == 0));
    }

    [Fact]
    public void Candidates_cover_the_square_once_nearest_first()
    {
        List<(int X, int Y)> c = TileSnap.Candidates(10, 10).ToList();
        int side = 2 * TileSnap.Radius + 1;
        Assert.Equal(side * side, c.Count);
        Assert.Equal(c.Count, c.Distinct().Count());
        Assert.Equal((10, 10), c[0]);
        int[] dist = c.Select(t => (t.X - 10) * (t.X - 10) + (t.Y - 10) * (t.Y - 10)).ToArray();
        Assert.True(dist.Zip(dist.Skip(1)).All(p => p.First <= p.Second));
    }

    [Fact]
    public void Tiles_off_the_map_are_offered_and_left_to_the_check()
    {
        // Negative tiles are candidates; the game check must refuse them. Standable() does, via isTileOnMap.
        Assert.Contains((-1, 0), TileSnap.Candidates(0, 0));
        Assert.Equal((0, 0), TileSnap.Nearest(0, 0, (x, y) => x >= 0 && y >= 0));
    }
}
