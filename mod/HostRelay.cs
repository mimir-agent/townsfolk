using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading.Tasks;
using StardewModdingAPI;
using StardewModdingAPI.Events;
using StardewValley;

namespace Townsfolk;

/// <summary>
/// Both ends of the multiplayer relay (message shapes in RelayRules.cs).
/// Host computer (Context.IsOnHostComputer): takes messages only from farmers in this game, keyed
/// by the id SMAPI reports as the sender, never one from the payload. It answers hello, asks its
/// own brain for a farmhand's talk, adds a farmhand's events to the day, and sends plan parts to
/// farmhands. Every send from the host happens on the main player's tick, so the sender id the
/// farmhand sees is always the host's.
/// Farmhand (another computer): says hello on save load and waits at most 10 s; sends talk and
/// events to the host; never reaches a brain. A talk wait ends after TimeoutSeconds with no reply,
/// and the caller then runs vanilla.
/// Threading rule: SMAPI raises ModMessageReceived and UpdateTicked on the game thread. Brain
/// Tasks are polled from UpdateTicked, so no game object is touched off the game thread.
/// </summary>
public sealed class HostRelay
{
    public const string HelloType = "townsfolk.hello";
    public const string TalkReqType = "townsfolk.talk.req";
    public const string TalkRespType = "townsfolk.talk.resp";
    public const string EventType = "townsfolk.event";
    public const string FarmerApplyType = "townsfolk.farmer.apply";

    // spec-v2 slice M: no hello answer in 10 s means the host has no Townsfolk mod.
    private const int HelloTimeoutSeconds = 10;
    private const int MaxRequestId = 40;
    // protocol/day-end-request.schema.json allows 500 events a day; one farmhand cannot use them all.
    private const int MaxEventsPerFarmhand = 200;
    // Messages a host takes per farmhand between two of its own ticks; the rest are ignored.
    private const int MaxInboxPerFarmhand = 8;

    private readonly IModHelper helper;
    private readonly IMonitor monitor;
    private readonly BrainClient brain;
    private readonly string modId;
    private readonly string version;
    private readonly int timeoutSeconds;
    private readonly Func<NPC, bool> isEnabled;
    private readonly Action<DayEvent> addEvent;
    private readonly Action<FarmerApply> applyLocal;

    // ---- host computer ----
    // Messages received, handled on the main player's next tick.
    private readonly List<Incoming> inbox = new();
    // Farmhands whose hello carried our version. Nobody else is served or sent plan parts.
    private readonly HashSet<long> greeted = new();
    // A farmhand's talk waiting on the brain, at most one per farmhand.
    private readonly Dictionary<long, RelayedTalk> relayed = new();
    private readonly Dictionary<long, int> eventsToday = new();

    // ---- farmhand ----
    private Link link = Link.Off;
    private string? helloId;
    private DateTime helloDeadline;
    private readonly Dictionary<string, PendingTalk> pending = new();
    private int nextId;

    public HostRelay(IModHelper helper, IMonitor monitor, BrainClient brain, string modId, string version, int timeoutSeconds,
        Func<NPC, bool> isEnabled, Action<DayEvent> addEvent, Action<FarmerApply> applyLocal)
    {
        this.helper = helper;
        this.monitor = monitor;
        this.brain = brain;
        this.modId = modId;
        this.version = version;
        this.timeoutSeconds = timeoutSeconds;
        this.isEnabled = isEnabled;
        this.addEvent = addEvent;
        this.applyLocal = applyLocal;
        helper.Events.Multiplayer.ModMessageReceived += this.OnMessage;
        helper.Events.Multiplayer.PeerDisconnected += (_, e) => this.Forget(e.Peer.PlayerID);
    }

    /// <summary>Farmhand: the host answered hello with our version, so talk goes through it.</summary>
    public bool Ready => this.link == Link.Ready;

    /// <summary>Host: this farmhand's mod said hello with our version.</summary>
    public bool IsGreeted(long farmerId) => this.greeted.Contains(farmerId);

    public void Reset()
    {
        this.inbox.Clear();
        this.greeted.Clear();
        this.relayed.Clear();
        this.eventsToday.Clear();
        this.link = Link.Off;
        this.helloId = null;
        foreach (PendingTalk p in this.pending.Values)
            p.Reply.TrySetResult(null);
        this.pending.Clear();
    }

    /// <summary>Save loaded (screen 0). A farmhand asks the host's mod whether it is there.</summary>
    public void OnSaveLoaded()
    {
        this.Reset();
        if (Context.IsOnHostComputer)
            return;
        this.link = Link.Waiting;
        this.helloId = this.NewId();
        this.helloDeadline = DateTime.UtcNow.AddSeconds(HelloTimeoutSeconds);
        this.SendToHost(new HelloMessage(this.helloId, this.version), HelloType);
    }

    /// <summary>Host: a new day, new per-farmhand event budgets.</summary>
    public void OnDayEnding() => this.eventsToday.Clear();

