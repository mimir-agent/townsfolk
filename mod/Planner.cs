using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;
using StardewValley.Locations;
using StardewValley.Pathfinding;

namespace Townsfolk;

/// <summary>
/// The overnight plan, game side. At save load it sends the world snapshot; after day-end it
/// asks for tomorrow's plan without waiting; once the new day has started and the plan is in, it
/// applies it: schedules through Characters/schedules/&lt;Name&gt;, one mailed quest through
/// Data/Quests and Data/mail, friendship shifts toward the player.
/// Threading rule: HTTP runs on the thread pool and only produces a Task. The Task is read from
/// UpdateTicked, so every game object is touched on the game thread.
/// Any failure (brain down, slow, wrong day, bad answer) leaves the day vanilla.
/// </summary>
public sealed class Planner
{
    // Wait this long after DayStarted before applying. LittleNPCs found that schedule changes
    // made in the DayStarted handler itself do not always stick; one second is our assumption of
    // "a short delay", not a number taken from their code.
    private const int ApplyDelayTicks = 60;
    // A plan that arrives after this game time is not applied: the day is half over and runs vanilla.
    private const int LatestApplyTime = 1200;
    // Mirrors protocol/plan-response.schema.json (friendship delta -40..40).
    private const int MaxFriendshipShift = 40;
    // protocol/world-request.schema.json caps.
    private const int MaxLocations = 200;
    private const int MaxItems = 300;
    private const int MaxFestivals = 40;
    private const int MaxMarried = 40;

    // Same rule as the location pattern in protocol/world-request.schema.json.
    private static readonly Regex LocationName = new("^[A-Za-z0-9_.-]{1,80}$", RegexOptions.CultureInvariant);

    // Object categories a mailed quest may ask for: crops, fruit, fish, cooking, forage, flowers,
    // gems, eggs, milk, artisan goods. Things a villager could plausibly want delivered.
    private static readonly HashSet<int> QuestCategories = new() { -75, -79, -4, -7, -81, -80, -2, -5, -6, -26 };

    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private readonly BrainClient brain;
    // PathFindController.isPositionImpassableForNPCSchedule(location, x, y, npc): the per-step
    // test of the pathfinder that walks villagers along their schedules.
    private readonly IReflectedMethod impassableForSchedule;

    // The plan request in flight and the day it is for. Set at DayEnding, cleared once applied or dropped.
    private Task<PlanResponse?>? planPost;
    private DayRef? planFor;
    // Tick of the latest DayStarted; null between DayEnding and DayStarted.
    private int? dayStartedTick;

    // Schedules served today: NPC name to (schedule key, schedule string). Read by the asset edit.
    private Dictionary<string, (string Key, string Script)> schedules = new();
    // Every quest this mod has mailed on this save, so its Data/Quests and Data/mail entries still
    // exist after a reload. Kept in data/<save folder>.json in the mod folder.
    private QuestArchive archive = new();

    public Planner(IModHelper helper, IMonitor monitor, BrainClient brain)
    {
        this.helper = helper;
        this.monitor = monitor;
        this.brain = brain;
        // Protected in the game, so read through SMAPI. Throws at load if a game update renames it.
        this.impassableForSchedule = helper.Reflection.GetMethod(typeof(PathFindController), "isPositionImpassableForNPCSchedule");
        helper.Events.Content.AssetRequested += this.OnAssetRequested;
        helper.Events.GameLoop.DayStarted += this.OnDayStarted;
    }

    private string ArchivePath => $"data/{Constants.SaveFolderName}.json";

    public void Reset()
    {
        this.planPost = null;
        this.planFor = null;
        this.dayStartedTick = null;
        this.Unserve();
        this.archive = new QuestArchive();
    }

    /// <summary>Save loaded: load this save's mailed quests and send the world snapshot.</summary>
    public void OnSaveLoaded()
    {
        this.Reset();
        this.archive = this.helper.Data.ReadJsonFile<QuestArchive>(this.ArchivePath) ?? new QuestArchive();
        // Always: the cached assets may still hold the quests of the save loaded before this one.
        this.helper.GameContent.InvalidateCache("Data/Quests");
        this.helper.GameContent.InvalidateCache("Data/mail");
        WorldRequest world = ReadWorld();
        int locations = world.Locations.Count, items = world.Items.Count;
        // Fire and forget. If it fails, every plan request answers 409 and every day runs vanilla.
        _ = this.brain.World(world).ContinueWith(t =>
        {
            if (t.Result)
                this.monitor.Log($"Sent the world to the brain: {locations} locations, {items} quest items.", LogLevel.Debug);
        });
    }

