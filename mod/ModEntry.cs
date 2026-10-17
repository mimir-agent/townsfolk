using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace Townsfolk;

/// <summary>
/// The bridge. Reads game state, shows dialogue, records what each NPC witnessed.
/// All decisions about what is said live in the brain (brain/).
/// Threading rule: game state is only touched on the game thread (event handlers and UpdateTicked);
/// HTTP runs on the thread pool and its Task is polled from UpdateTicked.
/// </summary>
public sealed class ModEntry : Mod
{
    // protocol/day-end-request.schema.json caps witnesses per event at 40, and together at 200
    // groups of at most 40.
    private const int MaxWitnesses = 40;
    private const int MaxTogether = 200;
    // protocol/talk-response.schema.json caps one choice's delta at +-15. Re-checked here so a
    // misbehaving brain can never move friendship more than that in one pick.
    private const int MaxChoiceDelta = 15;
    // Conversations can be restarted all day, so talk-driven friendship per NPC per day is capped
    // too. Same number as the planner's daily friendship cap.
    private const int MaxTalkDeltaPerDay = 40;

    private ModConfig config = new();
    private BrainClient brain = null!;
    private Planner? planner;
    private readonly List<DayEvent> todaysEvents = new();
    // Groups of villagers seen on the same map today, keyed by location and sorted names so a
    // group that stands still all afternoon is sent once.
    private readonly Dictionary<string, Together> todaysTogether = new();
    private Conversation? convo;
    private PendingGift? pendingGift;
    // Friendship points talk has moved today, per NPC, so the daily cap holds across conversations.
    private readonly Dictionary<string, int> talkDeltaToday = new();
    // The player joined a happening today; the brain offers no second join.
    private bool joinedToday;

