using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Xna.Framework;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewModdingAPI.Utilities;
using StardewValley;
using StardewValley.Menus;

namespace Townsfolk;

/// <summary>
/// The bridge. Reads game state, shows dialogue, records what each NPC witnessed.
/// All decisions about what is said live in the brain (brain/).
/// Threading rule: game state is only touched on the game thread (event handlers and UpdateTicked);
/// HTTP runs on the thread pool and its Task is polled from UpdateTicked.
/// Multiplayer: only the host computer (Context.IsOnHostComputer) reaches the brain, for the host
/// and any split-screen player, each with their own farmerId. A farmhand on another computer goes
/// through the host's mod (HostRelay). Day-end, saved, world and plan are the main player's alone.
/// SMAPI raises every event once per split-screen screen on one mod instance, so what belongs to
/// one player lives in PerScreen and what the whole game shares is written by screen 0 or the
/// main player only.
/// </summary>
public sealed class ModEntry : Mod
{
    // protocol/day-end-request.schema.json caps witnesses per event at 40, events per day at 500,
    // and together at 200 groups of at most 40.
    internal const int MaxWitnesses = 40;
    private const int MaxEvents = 500;
    private const int MaxTogether = 200;
    // protocol/talk-response.schema.json caps one choice's delta at +-15. Re-checked here so a
    // misbehaving brain can never move friendship more than that in one pick.
    private const int MaxChoiceDelta = 15;
    // Conversations can be restarted all day, so talk-driven friendship per NPC per day is capped
    // too. Same number as the planner's daily friendship cap.
    private const int MaxTalkDeltaPerDay = 40;
    // protocol: playerName is 1..40 chars; farmerName follows it. farmers[] holds at most 8
    // (brain/src/protocol.ts MAX_FARMERS, the game's own limit).
    private const int MaxFarmerName = 40;
    private const int MaxFarmers = 8;

    private ModConfig config = new();
    private BrainClient brain = null!;
    private BrainLauncher? launcher;
    private HostRelay relay = null!;
    private Planner? planner;
    private SceneWatcher scenes = null!;
    // One per split-screen player: their conversation, gift, talk delta, join and chats today.
    private readonly PerScreen<ScreenState> screens = new(() => new ScreenState());

    // Host computer only, for the whole game: every farmer's events today, each with its farmerId.
    private readonly List<DayEvent> todaysEvents = new();
    // Groups of villagers seen on the same map today, keyed by location and sorted names so a
    // group that stands still all afternoon is sent once.
    private readonly Dictionary<string, Together> todaysTogether = new();

    // The day handed to the brain at DayEnding, and that request's Task. Saved fires after the
    // date has already moved on, so it reports this remembered date, and it is sent only once the
    // day-end request has finished so the brain always sees day-end before saved.
    private DayRef? endedDay;
    private Task<bool>? endedDayPost;

    private ScreenState Screen => this.screens.Value;

    public override void Entry(IModHelper helper)
    {
        this.config = helper.ReadConfig<ModConfig>();
        this.launcher = this.config.StartBrain ? new BrainLauncher(this.Monitor, helper.DirectoryPath, this.config.BrainUrl, this.config.NodePath) : null;
        this.brain = new BrainClient(this.config.BrainUrl, this.config.TimeoutSeconds, this.config.PlanTimeoutSeconds, msg => this.Monitor.Log(msg, LogLevel.Warn));
        // With planning off the planner is never built: no world, no plan requests, no asset edits.
        this.planner = this.config.Planning ? new Planner(helper, this.Monitor, this.brain, this.Route) : null;
        this.relay = new HostRelay(helper, this.Monitor, this.brain, this.ModManifest.UniqueID, this.ModManifest.Version.ToString(),
            this.config.TimeoutSeconds, this.IsEnabled, this.AddEvent, this.OnFarmerApply);
        this.scenes = new SceneWatcher(this.Monitor, this.AddOwnEvent);
        helper.Events.Input.ButtonPressed += this.OnButtonPressed;
        helper.Events.GameLoop.UpdateTicked += this.OnUpdateTicked;
        helper.Events.GameLoop.TimeChanged += (_, _) => this.SampleTogether();
        helper.Events.GameLoop.DayEnding += this.OnDayEnding;
        helper.Events.GameLoop.Saved += this.OnSaved;
        helper.Events.GameLoop.ReturnedToTitle += (_, _) => this.Reset();
        helper.Events.GameLoop.SaveLoaded += (_, _) =>
        {
            this.Reset();
            if (!OwnsSharedState)
                return;
            // The brain is started here when nothing answers, then checked; the world snapshot waits for both.
            this.planner?.OnSaveLoaded(Context.IsOnHostComputer ? Task.Run(this.CheckBrainAtLoad) : Task.CompletedTask);
            this.relay.OnSaveLoaded();
        };
        this.Monitor.Log($"Townsfolk: brain at {this.config.BrainUrl} (host computer only), NPCs: {(this.config.AllNpcs ? "all" : string.Join(", ", this.config.EnabledNpcs))}, planning {(this.config.Planning ? "on" : "off")}", LogLevel.Info);
    }

