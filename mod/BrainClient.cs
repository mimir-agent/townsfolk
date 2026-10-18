using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Townsfolk;

// Wire protocol v1. protocol/*.schema.json is the source; these records mirror it
// (camelCase on the wire). Every request and response carries V = 1.
public sealed record DayRef(string Season, int Day, int Year);
public sealed record GameDay(string Season, int Day, int Year, int Time, string Weather, string Location);
public sealed record FriendshipInfo(int Hearts, int Points);
public sealed record TranscriptLine(string Speaker, string Text);
/// <summary>The reply the player just picked, as sent back in the next talk request.</summary>
public sealed record Choice(string Id, string Text);

/// <summary>Something the NPC remembers from a picked reply. Shareable false means told in confidence.</summary>
public sealed record TalkFact(string Text, bool Shareable);

/// <summary>
/// A reply option. Delta is the friendship points to add on pick (the brain caps it at +-15).
/// Join is true on the one join choice; its delta goes to every happening participant.
/// </summary>
public sealed record TalkChoice(string Id, string Text, int Delta, TalkFact? Fact = null, bool? Join = null);

/// <summary>The happening a join choice is about. Present only when a join choice is offered.</summary>
public sealed record HappeningView(string Location, string Topic, List<string> Participants);

/// <summary>Every stat the bridge can read. The brain decides which ones each NPC may know.</summary>
public sealed record GameStats(
    string? FarmName,
    int? DaysPlayed,
    int? CommunityCenterRooms,
    int? DeepestMineLevel,
    List<string>? FarmBuildings,
    int? Money);

public sealed record TalkRequest(
    string SaveId,
    string Npc,
    string PlayerName,
    GameDay Day,
    FriendshipInfo Friendship,
    Choice? RecentChoice,
    List<TranscriptLine> Transcript,
    GameStats Stats,
    bool? Joined,
    List<string> EventsSeen)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

public sealed record TalkResponse(int V, string Line, List<TalkChoice> Choices, bool End, string Source, HappeningView? Happening = null);

/// <summary>
/// Npc took part. Witnesses are the other villagers in the same location at the time; for a
/// join, the other happening participants only.
/// </summary>
public sealed record DayEvent(
    string Type,
    string Npc,
    string Location,
    int Time,
    List<string> Witnesses,
    string? NpcLine = null,
    string? PlayerChoice = null,
    string? Item = null,
    string? Taste = null,
    TalkFact? Fact = null,
    string? Topic = null,
    string? Reason = null);

/// <summary>NPCs seen on the same map at the same time today. Gossip passes between them overnight.</summary>
public sealed record Together(string Location, List<string> Npcs);

public sealed record DayEndRequest(string SaveId, string PlayerName, GameDay Day, List<DayEvent> Events, List<Together> Together)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

public sealed record SavedRequest(string SaveId, DayRef Day)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

public sealed record WorldLocation(string Name, int Width, int Height);
public sealed record WorldItem(string Id, string Name);
public sealed record WorldFestival(string Season, int Day, string Name);

/// <summary>Sent at save load: what the brain's plan validator checks every plan against.</summary>
public sealed record WorldRequest(string SaveId, List<WorldLocation> Locations, List<WorldItem> Items, List<WorldFestival> Festivals, List<string> Married)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

/// <summary>Asks for the plan for Day, the day about to start.</summary>
public sealed record PlanRequest(string SaveId, string PlayerName, DayRef Day, GameStats Stats, List<string> EventsSeen)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

/// <summary>Sets off at Time for tile (X, Y) of Location, facing 0 up, 1 right, 2 down, 3 left.</summary>
public sealed record PlanStop(int Time, string Location, int X, int Y, int Facing);
public sealed record PlannedSchedule(string Npc, List<PlanStop> Stops);
public sealed record MailQuest(string Id, string Item, string From, int Reward, string Text);
public sealed record FriendshipShift(string Npc, int Delta, string Reason);
public sealed record DroppedPart(string Part, string Reason);

/// <summary>
/// The parts of a plan response the bridge applies. Goals, happening and relationships stay on
/// the brain side (talk reads them from the brain's own plan store), so they are not mirrored here.
/// </summary>
public sealed record PlanResponse(
    int V,
    DayRef Day,
    string Source,
    List<PlannedSchedule> Schedules,
    MailQuest? Quest,
    List<FriendshipShift> Friendship,
    List<DroppedPart> Dropped);

/// <summary>HTTP client for the brain. Every method returns null or false on failure and never throws.</summary>
public sealed class BrainClient
{
    public const int ProtocolVersion = 1;

    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly HttpClient http;
    // The plan takes minutes with a real model, so it has its own client and its own timeout.
    private readonly HttpClient planHttp;
    private readonly Action<string> log;

    public BrainClient(string baseUrl, int timeoutSeconds, int planTimeoutSeconds, Action<string> log)
    {
        var baseAddress = new Uri(baseUrl.TrimEnd('/') + "/");
        this.http = new HttpClient { BaseAddress = baseAddress, Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        this.planHttp = new HttpClient { BaseAddress = baseAddress, Timeout = TimeSpan.FromSeconds(planTimeoutSeconds) };
        this.log = log;
    }

    public async Task<TalkResponse?> Talk(TalkRequest req)
    {
        try
        {
            string? body = await this.Post("v1/talk", req, this.http);
            if (body is null)
                return null;
            TalkResponse? res = JsonSerializer.Deserialize<TalkResponse>(body, Json);
            // A brain that answers in another protocol version is treated as down.
            if (res is null || res.V != ProtocolVersion || string.IsNullOrWhiteSpace(res.Line) || res.Choices is null)
            {
                this.log($"brain /v1/talk returned an unusable body: {Truncate(body)}");
                return null;
            }
            return res;
        }
        catch (Exception ex)
        {
            this.log($"brain /v1/talk failed: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    public Task<bool> DayEnd(DayEndRequest req) => this.PostOk("v1/day-end", req);

    public Task<bool> Saved(SavedRequest req) => this.PostOk("v1/saved", req);

    public Task<bool> World(WorldRequest req) => this.PostOk("v1/world", req);

    public async Task<PlanResponse?> Plan(PlanRequest req)
    {
        try
        {
            string? body = await this.Post("v1/plan", req, this.planHttp);
            if (body is null)
                return null;
            PlanResponse? res = JsonSerializer.Deserialize<PlanResponse>(body, Json);
            if (res is null || res.V != ProtocolVersion || res.Day is null || res.Schedules is null || res.Friendship is null || res.Dropped is null)
            {
                this.log($"brain /v1/plan returned an unusable body: {Truncate(body)}");
                return null;
            }
            return res;
        }
        catch (Exception ex)
        {
            this.log($"brain /v1/plan failed: {ex.GetType().Name}: {ex.Message}");
            return null;
        }
    }

    private async Task<bool> PostOk<T>(string path, T payload)
    {
        try
        {
            return await this.Post(path, payload, this.http) is not null;
        }
        catch (Exception ex)
        {
            this.log($"brain /{path} failed: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    // Any non-2xx (including the 400 a version mismatch gets) is logged and returns null: brain down.
    private async Task<string?> Post<T>(string path, T payload, HttpClient client)
    {
        using var content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
        using HttpResponseMessage res = await client.PostAsync(path, content);
        string body = await res.Content.ReadAsStringAsync();
        if (!res.IsSuccessStatusCode)
        {
            this.log($"brain {path} HTTP {(int)res.StatusCode}: {Truncate(body)}");
            return null;
        }
        return body;
    }

    private static string Truncate(string s) => s.Length <= 300 ? s : s[..300];
}