    // The day handed to the brain at DayEnding, and that request's Task. Saved fires after the
    // date has already moved on, so it reports this remembered date, and it is sent only once the
    // day-end request has finished so the brain always sees day-end before saved.
    private DayRef? endedDay;
    private Task<bool>? endedDayPost;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.brain = new BrainClient(this.config.BrainUrl, this.config.TimeoutSeconds, this.config.PlanTimeoutSeconds, msg => this.Monitor.Log(msg, LogLevel.Warn));
        // With planning off the planner is never built: no world, no plan requests, no asset edits.
        this.planner = this.config.Planning ? new Planner(helper, this.Monitor, this.brain) : null;
        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.TimeChanged += (_, _) => this.SampleTogether();
        helper.Events.GameLoop.DayEnding += this.OnDayEnding;
        helper.Events.GameLoop.Saved += this.OnSaved;
        helper.Events.GameLoop.ReturnedToTitle += (_, _) =>
        {
            this.Reset();
            this.planner?.Reset();
        };
        helper.Events.GameLoop.SaveLoaded += (_, _) =>
        {
            this.Reset();
            this.planner?.OnSaveLoaded();
        };
        this.Monitor.Log($"Townsfolk: brain at {this.config.BrainUrl}, NPCs: {(this.config.AllNpcs ? "all" : string.Join(", ", this.config.EnabledNpcs))}, planning {(this.config.Planning ? "on" : "off")}", LogLevel.Info);
    }

    private void Reset()
    {
        this.todaysEvents.Clear();
        this.todaysTogether.Clear();
        this.talkDeltaToday.Clear();
        this.joinedToday = false;
        this.convo = null;
        this.pendingGift = null;
        this.endedDay = null;
        this.endedDayPost = null;
    }

    private bool IsEnabled(NPC npc) =>
        npc.IsVillager && npc.CanSocialize && (this.config.AllNpcs || this.config.EnabledNpcs.Contains(npc.Name));

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        if (!Context.IsWorldReady || !Context.IsPlayerFree || !e.Button.IsActionButton() || Game1.isFestival())
            return;

        NPC? npc = FindNpcNear(e.Cursor.GrabTile);
        if (npc is null || !this.IsEnabled(npc))
            return;

        // Holding an object means the player is giving a gift: let vanilla handle it and watch the result.
        if (Game1.player.ActiveObject is { } held)
        {
            Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? f);
            this.pendingGift = new PendingGift(npc, held, f?.GiftsToday ?? 0);
            return;
        }

        this.Helper.Input.Suppress(e.Button);

        // A reply is on its way: swallow the extra click so vanilla dialogue does not race it.
        if (this.convo?.Pending is not null)
            return;

        // A conversation that is neither waiting nor showing a menu was abandoned (question box
        // closed without a pick). It is finished; start a new one.
        npc.faceTowardFarmerForPeriod(6000, 4, false, Game1.player);
        npc.doEmote(Character.pauseEmote);
        this.convo = new Conversation(npc);
        this.convo.Pending = this.brain.Talk(this.BuildTalk(npc, this.convo, null));
    }

    private static NPC? FindNpcNear(Vector2 grabTile)
    {
        // Sprites are two tiles tall, so the game also checks the tile below the cursor.
        foreach (Vector2 tile in new[] { grabTile, grabTile + new Vector2(0, 1) })
        {
            NPC? npc = Game1.currentLocation.isCharacterAtTile(tile);
            if (npc is not null && Utility.tileWithinRadiusOfPlayer((int)tile.X, (int)tile.Y, 1, Game1.player))
                return npc;
        }
        return null;
    }

    private void OnUpdateTicked(object? sender, UpdateTickedEventArgs e)
    {
        this.CheckGift();
        this.planner?.OnUpdateTicked();

        if (this.convo?.Pending is not { IsCompleted: true } done)
            return;

        Conversation c = this.convo;

        // The player left the map or a cutscene started while we waited: drop the reply quietly.
        if (!Context.IsWorldReady || Game1.eventUp || Game1.currentLocation != c.Location)
        {
            this.convo = null;
            return;
        }

        // A menu is still open (the closing question box, or the inventory): show the reply once it closes.
        if (Game1.activeClickableMenu is not null)
            return;

        c.Pending = null;
        TalkResponse? reply = done.Status == TaskStatus.RanToCompletion ? done.Result : null;

        // Brain down, slow, or out of good answers on the opening turn: the NPC says their normal line.
        if (c.Turns == 0 && (reply is null || reply.Source == "fallback"))
        {
            this.convo = null;
            this.Monitor.Log($"Brain gave no usable reply; vanilla dialogue for {c.Npc.Name}.", LogLevel.Debug);
            c.Npc.checkAction(Game1.player, Game1.currentLocation);
            return;
        }

        // Mid-conversation failure with no reply at all: end politely so the player is never stuck.
        reply ??= new TalkResponse(BrainClient.ProtocolVersion, "Anyway, I should get going. See you around.", new List<TalkChoice>(), true, "fallback");

        if (c.Turns == 0)
            c.Npc.grantConversationFriendship(Game1.player);
        c.Turns++;
        c.Transcript.Add(new TranscriptLine("npc", reply.Line));

        if (reply.End || reply.Choices.Count == 0)
        {
            // Canned fallback lines are not something the NPC really said; keep them out of memory.
            if (reply.Source != "fallback")
                this.Record(c.Npc, reply.Line, null);
            Game1.DrawDialogue(new Dialogue(c.Npc, null, reply.Line));
            this.convo = null;
            return;
        }

        Response[] responses = reply.Choices.Select(ch => new Response(ch.Id, ch.Text)).ToArray();
        Game1.currentLocation.createQuestionDialogue(
            $"{c.Npc.displayName}: {reply.Line}",
            responses,
            (who, answer) => this.OnChoice(c, reply, answer),
            c.Npc);
    }

    private void OnChoice(Conversation c, TalkResponse reply, string answer)
    {
        TalkChoice? picked = reply.Choices.FirstOrDefault(ch => ch.Id == answer);
        if (picked is null)
        {
            this.convo = null;
            return;
        }
        this.Record(c.Npc, reply.Line, picked.Text, picked.Fact);
        if (picked.Join == true && reply.Happening is { } h)
            this.Join(c.Npc, h, picked.Delta);
        else
            this.AddTalkFriendship(c.Npc, picked.Delta);
        var said = new Choice(picked.Id, picked.Text);
        TalkRequest req = this.BuildTalk(c.Npc, c, said);
        c.Transcript.Add(new TranscriptLine("player", picked.Text));
        c.Npc.doEmote(Character.pauseEmote);
        c.Pending = this.brain.Talk(req);
    }

    // The game applies the gift a tick or so after the click; watch for up to one second.
    private void CheckGift()
    {
        if (this.pendingGift is not { } g)
            return;
        bool given = Game1.player.friendshipData.TryGetValue(g.Npc.Name, out Friendship? f) && f.GiftsToday > g.GiftsBefore;
        if (!given)
        {
            if (++g.TicksWaited > 60)
                this.pendingGift = null;
            return;
        }
        this.pendingGift = null;
        this.todaysEvents.Add(new DayEvent(
            "gift", g.Npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, Witnesses(g.Npc),
            Item: g.Item.DisplayName, Taste: TasteName(g.Npc.getGiftTasteForThisItem(g.Item))));
    }

    // Same rule as "name" in protocol/common.schema.json. A villager added by another mod with a
    // name outside it is left out as a witness, so one odd name cannot get the whole day refused.
    internal static readonly Regex ProtocolName = new(@"^[\p{L}\p{N}][\p{L}\p{N} ._'-]{0,59}$", RegexOptions.CultureInvariant);

    // Everyone else who could have seen it: the other villagers on the same map right now.
    // Same location is the whole rule this slice; line of sight and distance are not modelled.
    private static List<string> Witnesses(NPC subject) =>
        Game1.currentLocation.characters
            .Where(other => other.IsVillager && other.Name != subject.Name && ProtocolName.IsMatch(other.Name))
            .Select(other => other.Name)
            .Distinct()
            .Take(MaxWitnesses)
            .ToList();

    private static string TasteName(int taste) => taste switch
    {
        NPC.gift_taste_love => "loved",
        NPC.gift_taste_like => "liked",
        NPC.gift_taste_dislike => "disliked",
        NPC.gift_taste_hate => "hated",
        _ => "neutral",
    };

    private void Record(NPC npc, string npcLine, string? playerChoice, TalkFact? fact = null) =>
        this.todaysEvents.Add(new DayEvent("talk", npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, Witnesses(npc), NpcLine: npcLine, PlayerChoice: playerChoice, Fact: fact));

    // Adds a picked reply's friendship points, clamped to the per-choice cap and to what is left
    // of this NPC's daily talk cap. Points only: hearts follow from points in the game itself.
    private void AddTalkFriendship(NPC npc, int delta)
    {
        int clamped = Math.Clamp(delta, -MaxChoiceDelta, MaxChoiceDelta);
        this.talkDeltaToday.TryGetValue(npc.Name, out int soFar);
        int applied = Math.Clamp(soFar + clamped, -MaxTalkDeltaPerDay, MaxTalkDeltaPerDay) - soFar;
        if (applied == 0)
            return;
        this.talkDeltaToday[npc.Name] = soFar + applied;
        Game1.player.changeFriendship(applied, npc);
        this.Monitor.Log($"Talk friendship {npc.Name} {applied:+#;-#;0} (asked {delta}).", LogLevel.Trace);
    }

    // The player joined the happening: every participant witnessed it. One join event, reported
    // by the NPC the player spoke to, with the other participants as its only witnesses. Each
    // participant gets the join gain (under the same caps). Participants are the brain's list;
    // one the game cannot find is left out of the gain but still witnesses it.
    private void Join(NPC spokenTo, HappeningView h, int gain)
    {
        this.joinedToday = true;
        List<string> others = h.Participants
            .Where(p => p != spokenTo.Name && ProtocolName.IsMatch(p))
            .Distinct()
            .Take(MaxWitnesses)
            .ToList();
        this.todaysEvents.Add(new DayEvent("join", spokenTo.Name, h.Location, Game1.timeOfDay, others, Topic: h.Topic));
        this.AddTalkFriendship(spokenTo, gain);
        foreach (string name in others)
        {
            if (Game1.getCharacterFromName(name) is { } npc)
                this.AddTalkFriendship(npc, gain);
        }
        this.Monitor.Log($"Joined {h.Topic} at {h.Location} with {string.Join(", ", h.Participants)}.", LogLevel.Debug);
    }

    // Sent every night, even with no events: the brain holds it pending until Saved, and an empty
    // day still replaces a pending day left over from a reload without saving.
    private void OnDayEnding(object? sender, DayEndingEventArgs e)
    {
        this.convo = null;
        GameDay today = Today();
        var req = new DayEndRequest(Constants.SaveFolderName ?? "unknown", Game1.player.Name, today, new List<DayEvent>(this.todaysEvents), this.todaysTogether.Values.ToList());
        this.todaysEvents.Clear();
        this.todaysTogether.Clear();
        this.talkDeltaToday.Clear();
        this.joinedToday = false;
        int count = req.Events.Count;
        this.endedDay = new DayRef(today.Season, today.Day, today.Year);
        // Fire and forget: never block the save on the brain. A failure is logged inside BrainClient.
        this.endedDayPost = this.brain.DayEnd(req);
        _ = this.endedDayPost.ContinueWith(t =>
        {
            if (t.Result)
                this.Monitor.Log($"Sent {count} events to the brain; they are kept once the game saves.", LogLevel.Debug);
        });
        // Tomorrow's plan is asked for once day-end lands; the planner reads it in the morning.
        this.planner?.OnDayEnding(this.endedDayPost, new PlanRequest(Constants.SaveFolderName ?? "unknown", Game1.player.Name, Planner.Tomorrow(), ReadStats()));
    }

    // The save finished, so the day the brain is holding is now real: tell it to commit.
    private void OnSaved(object? sender, SavedEventArgs e)
    {
        if (this.endedDay is not { } day || this.endedDayPost is not { } dayEnd)
            return;
        var req = new SavedRequest(Constants.SaveFolderName ?? "unknown", day);
        this.endedDay = null;
        this.endedDayPost = null;
        // Not awaited on the game thread. Runs after day-end finishes, whether it succeeded or not:
        // if day-end failed the brain has nothing pending for this date and commits nothing.
        _ = dayEnd.ContinueWith(_ => this.brain.Saved(req), TaskScheduler.Default).Unwrap().ContinueWith(t =>
        {
            if (t.Result)
                this.Monitor.Log($"Brain committed {day.Season} {day.Day}, year {day.Year} to memory.", LogLevel.Debug);
        });
    }

    private TalkRequest BuildTalk(NPC npc, Conversation c, Choice? recent) => new(
        Constants.SaveFolderName ?? "unknown",
        npc.Name,
        Game1.player.Name,
        Today(),
        new FriendshipInfo(Game1.player.getFriendshipHeartLevelForNPC(npc.Name), Game1.player.getFriendshipLevelForNPC(npc.Name)),
        recent,
        new List<TranscriptLine>(c.Transcript),
        ReadStats(),
        this.joinedToday ? true : null);

    // Every ten game minutes: which villagers share a map right now, wherever the player is.
    private void SampleTogether()
    {
        if (!Context.IsWorldReady || this.todaysTogether.Count >= MaxTogether)
            return;
        foreach (GameLocation location in Game1.locations)
        {
            List<string> names = location.characters
                .Where(c => c.IsVillager && ProtocolName.IsMatch(c.Name))
                .Select(c => c.Name)
                .Distinct()
                .OrderBy(n => n, StringComparer.Ordinal)
                .Take(MaxWitnesses)
                .ToList();
            if (names.Count < 2)
                continue;
            string key = $"{location.Name}|{string.Join(",", names)}";
            if (!this.todaysTogether.ContainsKey(key))
                this.todaysTogether[key] = new Together(location.Name, names);
            if (this.todaysTogether.Count >= MaxTogether)
                return;
        }
    }

    // All stats the brain's table knows about. Which NPC may know which is the brain's call.
    private static GameStats ReadStats()
    {
        Farmer p = Game1.player;
        int? ccRooms = Game1.getLocationFromName("CommunityCenter") is StardewValley.Locations.CommunityCenter cc
            ? cc.areasComplete.Count(done => done)
            : null;
        List<string> buildings = Game1.getFarm().buildings
            .Select(b => b.buildingType.Value)
            .Where(t => !string.IsNullOrEmpty(t))
            .Take(100)
            .ToList();
        return new GameStats(
            string.IsNullOrWhiteSpace(p.farmName.Value) ? null : p.farmName.Value[..Math.Min(p.farmName.Value.Length, 40)],
            (int)Game1.stats.DaysPlayed,
            ccRooms,
            p.deepestMineLevel,
            buildings,
            p.Money);
    }

    private static GameDay Today() => new(
        Game1.currentSeason,
        Game1.dayOfMonth,
        Game1.year,
        Game1.timeOfDay,
        Game1.isLightning ? "storm" : Game1.isRaining ? "rain" : Game1.isSnowing ? "snow" : Game1.isDebrisWeather ? "windy" : "sunny",
        Game1.currentLocation?.Name ?? "unknown");

    private sealed class Conversation
    {
        public Conversation(NPC npc)
        {
            this.Npc = npc;
            this.Location = Game1.currentLocation;
        }

        public NPC Npc { get; }
        public GameLocation Location { get; }
        public int Turns { get; set; }
        public List<TranscriptLine> Transcript { get; } = new();
        public Task<TalkResponse?>? Pending { get; set; }
    }

    private sealed record PendingGift(NPC Npc, Item Item, int GiftsBefore)
    {
        public int TicksWaited { get; set; }
    }
}