    // Thread pool, at save load on the host computer. Starts the brain if nothing answers, then
    // asks /v1/health whether the brain is this mod's version and can talk. A brain of another
    // version that the mod started itself (its bundled brain/package.json differs from the
    // manifest) is restarted once; one started by hand is only reported, since the mod must not
    // stop a process it did not start. Anything wrong is logged and shown once on the HUD.
    private async Task CheckBrainAtLoad()
    {
        if (this.launcher is not null)
            await this.launcher.EnsureRunning();
        string mine = this.ModManifest.Version.ToString();
        HealthResponse? health = await this.brain.Health();
        if (health is not null && health.Version != mine && this.launcher is { OwnsRunningBrain: true })
        {
            this.Monitor.Log($"The brain this mod started reports version {health.Version ?? "none"}, not {mine}; restarting it.", LogLevel.Warn);
            await this.launcher.Restart();
            health = await this.brain.Health();
        }
        BrainNotice? notice = BrainCheck.AtLoad(health, mine, this.config.BrainUrl);
        if (notice is null)
        {
            this.Monitor.Log($"Brain {health!.Version} is ready ({health.Model}).", LogLevel.Info);
            return;
        }
        this.Monitor.Log(notice.Log, LogLevel.Warn);
        Interlocked.Exchange(ref this.hudNotice, notice.Hud);
    }

    // Set on the thread pool by CheckBrainAtLoad, shown and cleared on the game thread.
    private string? hudNotice;

    private void ShowHudNotice()
    {
        if (Context.IsWorldReady && Interlocked.Exchange(ref this.hudNotice, null) is { } text)
            Game1.addHUDMessage(new HUDMessage(text, HUDMessage.error_type));
    }

    // SMAPI calls this when the game quits: the brain the mod started goes with it.
    protected override void Dispose(bool disposing)
    {
        if (disposing)
            this.launcher?.Dispose();
        base.Dispose(disposing);
    }

    // Screen 0 is the game itself: the host on the host computer, the farmhand on theirs. A
    // split-screen player is a later screen and must not reset what the whole game shares.
    private static bool OwnsSharedState => Context.ScreenId == 0;

    private void Reset()
    {
        this.screens.Value = new ScreenState();
        this.scenes.Reset();
        if (!OwnsSharedState)
            return;
        this.todaysEvents.Clear();
        this.todaysTogether.Clear();
        this.endedDay = null;
        this.endedDayPost = null;
        this.planner?.Reset();
        this.relay.Reset();
    }

    private bool IsEnabled(NPC npc) =>
        npc.IsVillager && npc.CanSocialize && Voiced.Allows(npc.Name, this.config.Voiced, this.config.AllNpcs, this.config.EnabledNpcs);

    /// <summary>farmerId on the wire: Farmer.UniqueMultiplayerID in decimal.</summary>
    internal static string FarmerId(Farmer f) => f.UniqueMultiplayerID.ToString(CultureInfo.InvariantCulture);

    internal static string FarmerName(Farmer f) => f.Name.Length <= MaxFarmerName ? f.Name : f.Name[..MaxFarmerName];

