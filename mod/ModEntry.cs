using System;
using System.Collections.Generic;
using System.Linq;
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
    private ModConfig config = new();
    private BrainClient brain = null!;
    private readonly List<DayEvent> todaysEvents = new();
    private Conversation? convo;
    private PendingGift? pendingGift;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.brain = new BrainClient(this.config.BrainUrl, this.config.TimeoutSeconds, msg => this.Monitor.Log(msg, LogLevel.Warn));
        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.DayEnding += this.OnDayEnding;
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.Reset();
        helper.Events.GameLoop.SaveLoaded += (_, _) => this.Reset();
        this.Monitor.Log($"Townsfolk: brain at {this.config.BrainUrl}, NPCs: {(this.config.AllNpcs ? "all" : string.Join(", ", this.config.EnabledNpcs))}", LogLevel.Info);
    }

    private void Reset()
    {
        this.todaysEvents.Clear();
        this.convo = null;
        this.pendingGift = null;
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
        reply ??= new TalkResponse("Anyway, I should get going. See you around.", new List<Choice>(), true, "fallback");

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
        Choice? picked = reply.Choices.FirstOrDefault(ch => ch.Id == answer);
        if (picked is null)
        {
            this.convo = null;
            return;
        }
        this.Record(c.Npc, reply.Line, picked.Text);
        TalkRequest req = this.BuildTalk(c.Npc, c, picked);
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
            "gift", g.Npc.Name, Game1.currentLocation.Name, Game1.timeOfDay,
            Item: g.Item.DisplayName, Taste: TasteName(g.Npc.getGiftTasteForThisItem(g.Item))));
    }

    private static string TasteName(int taste) => taste switch
    {
        NPC.gift_taste_love => "loved",
        NPC.gift_taste_like => "liked",
        NPC.gift_taste_dislike => "disliked",
        NPC.gift_taste_hate => "hated",
        _ => "neutral",
    };

    private void Record(NPC npc, string npcLine, string? playerChoice) =>
        this.todaysEvents.Add(new DayEvent("talk", npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, NpcLine: npcLine, PlayerChoice: playerChoice));

    private void OnDayEnding(object? sender, DayEndingEventArgs e)
    {
        this.convo = null;
        if (this.todaysEvents.Count == 0)
            return;
        var req = new DayEndRequest(Constants.SaveFolderName ?? "unknown", Game1.player.Name, Today(), new List<DayEvent>(this.todaysEvents));
        this.todaysEvents.Clear();
        int count = req.Events.Count;
        // Fire and forget: never block the save on the brain. A failure is logged inside BrainClient.
        _ = this.brain.DayEnd(req).ContinueWith(t =>
        {
            if (t.Result)
                this.Monitor.Log($"Sent {count} events to the brain for the night.", LogLevel.Debug);
        });
    }

    private TalkRequest BuildTalk(NPC npc, Conversation c, Choice? recent) => new(
        Constants.SaveFolderName ?? "unknown",
        npc.Name,
        Game1.player.Name,
        Today(),
        new FriendshipInfo(Game1.player.getFriendshipHeartLevelForNPC(npc.Name), Game1.player.getFriendshipLevelForNPC(npc.Name)),
        recent,
        new List<TranscriptLine>(c.Transcript));

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