    /// <summary>
    /// Day ending: ask for tomorrow's plan once day-end has reached the brain (the planner reads
    /// the pending day). Never waited on here.
    /// </summary>
    public void OnDayEnding(Task<bool> dayEnd, PlanRequest req)
    {
        this.dayStartedTick = null;
        this.planFor = req.Day;
        this.planPost = dayEnd.ContinueWith(_ => this.brain.Plan(req), TaskScheduler.Default).Unwrap();
    }

    private void OnDayStarted(object? sender, DayStartedEventArgs e)
    {
        // Yesterday's schedule entries were keyed by yesterday's date, so they no longer match;
        // dropping them from the cache keeps one from matching the same date a year on.
        this.Unserve();
        this.dayStartedTick = Game1.ticks;
    }

    /// <summary>Called every tick. Applies the plan once it is in and the day has settled.</summary>
    public void OnUpdateTicked()
    {
        if (this.planPost is not { IsCompleted: true } done || this.planFor is not { } day)
            return;
        if (!Context.IsWorldReady || this.dayStartedTick is not { } started || Game1.ticks - started < ApplyDelayTicks)
            return;
        // A morning cutscene is running: NPCs in it are actors. Apply once it is over.
        if (Game1.eventUp)
            return;

        this.planPost = null;
        this.planFor = null;
        PlanResponse? plan = done.Status == TaskStatus.RanToCompletion ? done.Result : null;
        if (plan is null)
        {
            this.monitor.Log("No plan from the brain; today runs vanilla.", LogLevel.Debug);
            return;
        }
        if (!SameDay(plan.Day, day) || !SameDay(day, Today()))
        {
            this.monitor.Log($"Plan for {Label(plan.Day)} does not match today ({Label(Today())}); today runs vanilla.", LogLevel.Warn);
            return;
        }
        if (Game1.timeOfDay > LatestApplyTime)
        {
            this.monitor.Log($"Plan arrived at {Game1.timeOfDay}, after {LatestApplyTime}; today runs vanilla.", LogLevel.Debug);
            return;
        }
        if (plan.Source != "model")
        {
            this.monitor.Log($"Brain plan is {plan.Source}; today runs vanilla.", LogLevel.Debug);
            return;
        }
        this.Apply(plan);
    }

    private void Apply(PlanResponse plan)
    {
        int schedules = this.ApplySchedules(plan.Schedules);
        bool quest = plan.Quest is { } q && this.ApplyQuest(q);
        int friendship = this.ApplyFriendship(plan.Friendship);
        this.monitor.Log(
            $"Applied the plan for {Label(plan.Day)} at {Game1.timeOfDay}: {schedules} of {plan.Schedules.Count} schedules, " +
            $"quest={(quest ? "mailed" : "none")}, {friendship} friendship shifts; the brain dropped {plan.Dropped.Count} parts.",
            LogLevel.Info);
    }