    private void OnButtonPressed(object? sender, ButtonPressedEventArgs e)
    {
        // IsPlayerFree is false during a cutscene and a festival is checked on its own, so
        // nothing is ever suppressed while either is on.
        if (!Context.IsWorldReady || !Context.IsPlayerFree || !e.Button.IsActionButton() || Game1.isFestival())
            return;
        // A farmhand whose host has no matching Townsfolk mod stays vanilla.
        if (!Context.IsOnHostComputer && !this.relay.Ready)
            return;

        NPC? npc = FindNpcNear(e.Cursor.GrabTile);
        if (npc is null || !this.IsEnabled(npc) || CounterGuard.IsCounterClick(Game1.currentLocation, e.Cursor.GrabTile))
            return;

        ScreenState s = this.Screen;
        // Holding an object means the player is giving a gift: let vanilla handle it and watch the result.
        if (Game1.player.ActiveObject is { } held)
        {
            Game1.player.friendshipData.TryGetValue(npc.Name, out Friendship? f);
            s.Gift = new PendingGift(npc, held, f?.GiftsToday ?? 0);
            return;
        }

        // The game's own dialogue answers when it can move the game forward or carries the story.
        // Not suppressed, so vanilla runs this click exactly as it would without the mod.
        if (s.Convo?.Pending is null)
        {
            VanillaReason why = VanillaFirst.Decide(this.ReadGate(npc));
            if (why != VanillaReason.None)
            {
                this.RecordChat(npc, why);
                return;
            }
        }

        this.Helper.Input.Suppress(e.Button);

        // A reply is on its way: swallow the extra click so vanilla dialogue does not race it.
        if (s.Convo?.Pending is not null)
            return;

        // A conversation that is neither waiting nor showing a menu was abandoned (question box
        // closed without a pick). It is finished; start a new one.
        npc.faceTowardFarmerForPeriod(6000, 4, false, Game1.player);
        s.Convo = new Conversation(npc);
        // The same NPC, the same day, after walking away mid-conversation: pick it up where it
        // stopped, from the transcript kept here. A different NPC starts a new chat.
        Choice? resumeFrom = null;
        if (s.Abandoned.Remove(npc.Name, out List<TranscriptLine>? kept))
        {
            if (kept.Count > 0 && kept[^1].Speaker == "player")
            {
                resumeFrom = new Choice("resume", kept[^1].Text);
                kept.RemoveAt(kept.Count - 1);
            }
            s.Convo.Transcript.AddRange(kept);
            s.Convo.Turns = kept.Count(t => t.Speaker == "npc");
        }
        this.AskAndWait(s.Convo, this.BuildTalk(npc, s.Convo, resumeFrom));
    }

    // Asks the brain and opens the waiting box at once, so there is never a moment where the world
    // runs and a box pops up later. The box is an active menu: the player cannot walk away, and in
    // single player time stands still as it does in vanilla dialogue.
    private void AskAndWait(Conversation c, TalkRequest req)
    {
        c.Ask(this.AskTalk(req));
        this.ShowWaiting(c);
    }

    private void ShowWaiting(Conversation c)
    {
        if (Game1.activeClickableMenu is null)
        {
            c.Box = new WaitingBox(c.Npc);
            Game1.activeClickableMenu = c.Box;
        }
    }

    // Closes our waiting box if it is the open menu. Anything else the player opened is left alone.
    private static void CloseWaiting(Conversation c)
    {
        if (c.Box is not null && Game1.activeClickableMenu == c.Box)
            Game1.activeClickableMenu = null;
        c.Box = null;
    }

    // The conversation stops here but may be resumed today: keep what was said.
    private void Abandon(ScreenState s, Conversation c)
    {
        if (c.Transcript.Count > 0)
            s.Abandoned[c.Npc.Name] = new List<TranscriptLine>(c.Transcript);
        s.Convo = null;
    }

    // The host computer asks its own brain. A farmhand asks the host; that Task completes with
    // null after TimeoutSeconds, and the opening turn then falls back to vanilla checkAction.
    private Task<TalkResponse?> AskTalk(TalkRequest req) =>
        Context.IsOnHostComputer ? this.brain.Talk(req) : this.relay.Talk(req);