    public void OnUpdateTicked()
    {
        if (Context.IsMainPlayer)
        {
            this.HandleInbox();
            this.AnswerRelayedTalk();
        }
        else if (!Context.IsOnHostComputer)
        {
            this.ExpireWaits();
        }
    }

    /// <summary>
    /// Farmhand: ask the host for a talk reply. Completes with null after TimeoutSeconds or when
    /// the host has none; the caller then runs vanilla checkAction.
    /// </summary>
    public Task<TalkResponse?> Talk(TalkRequest req)
    {
        if (!this.Ready)
            return Task.FromResult<TalkResponse?>(null);
        string id = this.NewId();
        var p = new PendingTalk(new TaskCompletionSource<TalkResponse?>(TaskCreationOptions.RunContinuationsAsynchronously), DateTime.UtcNow.AddSeconds(this.timeoutSeconds));
        this.pending[id] = p;
        this.SendToHost(new TalkRelayRequest(id, req), TalkReqType);
        return p.Reply.Task;
    }

    /// <summary>Farmhand: one event, sent as it happens. Not sent when the host has no matching mod.</summary>
    public void SendEvent(DayEvent ev)
    {
        if (this.Ready)
            this.SendToHost(new EventRelay(ev), EventType);
    }

    /// <summary>Host: plan parts for one farmhand. Called from the main player's tick.</summary>
    public void SendApply(long farmerId, FarmerApply apply) =>
        this.helper.Multiplayer.SendMessage(apply, FarmerApplyType, new[] { this.modId }, new[] { farmerId });

    private void OnMessage(object? sender, ModMessageReceivedEventArgs e)
    {
        if (e.FromModID != this.modId || !Context.IsWorldReady)
            return;
        // A split-screen player on the host computer has nothing to receive: it talks to the
        // brain itself and its plan parts are queued on this computer.
        if (Context.IsMainPlayer)
            this.Receive(e);
        else if (!Context.IsOnHostComputer)
            this.OnFarmhandMessage(e);
    }

    private void Forget(long farmerId)
    {
        this.greeted.Remove(farmerId);
        this.relayed.Remove(farmerId);
    }

    // ---- host computer ----

    private void Receive(ModMessageReceivedEventArgs e)
    {
        long from = e.FromPlayerID;
        // Only farmers in this game; the sender is the id SMAPI reports, never one from the payload.
        if (!Game1.otherFarmers.ContainsKey(from))
        {
            this.monitor.Log($"Ignored {e.Type} from player {from}: not a farmer in this game.", LogLevel.Trace);
            return;
        }
        if (this.inbox.Count(m => m.From == from) >= MaxInboxPerFarmhand)
            return;
        object? payload = e.Type switch
        {
            HelloType => this.Read<HelloMessage>(e),
            TalkReqType => this.Read<TalkRelayRequest>(e),
            EventType => this.Read<EventRelay>(e),
            _ => null,
        };
        if (payload is not null)
            this.inbox.Add(new Incoming(from, payload));
    }

    private void HandleInbox()
    {
        List<Incoming> batch = this.inbox.ToList();
        this.inbox.Clear();
        foreach (Incoming m in batch)
        {
            // The farmer may have left since the message arrived.
            if (!Game1.otherFarmers.TryGetValue(m.From, out Farmer? farmer))
                continue;
            switch (m.Payload)
            {
                case HelloMessage hello when ValidId(hello.RequestId):
                    this.OnHello(m.From, farmer, hello);
                    break;
                case TalkRelayRequest { Request: not null } req when ValidId(req.RequestId) && this.greeted.Contains(m.From):
                    this.OnTalkRequest(m.From, farmer, req);
                    break;
                case EventRelay { Event: not null } ev when this.greeted.Contains(m.From):
                    this.OnEvent(m.From, farmer, ev.Event);
                    break;
            }
        }
    }

    private void OnHello(long from, Farmer farmer, HelloMessage hello)
    {
        this.helper.Multiplayer.SendMessage(new HelloMessage(hello.RequestId, this.version), HelloType, new[] { this.modId }, new[] { from });
        if (hello.Version == this.version)
        {
            this.greeted.Add(from);
            this.monitor.Log($"{farmer.Name} joined with Townsfolk {hello.Version}; their talk goes through this brain.", LogLevel.Info);
        }
        else
        {
            this.greeted.Remove(from);
            this.monitor.Log($"{farmer.Name} runs Townsfolk {hello.Version}, this host runs {this.version}; their game stays vanilla.", LogLevel.Info);
        }
    }