    // The brain's validator is authoritative. The bridge re-checks only what needs the live game:
    // the NPC is here, each stop's location exists and is reachable from home, and each stop's tile
    // is on the map. A tile the NPC cannot stand on moves to the nearest one it can (TileSnap).
    // One failing stop drops that NPC's whole schedule, so they keep their vanilla day.
    private int ApplySchedules(List<PlannedSchedule> planned)
    {
        string key = $"{Game1.currentSeason}_{Game1.dayOfMonth}";
        var next = new Dictionary<string, (string Key, string Script)>();
        foreach (PlannedSchedule s in planned)
        {
            NPC? npc = Game1.getCharacterFromName(s.Npc);
            if (npc is null || !npc.IsVillager)
            {
                this.monitor.Log($"Dropped {s.Npc}'s schedule: not in the world.", LogLevel.Debug);
                continue;
            }
            if (npc.isMarried())
            {
                this.monitor.Log($"Dropped {s.Npc}'s schedule: married NPCs keep their own.", LogLevel.Debug);
                continue;
            }
            var stops = new List<PlanStop>();
            string? problem = null;
            foreach (PlanStop st in s.Stops)
            {
                if (this.ResolveStop(npc, st, out problem) is not { } placed)
                    break;
                if (placed.X != st.X || placed.Y != st.Y)
                    this.monitor.Log($"Moved {s.Npc}'s {st.Time} stop in {st.Location} from {st.X},{st.Y} to {placed.X},{placed.Y}, the nearest tile to stand on.", LogLevel.Debug);
                stops.Add(placed);
            }
            if (problem is not null)
            {
                this.monitor.Log($"Dropped {s.Npc}'s schedule: {problem}.", LogLevel.Debug);
                continue;
            }
            string script = string.Join("/", stops.Select(st => $"{st.Time} {st.Location} {st.X} {st.Y} {st.Facing}"));
            next[s.Npc] = (key, script);
        }

        HashSet<string> touched = new(this.schedules.Keys.Concat(next.Keys));
        this.schedules = next;
        // SMAPI reloads each invalidated NPC's schedule and, mid-day, moves them onto it.
        foreach (string name in touched)
            this.helper.GameContent.InvalidateCache($"Characters/schedules/{name}");
        return next.Count;
    }

    // The stop as it will be served: its tile moved to the nearest one the NPC can stand on
    // (TileSnap.Radius). Null, with the reason, when the stop cannot be served at all.
    private PlanStop? ResolveStop(NPC npc, PlanStop stop, out string? problem)
    {
        problem = null;
        if (!LocationName.IsMatch(stop.Location))
            problem = $"location name {stop.Location} is not allowed";
        else if (Game1.getLocationFromName(stop.Location) is not { } location)
            problem = $"no location {stop.Location}";
        else if (!location.isTileOnMap(new Vector2(stop.X, stop.Y)))
            problem = $"{stop.X},{stop.Y} is off the {stop.Location} map";
        // The game walks villagers between maps along its warp routes. With no route it logs an
        // error and the NPC stands still, so a stop the NPC cannot walk to from home is dropped.
        else if (npc.DefaultMap != stop.Location && WarpPathfindingCache.GetLocationRoute(npc.DefaultMap, stop.Location, npc.Gender) is null)
            problem = $"no walking route from {npc.DefaultMap} to {stop.Location}";
        else if (TileSnap.Nearest(stop.X, stop.Y, (x, y) => this.Standable(location, x, y, npc)) is not { } tile)
            problem = $"no tile to stand on within {TileSnap.Radius} of {stop.X},{stop.Y} in {stop.Location}";
        else
            return stop with { X = tile.X, Y = tile.Y };
        return null;
    }

    // Things that block a tile for good. Farmers and characters move, so they do not count; a
    // passable thing (grass, flooring, a rug) does not block either.
    private const CollisionMask Fixtures =
        CollisionMask.Buildings | CollisionMask.Flooring | CollisionMask.Furniture | CollisionMask.Objects | CollisionMask.TerrainFeatures | CollisionMask.LocationSpecific;

    // A tile an NPC can walk onto and stand on: the test the game's schedule pathfinder applies
    // to every step, plus the tile's own collision, no water, and nothing fixed standing there.
    private bool Standable(GameLocation location, int x, int y, NPC npc)
    {
        var tile = new Vector2(x, y);
        return location.isTileOnMap(tile)
            && location.isTilePassable(tile)
            && !this.impassableForSchedule.Invoke<bool>(location, x, y, npc)
            && !location.isWaterTile(x, y)
            && !location.IsTileOccupiedBy(tile, Fixtures, ignorePassables: Fixtures);
    }