    // What VanillaFirst needs, read from the game. Reading CurrentDialogue loads today's
    // dialogue stack if it is not loaded yet, which is what vanilla's own click does first; the
    // top line is only peeked, never taken. If the reflected fields ever disappear (a game
    // update), this throws before Suppress, so SMAPI logs it and vanilla handles the click.
    private TalkGate ReadGate(NPC npc)
    {
        Farmer p = Game1.player;
        PendingDialogue? pending = null;
        if (npc.CurrentDialogue.TryPeek(out Dialogue? d))
        {
            bool question = this.Helper.Reflection.GetField<bool>(d, "isLastDialogueInteractive").GetValue()
                || this.Helper.Reflection.GetField<bool>(d, "quickResponse").GetValue();
            bool commands = question || d.isItemGrabDialogue() || d.dialogues.Any(line => line.SideEffects is not null);
            pending = new PendingDialogue(d.TranslationKey, commands);
        }
        return new TalkGate(npc.Name, p.friendshipData.ContainsKey(npc.Name), HasQuestFor(p, npc.Name), npc.isBirthday(), pending);
    }

    // An unfinished quest that completes, or reports back, by talking to this NPC. Item delivery
    // also completes by handing the item over, which the gift path already leaves to vanilla.
    private static bool HasQuestFor(Farmer p, string npc) =>
        p.questLog.Any(q => !q.completed.Value && q switch
        {
            StardewValley.Quests.SocializeQuest s => s.whoToGreet.Contains(npc),
            StardewValley.Quests.ItemDeliveryQuest i => i.target.Value == npc,
            StardewValley.Quests.LostItemQuest l => l.npcName.Value == npc,
            StardewValley.Quests.SecretLostItemQuest l => l.npcName.Value == npc,
            StardewValley.Quests.FishingQuest f => f.target.Value == npc,
            StardewValley.Quests.ResourceCollectionQuest r => r.target.Value == npc,
            StardewValley.Quests.SlayMonsterQuest m => m.target.Value == npc,
            _ => false,
        });

    // One chat per NPC per reason per day: a birthday NPC clicked five times is one memory.
    private void RecordChat(NPC npc, VanillaReason why)
    {
        if (!this.Screen.ChatsToday.Add($"{npc.Name}|{why}"))
            return;
        this.AddOwnEvent(new DayEvent("chat", npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, Witnesses(npc), Reason: VanillaFirst.WireName(why)));
        this.Monitor.Log($"Vanilla dialogue for {npc.Name} ({VanillaFirst.WireName(why)}).", LogLevel.Debug);
    }

    // Something this screen's player did. On the host computer it joins the day's events; a
    // farmhand sends it to the host as it happens, and the host puts the sender's id over these.
    private void AddOwnEvent(DayEvent ev)
    {
        DayEvent stamped = ev with { FarmerId = FarmerId(Game1.player), FarmerName = FarmerName(Game1.player) };
        if (Context.IsOnHostComputer)
            this.AddEvent(stamped);
        else
            this.relay.SendEvent(stamped);
    }

    // Host computer: one more event for tonight. Past the protocol's daily cap the brain would
    // refuse the whole day, so later events are left out instead.
    private void AddEvent(DayEvent ev)
    {
        if (this.todaysEvents.Count >= MaxEvents)
        {
            this.Monitor.LogOnce($"More than {MaxEvents} events today; the rest are not remembered.", LogLevel.Debug);
            return;
        }
        this.todaysEvents.Add(ev);
    }

    // Event ids the player has seen, for the brain to pick each NPC's own (brain/src/story.ts).
    // Same id rule and cap as protocol/common.schema.json; an id outside it (another mod's) is left out.
    private static readonly Regex EventId = new(@"^[A-Za-z0-9_.-]{1,60}$", RegexOptions.CultureInvariant);
    private const int MaxEventsSeen = 2000;

    internal static List<string> EventsSeen(Farmer p) =>
        p.eventsSeen.Where(id => EventId.IsMatch(id)).Take(MaxEventsSeen).ToList();

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
        this.ShowHudNotice();
        this.relay.OnUpdateTicked();
        this.scenes.OnUpdateTicked();
        this.CheckGift();
        this.planner?.OnUpdateTicked();

