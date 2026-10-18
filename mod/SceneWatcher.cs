using System;
using System.Collections.Generic;
using System.Linq;
using StardewModdingAPI;
using StardewModdingAPI.Utilities;
using StardewValley;

namespace Townsfolk;

/// <summary>
/// Watches the game's own scripted events (cutscenes, heart events, festivals) and, when one
/// ends, records one "scene" day event for the farmer on this screen who watched it
/// (brain/src/scenes.ts). Read-only by rule (spec-v2 section 3): this class reads Game1, Event,
/// NPC and Farmer members and never assigns to one, has no Harmony patch, and suppresses no
/// input. The game runs every event exactly as it would without this mod.
/// Per screen: each split-screen player watches their own events. The event goes through the
/// same path as a talk or gift (ModEntry.AddOwnEvent): on the host computer it joins the day's
/// events; a farmhand sends it to the host as townsfolk.event and the host stamps the sender.
/// </summary>
public sealed class SceneWatcher
{
    // Same alphabet as "eventId" in protocol/common.schema.json. An id outside it (another mod's)
    // is not recorded; the brain would refuse the whole day for it.
    private static readonly System.Text.RegularExpressions.Regex EventId =
        new(@"^[A-Za-z0-9_.-]{1,60}$", System.Text.RegularExpressions.RegexOptions.CultureInvariant);
    private const int MaxLocation = 80;

    private readonly IMonitor monitor;
    private readonly Action<DayEvent> record;
    private readonly PerScreen<Watching?> watching = new();

    /// <summary>One event in progress: what was noted when it appeared, and every villager actor seen in it so far, in order.</summary>
    private sealed class Watching
    {
        public Watching(Event ev, string id, string location, bool festival, int time)
        {
            this.Event = ev;
            this.Id = id;
            this.Location = location;
            this.Festival = festival;
            this.Time = time;
        }

        public Event Event { get; }
        public string Id { get; }
        public string Location { get; }
        public bool Festival { get; }
        public int Time { get; }
        public List<string> Actors { get; } = new();
    }

    public SceneWatcher(IMonitor monitor, Action<DayEvent> record)
    {
        this.monitor = monitor;
        this.record = record;
    }

    /// <summary>Forget an event in progress without recording it (return to title, save load).</summary>
    public void Reset() => this.watching.Value = null;

    /// <summary>Game thread, every tick, every screen.</summary>
    public void OnUpdateTicked()
    {
        Event? now = Context.IsWorldReady ? Game1.CurrentEvent : null;
        Watching? w = this.watching.Value;
        if (w is not null && !ReferenceEquals(w.Event, now))
        {
            this.Finish(w);
            this.watching.Value = w = null;
        }
        if (now is null)
            return;
        if (w is null)
        {
            w = Start(now);
            this.watching.Value = w;
            if (w is null)
                return;
        }
        // Actors can join partway through a scene, so the list grows every tick until it ends.
        foreach (NPC actor in now.actors)
        {
            if (w.Actors.Count > ModEntry.MaxWitnesses)
                break;
            if (!w.Actors.Contains(actor.Name) && IsVillager(actor.Name))
                w.Actors.Add(actor.Name);
        }
    }

    /// <summary>A day can end while an event is still up (a night festival). Record it before the day is sent.</summary>
    public void OnDayEnding()
    {
        if (this.watching.Value is { } w)
            this.Finish(w);
        this.watching.Value = null;
    }

    // Null when this event cannot be recorded; it is then ignored until it ends.
    private Watching? Start(Event ev)
    {
        string? location = Game1.currentLocation?.Name;
        if (ev.id is null || !EventId.IsMatch(ev.id) || location is null || location.Length > MaxLocation)
        {
            this.monitor.Log($"Scene {ev.id ?? "(no id)"} at {location ?? "(no location)"} is outside the protocol; not remembered.", LogLevel.Trace);
            return null;
        }
        return new Watching(ev, ev.id, location, ev.isFestival, Math.Clamp(Game1.timeOfDay, 600, 2600));
    }

    private void Finish(Watching w)
    {
        // A scene with no villager in it (a farm animal, a lone farmer) leaves nobody to remember it.
        if (w.Actors.Count == 0)
            return;
        var witnesses = w.Actors.Skip(1).Take(ModEntry.MaxWitnesses).ToList();
        this.record(new DayEvent("scene", w.Actors[0], w.Location, w.Time, witnesses, EventId: w.Id, Festival: w.Festival));
        this.monitor.Log($"Scene {w.Id} at {w.Location}{(w.Festival ? " (festival)" : "")} with {string.Join(", ", w.Actors)}.", LogLevel.Debug);
    }

    // Event actors are copies placed for the scene. The name counts only when it is a villager in
    // the world (event-only actors are not looked up), so no made-up name becomes a memory file.
    private static bool IsVillager(string name) =>
        ModEntry.ProtocolName.IsMatch(name) && Game1.getCharacterFromName(name) is { IsVillager: true };
}