    // One mailed item-delivery quest. Only new townsfolk_ ids are ever added to Data/Quests and
    // Data/mail; vanilla entries are never edited.
    private bool ApplyQuest(MailQuest q)
    {
        if (!q.Id.StartsWith("townsfolk_", StringComparison.Ordinal) || !LocationName.IsMatch(q.Id))
        {
            this.monitor.Log($"Dropped quest {q.Id}: id must be townsfolk_ plus digits.", LogLevel.Warn);
            return false;
        }
        Farmer p = Game1.player;
        // The archive may already hold this id from a day replayed without saving; the letter
        // never reached the save then, so it is sent again with tonight's text.
        if (p.hasQuest(q.Id) || p.mailbox.Contains(q.Id) || p.mailReceived.Contains(q.Id))
        {
            this.monitor.Log($"Dropped quest {q.Id}: already sent.", LogLevel.Debug);
            return false;
        }
        // A stranger does not write to the player: first meetings stay vanilla.
        if (!p.friendshipData.ContainsKey(q.From))
        {
            this.monitor.Log($"Dropped quest {q.Id}: the player has not met {q.From}.", LogLevel.Debug);
            return false;
        }
        if (ItemRegistry.GetData(q.Item) is not { } item)
        {
            this.monitor.Log($"Dropped quest {q.Id}: no item {q.Item} in this game.", LogLevel.Warn);
            return false;
        }

        string itemName = Field(item.DisplayName);
        string from = q.From;
        // Data/Quests: Type/Title/Description/Objective/Target ItemId/NextQuest/Reward/RewardDescription/Cancellable/Reaction
        string quest = string.Join("/",
            "ItemDelivery",
            $"A favor for {from}",
            $"{from} wrote asking for {itemName}.",
            $"Bring {from} {itemName}.",
            $"{from} {q.Item}",
            "-1",
            q.Reward.ToString(),
            "-1",
            "true",
            "Oh, you remembered! Thank you, this is exactly what I needed.");
        // Data/mail: the letter, the sender, then the quest attached and added when the letter is read.
        string mail = $"{q.Text}^^   -{from}%item quest {q.Id} true %%[#]A letter from {from}";

        this.archive.Quests[q.Id] = new ArchivedQuest(quest, mail);
        this.helper.Data.WriteJsonFile(this.ArchivePath, this.archive);
        this.helper.GameContent.InvalidateCache("Data/Quests");
        this.helper.GameContent.InvalidateCache("Data/mail");
        Game1.addMail(q.Id);
        return true;
    }

    // Field separators in quest data. The brain already strips the dialogue command characters.
    private static string Field(string s) => s.Replace("/", " ").Replace("^", " ").Trim();

    private int ApplyFriendship(List<FriendshipShift> shifts)
    {
        int applied = 0;
        foreach (FriendshipShift f in shifts)
        {
            // First meetings stay vanilla: no friendship with someone the player has not met.
            if (!Game1.player.friendshipData.ContainsKey(f.Npc) || Game1.getCharacterFromName(f.Npc) is not { } npc)
            {
                this.monitor.Log($"Skipped friendship for {f.Npc}: not met yet.", LogLevel.Debug);
                continue;
            }
            int delta = Math.Clamp(f.Delta, -MaxFriendshipShift, MaxFriendshipShift);
            Game1.player.changeFriendship(delta, npc);
            this.monitor.Log($"Plan friendship {f.Npc} {delta:+#;-#;0}: {f.Reason}", LogLevel.Trace);
            applied++;
        }
        return applied;
    }

    private void Unserve()
    {
        List<string> names = this.schedules.Keys.ToList();
        this.schedules = new();
        foreach (string name in names)
            this.helper.GameContent.InvalidateCache($"Characters/schedules/{name}");
    }

    private void OnAssetRequested(object? sender, AssetRequestedEventArgs e)
    {
        if (e.NameWithoutLocale.IsDirectlyUnderPath("Characters/schedules"))
        {
            string name = e.NameWithoutLocale.BaseName.Split('/').Last();
            if (!this.schedules.TryGetValue(name, out var planned))
                return;
            e.Edit(asset =>
            {
                IDictionary<string, string> data = asset.AsDictionary<string, string>().Data;
                // A vanilla schedule for this exact date carries story (a visit, an appointment): it wins.
                if (data.ContainsKey(planned.Key))
                {
                    this.monitor.Log($"{name} has a vanilla schedule for {planned.Key}; kept it.", LogLevel.Debug);
                    return;
                }
                data[planned.Key] = planned.Script;
            });
            return;
        }
        if (this.archive.Quests.Count == 0)
            return;
        if (e.NameWithoutLocale.IsEquivalentTo("Data/Quests"))
        {
            e.Edit(asset =>
            {
                IDictionary<string, string> data = asset.AsDictionary<string, string>().Data;
                foreach ((string id, ArchivedQuest q) in this.archive.Quests)
                    data.TryAdd(id, q.Quest);
            });
        }
        else if (e.NameWithoutLocale.IsEquivalentTo("Data/mail"))
        {
            e.Edit(asset =>
            {
                IDictionary<string, string> data = asset.AsDictionary<string, string>().Data;
                foreach ((string id, ArchivedQuest q) in this.archive.Quests)
                    data.TryAdd(id, q.Mail);
            });
        }
    }