        ScreenState s = this.Screen;
        this.CaptureGameLines(s);
        if (s.Convo?.Pending is not { } done)
            return;

        Conversation c = s.Convo;
        // The player pressed Escape on the waiting box: the conversation ends here, cleanly, and
        // the reply, if it ever comes, is never shown.
        if (c.Box is { UserClosed: true })
        {
            c.Box = null;
            c.Pending = null;
            this.Abandon(s, c);
            return;
        }
        // Between turns the box is up again as soon as no other menu is.
        if (c.Box is null)
            this.ShowWaiting(c);
        // A reply that has not come within the talk timeout is given up on here, on the game
        // thread, whatever state the request is in. Its late answer, if any, is never shown.
        // This is also the farmhand's relay wait: no talk.resp in time means vanilla below.
        bool overdue = !done.IsCompleted && TalkWait.Overdue(c.AskedAtMs, Environment.TickCount64, this.config.TimeoutSeconds);
        if (!done.IsCompleted && !overdue)
            return;

        // The player left the map or a cutscene started while we waited: drop the reply quietly.
        if (!Context.IsWorldReady || Game1.eventUp || Game1.currentLocation != c.Location)
        {
            CloseWaiting(c);
            this.Abandon(s, c);
            return;
        }

        // Another menu is open (the inventory, say): show the reply once it closes. Our own
        // waiting box is replaced by the reply in this same tick.
        if (Game1.activeClickableMenu is not null && Game1.activeClickableMenu != c.Box)
            return;
        CloseWaiting(c);

        c.Pending = null;
        TalkResponse? reply = done.Status == TaskStatus.RanToCompletion ? done.Result : null;
        // The request state and thread pool numbers are here to find why the first talk after
        // a load hung in the 436a094 smoke test; HttpClient's own timeout never fired then.
        if (overdue)
            this.Monitor.Log(
                $"No reply from the brain for {c.Npc.Name} in {this.config.TimeoutSeconds}s (request {done.Status}, " +
                $"thread pool {ThreadPool.ThreadCount} threads, {ThreadPool.PendingWorkItemCount} queued).",
                LogLevel.Warn);