    private void OnTalkRequest(long from, Farmer farmer, TalkRelayRequest msg)
    {
        // The host's own config decides who is voiced, whatever the farmhand's config says.
        bool voiced = Game1.getCharacterFromName(msg.Request.Npc) is { } npc && this.isEnabled(npc);
        if (!voiced || this.relayed.ContainsKey(from))
        {
            this.Reply(from, msg.RequestId, null);
            return;
        }
        // Who is talking, how close they are, what they have seen and the day all come from the
        // host's own copy of that farmer and game. The payload only supplies the NPC and the
        // conversation so far (transcript, picked reply, joined today).
        TalkRequest req = msg.Request with
        {
            SaveId = Constants.SaveFolderName ?? "unknown",
            Day = ModEntry.Today(farmer),
            Stats = ModEntry.ReadStats(farmer),
            EventsSeen = ModEntry.EventsSeen(farmer),
            Friendship = new FriendshipInfo(farmer.getFriendshipHeartLevelForNPC(msg.Request.Npc), farmer.getFriendshipLevelForNPC(msg.Request.Npc)),
            PlayerName = ModEntry.FarmerName(farmer),
            FarmerId = ModEntry.FarmerId(farmer),
            FarmerName = ModEntry.FarmerName(farmer),
        };
        this.relayed[from] = new RelayedTalk(msg.RequestId, this.brain.Talk(req));
    }

    private void AnswerRelayedTalk()
    {
        foreach ((long to, RelayedTalk t) in this.relayed.Where(kv => kv.Value.Reply.IsCompleted).ToList())
        {
            this.relayed.Remove(to);
            this.Reply(to, t.RequestId, t.Reply.Status == TaskStatus.RanToCompletion ? t.Reply.Result : null);
        }
    }

    private void Reply(long to, string requestId, TalkResponse? reply) =>
        this.helper.Multiplayer.SendMessage(new TalkRelayResponse(requestId, reply), TalkRespType, new[] { this.modId }, new[] { to });

    private void OnEvent(long from, Farmer farmer, DayEvent ev)
    {
        this.eventsToday.TryGetValue(from, out int count);
        if (count >= MaxEventsPerFarmhand)
            return;
        if (RelayRules.Clean(ev, ModEntry.ProtocolName.IsMatch, ModEntry.MaxWitnesses) is not { } clean)
        {
            this.monitor.Log($"Dropped a {ev.Type} event from {farmer.Name}: outside the day-end protocol.", LogLevel.Debug);
            return;
        }
        this.eventsToday[from] = count + 1;
        this.addEvent(clean with { FarmerId = ModEntry.FarmerId(farmer), FarmerName = ModEntry.FarmerName(farmer) });
    }

    // ---- farmhand ----

    private void OnFarmhandMessage(ModMessageReceivedEventArgs e)
    {
        // Only the host speaks to a farmhand's mod.
        if (e.FromPlayerID != Game1.MasterPlayer.UniqueMultiplayerID)
            return;
        switch (e.Type)
        {
            case HelloType when this.link == Link.Waiting && this.Read<HelloMessage>(e) is { } hello && hello.RequestId == this.helloId:
                this.link = hello.Version == this.version ? Link.Ready : Link.Vanilla;
                this.monitor.Log(
                    this.Ready
                        ? $"The host runs Townsfolk {hello.Version}; talk goes through the host's brain."
                        : $"The host runs Townsfolk {hello.Version}, this game runs {this.version}; vanilla dialogue for this session.",
                    LogLevel.Info);
                break;
            case TalkRespType when this.Read<TalkRelayResponse>(e) is { RequestId: not null } resp && this.pending.Remove(resp.RequestId, out PendingTalk? p):
                p.Reply.TrySetResult(resp.Response is { } r && BrainClient.IsUsable(r) ? r : null);
                break;
            case FarmerApplyType when this.Read<FarmerApply>(e) is { } apply:
                this.applyLocal(apply);
                break;
        }
    }

    private void ExpireWaits()
    {
        DateTime now = DateTime.UtcNow;
        if (this.link == Link.Waiting && now > this.helloDeadline)
        {
            this.link = Link.Vanilla;
            this.monitor.Log($"The host did not answer within {HelloTimeoutSeconds} s (no Townsfolk mod there); vanilla dialogue for this session.", LogLevel.Info);
        }
        foreach ((string id, PendingTalk p) in this.pending.Where(kv => now > kv.Value.Deadline).ToList())
        {
            this.pending.Remove(id);
            p.Reply.TrySetResult(null);
        }
    }

    private void SendToHost<T>(T message, string type) =>
        this.helper.Multiplayer.SendMessage(message, type, new[] { this.modId }, new[] { Game1.MasterPlayer.UniqueMultiplayerID });

    private string NewId() => (++this.nextId).ToString(CultureInfo.InvariantCulture);

    private static bool ValidId(string? id) => !string.IsNullOrEmpty(id) && id.Length <= MaxRequestId;

    // A payload SMAPI cannot read as T (another build, a broken peer) is ignored like an unknown type.
    private T? Read<T>(ModMessageReceivedEventArgs e) where T : class
    {
        try
        {
            return e.ReadAs<T>();
        }
        catch (Exception ex)
        {
            this.monitor.Log($"Ignored an unreadable {e.Type} from player {e.FromPlayerID}: {ex.GetType().Name}.", LogLevel.Debug);
            return null;
        }
    }

    private enum Link { Off, Waiting, Ready, Vanilla }

    private sealed record Incoming(long From, object Payload);

    private sealed record RelayedTalk(string RequestId, Task<TalkResponse?> Reply);

    private sealed record PendingTalk(TaskCompletionSource<TalkResponse?> Reply, DateTime Deadline);
}