    /// <summary>The world snapshot. Read on the game thread at save load.</summary>
    private static WorldRequest ReadWorld()
    {
        var locations = new List<WorldLocation>();
        foreach (GameLocation l in Game1.locations)
        {
            // The player's own farm and buildings are not somewhere villagers go about their day.
            if (l.IsFarm || l.IsGreenhouse || l is FarmHouse || l.Map is null || !LocationName.IsMatch(l.Name))
                continue;
            int width = l.Map.Layers[0].LayerWidth, height = l.Map.Layers[0].LayerHeight;
            if (width < 1 || height < 1 || width > 1000 || height > 1000)
                continue;
            locations.Add(new WorldLocation(l.Name, width, height));
            if (locations.Count >= MaxLocations)
                break;
        }

        List<WorldItem> items = Game1.objectData
            .Where(kv => QuestCategories.Contains(kv.Value.Category) && kv.Value.Price > 0)
            .OrderBy(kv => kv.Value.Price)
            .ThenBy(kv => kv.Key, StringComparer.Ordinal)
            .Select(kv => (Id: "(O)" + kv.Key, Data: ItemRegistry.GetData("(O)" + kv.Key)))
            .Where(x => x.Data is not null && x.Id.Length <= 60 && !string.IsNullOrWhiteSpace(x.Data.DisplayName) && x.Data.DisplayName.Length <= 80)
            .Select(x => new WorldItem(x.Id, x.Data!.DisplayName))
            .Take(MaxItems)
            .ToList();

        var festivals = new List<WorldFestival>();
        var dates = Game1.content.Load<Dictionary<string, string>>("Data/Festivals/FestivalDates");
        foreach ((string key, string name) in dates)
        {
            Match m = Regex.Match(key, "^(spring|summer|fall|winter)([0-9]{1,2})$");
            if (!m.Success || !int.TryParse(m.Groups[2].Value, out int d) || d < 1 || d > 28 || string.IsNullOrWhiteSpace(name))
                continue;
            festivals.Add(new WorldFestival(m.Groups[1].Value, d, name.Length <= 60 ? name : name[..60]));
            if (festivals.Count >= MaxFestivals)
                break;
        }

        List<string> married = Game1.getAllFarmers()
            .Select(f => f.spouse)
            .Where(s => !string.IsNullOrEmpty(s) && ModEntry.ProtocolName.IsMatch(s))
            .Select(s => s!)
            .Distinct()
            .Take(MaxMarried)
            .ToList();

        return new WorldRequest(Constants.SaveFolderName ?? "unknown", locations, items, festivals, married);
    }

    /// <summary>The day about to start, for the plan request sent at DayEnding.</summary>
    public static DayRef Tomorrow()
    {
        SDate t = SDate.Now().AddDays(1);
        return new DayRef(t.SeasonKey, t.Day, t.Year);
    }

    private static DayRef Today() => new(Game1.currentSeason, Game1.dayOfMonth, Game1.year);

    private static bool SameDay(DayRef a, DayRef b) => a.Season == b.Season && a.Day == b.Day && a.Year == b.Year;

    private static string Label(DayRef d) => $"{d.Season} {d.Day}, year {d.Year}";
}

/// <summary>data/&lt;save folder&gt;.json in the mod folder.</summary>
public sealed class QuestArchive
{
    public Dictionary<string, ArchivedQuest> Quests { get; set; } = new();
}

/// <summary>The Data/Quests and Data/mail values this mod added for one townsfolk_ id.</summary>
public sealed record ArchivedQuest(string Quest, string Mail);