        // Brain down, slow, or out of good answers on the opening turn: the NPC says their normal line.
        string? failure = BrainCheck.TalkFailure(reply, overdue, this.config.TimeoutSeconds, Context.IsOnHostComputer);
        if (c.Turns == 0 && failure is not null)
        {
            s.Convo = null;
            this.Monitor.Log($"Brain gave no usable reply (reason: {failure}); vanilla dialogue for {c.Npc.Name}.", LogLevel.Warn);
            c.Npc.checkAction(Game1.player, Game1.currentLocation);
            return;
        }
        if (failure is not null)
            this.Monitor.Log($"Brain gave no usable reply (reason: {failure}); {c.Npc.Name} ends the conversation.", LogLevel.Warn);

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
            s.OwnLines.Add(reply.Line);
            Game1.DrawDialogue(new Dialogue(c.Npc, null, reply.Line));
            s.Convo = null;
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
            // The question box was closed without a pick: the chat can be resumed today.
            this.Abandon(this.Screen, c);
            return;
        }
        this.Record(c.Npc, reply.Line, picked.Text, picked.Fact);
        // The brain's goodbye: a short closing line and nothing more is asked of the brain.
        if (picked.Bye == true)
        {
            this.Screen.Convo = null;
            string closing = string.IsNullOrWhiteSpace(picked.Closing) ? "See you around." : picked.Closing;
            this.Screen.OwnLines.Add(closing);
            Game1.DrawDialogue(new Dialogue(c.Npc, null, closing));
            return;
        }
        if (picked.Join == true && reply.Happening is { } h)
            this.Join(c.Npc, h, picked.Delta);
        else
            this.AddTalkFriendship(c.Npc, picked.Delta);
        var said = new Choice(picked.Id, picked.Text);
        TalkRequest req = this.BuildTalk(c.Npc, c, said);
        c.Transcript.Add(new TranscriptLine("player", picked.Text));
        // The question box is still closing; the tick opens the waiting box as soon as it has.
        c.Ask(this.AskTalk(req));
        c.Box = null;
    }

    // Records the game's own lines the player sees from an enabled villager: first meetings,
    // everyday lines, birthdays. Each distinct line once per NPC per day. They go to the brain as
    // an event ("I said (game line)") and with every talk request, so a Claude turn knows them.
    // Lines this mod wrote itself (OwnLines) are not the game's and are skipped.
    private void CaptureGameLines(ScreenState s)
    {
        if (Game1.activeClickableMenu is not DialogueBox { characterDialogue: { } d } || d.speaker is not { } npc || !this.IsEnabled(npc))
            return;
        string text = CleanGameLine(d.getCurrentDialogue(), Game1.player.Name);
        if (text.Length == 0 || s.OwnLines.Contains(text) || !s.GameLinesSeen.Add($"{npc.Name}|{text}"))
            return;
        if (!s.GameLines.TryGetValue(npc.Name, out List<string>? lines))
            s.GameLines[npc.Name] = lines = new List<string>();
        lines.Add(text);
        if (lines.Count > MaxGameLines)
            lines.RemoveAt(0);
        this.AddOwnEvent(new DayEvent("said", npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, Witnesses(npc), Line: text));
    }

    private const int MaxGameLines = 8;

    // The game's markup, turned into the words the player read: "@" is the player's name, "$h"
    // style codes and "#" page breaks go, and so do "%" tokens and "^" gender switches.
    internal static string CleanGameLine(string raw, string player)
    {
        string t = raw.Replace("@", player);
        t = Regex.Replace(t, @"\$[A-Za-z0-9]+|%[A-Za-z]+|\^[^\^#]*", "");
        t = Regex.Replace(t, @"[#$%^{}<>|]", " ");
        t = Regex.Replace(t, @"\s+", " ").Trim();
        return t.Length <= 400 ? t : t[..400];
    }

    // The game applies the gift a tick or so after the click; watch for up to one second.
    private void CheckGift()
    {
        ScreenState s = this.Screen;
        if (s.Gift is not { } g)
            return;
        bool given = Game1.player.friendshipData.TryGetValue(g.Npc.Name, out Friendship? f) && f.GiftsToday > g.GiftsBefore;
        if (!given)
        {
            if (++g.TicksWaited > 60)
                s.Gift = null;
            return;
        }
        s.Gift = null;
        this.AddOwnEvent(new DayEvent(
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
        this.AddOwnEvent(new DayEvent("talk", npc.Name, Game1.currentLocation.Name, Game1.timeOfDay, Witnesses(npc), NpcLine: npcLine, PlayerChoice: playerChoice, Fact: fact));

    // Adds a picked reply's friendship points, clamped to the per-choice cap and to what is left
    // of this NPC's daily talk cap. Points only: hearts follow from points in the game itself.
    // Always this screen's own player, on their own computer.
    private void AddTalkFriendship(NPC npc, int delta)
    {
        Dictionary<string, int> today = this.Screen.TalkDeltaToday;
        int clamped = Math.Clamp(delta, -MaxChoiceDelta, MaxChoiceDelta);
        today.TryGetValue(npc.Name, out int soFar);
        int applied = Math.Clamp(soFar + clamped, -MaxTalkDeltaPerDay, MaxTalkDeltaPerDay) - soFar;
        if (applied == 0)
            return;
        today[npc.Name] = soFar + applied;
        Game1.player.changeFriendship(applied, npc);
        this.Monitor.Log($"Talk friendship {npc.Name} {applied:+#;-#;0} (asked {delta}).", LogLevel.Trace);
    }

    // The player joined the happening: every participant witnessed it. One join event, reported
    // by the NPC the player spoke to, with the other participants as its only witnesses. Each
    // participant gets the join gain (under the same caps). Participants are the brain's list;
    // one the game cannot find is left out of the gain but still witnesses it.
    private void Join(NPC spokenTo, HappeningView h, int gain)
    {
        this.Screen.JoinedToday = true;
        List<string> others = h.Participants
            .Where(p => p != spokenTo.Name && ProtocolName.IsMatch(p))
            .Distinct()
            .Take(MaxWitnesses)
            .ToList();
        this.AddOwnEvent(new DayEvent("join", spokenTo.Name, h.Location, Game1.timeOfDay, others, Topic: h.Topic));
        this.AddTalkFriendship(spokenTo, gain);
        foreach (string name in others)
        {
            if (Game1.getCharacterFromName(name) is { } npc)
                this.AddTalkFriendship(npc, gain);
        }
        this.Monitor.Log($"Joined {h.Topic} at {h.Location} with {string.Join(", ", h.Participants)}.", LogLevel.Debug);
    }

    // Every screen starts a new day of its own. The main player then sends the day, every night
    // even with no events: the brain holds it pending until Saved, and an empty day still
    // replaces a pending day left over from a reload without saving.
    private void OnDayEnding(object? sender, DayEndingEventArgs e)
    {
        this.screens.Value = new ScreenState();
        // Before the day's events are copied below, so a scene still up at day end is in them.
        this.scenes.OnDayEnding();
        if (!Context.IsMainPlayer)
            return;
        GameDay today = Today(Game1.player);
        var events = new List<DayEvent>(this.todaysEvents);
        List<Together> together = this.todaysTogether.Values.ToList();
        this.todaysEvents.Clear();
        this.todaysTogether.Clear();
        this.relay.OnDayEnding();
        // A brand-new game ends its creation day before its save folder exists. SMAPI then names
        // a folder with no farm name yet ("_451964697"), which is not the id the save will have
        // and which the brain refuses. Nothing was played, so there is no day to send or plan.
        if (Constants.CurrentSavePath is null)
        {
            this.Monitor.Log("No save folder yet (new game); skipped day-end and plan for tonight.", LogLevel.Debug);
            return;
        }
        string saveId = Constants.SaveFolderName!;
        var req = new DayEndRequest(saveId, Game1.player.Name, today, events, together);
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
        this.planner?.OnDayEnding(this.endedDayPost, new PlanRequest(saveId, Game1.player.Name, Planner.Tomorrow(), ReadStats(Game1.player), EventsSeen(Game1.player), this.PlannedFarmers()));
    }

    // The save finished, so the day the brain is holding is now real: tell it to commit.
    private void OnSaved(object? sender, SavedEventArgs e)
    {
        if (!Context.IsMainPlayer || this.endedDay is not { } day || this.endedDayPost is not { } dayEnd)
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

    // The farmers tonight's plan may address: the host, split-screen players on this computer,
    // and farmhands whose mod said hello with our version. Nobody else gets anything from a plan.
    private List<PlanFarmer> PlannedFarmers() =>
        Game1.getOnlineFarmers()
            .Where(f => f.IsMainPlayer || this.IsSplitScreen(f.UniqueMultiplayerID) || this.relay.IsGreeted(f.UniqueMultiplayerID))
            .Select(f => new PlanFarmer(FarmerId(f), FarmerName(f), Hearts(f)))
            .Take(MaxFarmers)
            .ToList();

    private bool IsSplitScreen(long farmerId) => this.Helper.Multiplayer.GetConnectedPlayer(farmerId)?.IsSplitScreen == true;

    // protocol/plan-request.schema.json: hearts 0..14 (14 for a spouse), keyed by NPC name.
    private static Dictionary<string, int> Hearts(Farmer f) =>
        f.friendshipData.Keys
            .Where(npc => ProtocolName.IsMatch(npc))
            .ToDictionary(npc => npc, npc => Math.Clamp(f.getFriendshipHeartLevelForNPC(npc), 0, 14));

    // Host: plan parts for a farmer other than the host. A split-screen player applies them on
    // their own screen; a farmhand's mod gets them as townsfolk.farmer.apply.
    private void Route(long farmerId, FarmerApply apply)
    {
        if (this.IsSplitScreen(farmerId))
            this.planner?.Queue(apply);
        else if (this.relay.IsGreeted(farmerId))
            this.relay.SendApply(farmerId, apply);
        else
            this.Monitor.Log($"Dropped plan parts for farmer {farmerId}: not in the game with a matching Townsfolk mod.", LogLevel.Debug);
    }

    // Farmhand: the host sent plan parts. Only this farmer's own are applied, on this game.
    private void OnFarmerApply(FarmerApply apply)
    {
        if (apply.FarmerId != FarmerId(Game1.player))
            this.Monitor.Log($"Ignored plan parts for farmer {apply.FarmerId}: this game plays {FarmerId(Game1.player)}.", LogLevel.Debug);
        else if (this.planner is null)
            this.Monitor.Log("Ignored plan parts from the host: planning is off in this config.", LogLevel.Debug);
        else
            this.planner.Queue(apply);
    }

    private TalkRequest BuildTalk(NPC npc, Conversation c, Choice? recent) => new(
        Constants.SaveFolderName ?? "unknown",
        npc.Name,
        Game1.player.Name,
        Today(Game1.player),
        new FriendshipInfo(Game1.player.getFriendshipHeartLevelForNPC(npc.Name), Game1.player.getFriendshipLevelForNPC(npc.Name)),
        recent,
        new List<TranscriptLine>(c.Transcript),
        ReadStats(Game1.player),
        this.Screen.JoinedToday ? true : null,
        EventsSeen(Game1.player),
        FarmerId(Game1.player),
        FarmerName(Game1.player),
        this.Screen.GameLines.TryGetValue(npc.Name, out List<string>? said) ? new List<string>(said) : null);

    // Every ten game minutes: which villagers share a map right now, wherever the player is.
    // Main player only: the host sees every map and this list is the whole game's.
    private void SampleTogether()
    {
        if (!Context.IsWorldReady || !Context.IsMainPlayer || this.todaysTogether.Count >= MaxTogether)
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

    // All stats the brain's table knows about, for one farmer. Which NPC may know which is the brain's call.
    internal static GameStats ReadStats(Farmer p)
    {
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

    // The date, time and weather, with the location of the given farmer.
    internal static GameDay Today(Farmer p) => new(
        Game1.currentSeason,
        Game1.dayOfMonth,
        Game1.year,
        Game1.timeOfDay,
        Game1.isLightning ? "storm" : Game1.isRaining ? "rain" : Game1.isSnowing ? "snow" : Game1.isDebrisWeather ? "windy" : "sunny",
        p.currentLocation?.Name ?? "unknown");

    /// <summary>One player's state for today. Replaced, not cleared, at day end and on load.</summary>
    private sealed class ScreenState
    {
        public Conversation? Convo { get; set; }
        public PendingGift? Gift { get; set; }
        // Friendship points talk has moved today, per NPC, so the daily cap holds across conversations.
        public Dictionary<string, int> TalkDeltaToday { get; } = new();
        // The player joined a happening today; the brain offers no second join.
        public bool JoinedToday { get; set; }
        // "npc|reason" for each vanilla chat recorded today.
        public HashSet<string> ChatsToday { get; } = new();
        // Conversations the player walked away from today, by NPC, kept so the same NPC can pick the chat up again.
        public Dictionary<string, List<TranscriptLine>> Abandoned { get; } = new();
        // The game's own lines seen today, per NPC (sent with every talk), and every one seen (so each is recorded once).
        public Dictionary<string, List<string>> GameLines { get; } = new();
        public HashSet<string> GameLinesSeen { get; } = new();
        // Lines this mod itself put in a dialogue box, which are not the game's.
        public HashSet<string> OwnLines { get; } = new();
    }

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
        // The waiting box while a reply is on its way; null when none is up.
        public WaitingBox? Box { get; set; }
        public List<TranscriptLine> Transcript { get; } = new();
        public Task<TalkResponse?>? Pending { get; set; }
        // When Pending was asked for, from Environment.TickCount64.
        public long AskedAtMs { get; private set; }

        public void Ask(Task<TalkResponse?> reply)
        {
            this.Pending = reply;
            this.AskedAtMs = Environment.TickCount64;
        }
    }

    private sealed record PendingGift(NPC Npc, Item Item, int GiftsBefore)
    {
        public int TicksWaited { get; set; }
    }
}
