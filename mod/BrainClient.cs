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
public sealed record Choice(string Id, string Text);

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
    GameStats Stats)
{
    public int V { get; init; } = BrainClient.ProtocolVersion;
}

public sealed record TalkResponse(int V, string Line, List<Choice> Choices, bool End, string Source);

/// <summary>Npc took part. Witnesses are the other villagers in the same location at the time.</summary>
public sealed record DayEvent(
    string Type,
    string Npc,
    string Location,
    int Time,
    List<string> Witnesses,
    string? NpcLine = null,
    string? PlayerChoice = null,
    string? Item = null,
    string? Taste = null);

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
    private readonly Action<string> log;

    public BrainClient(string baseUrl, int timeoutSeconds, Action<string> log)
    {
        this.http = new HttpClient { BaseAddress = new Uri(baseUrl.TrimEnd('/') + "/"), Timeout = TimeSpan.FromSeconds(timeoutSeconds) };
        this.log = log;
    }

    public async Task<TalkResponse?> Talk(TalkRequest req)
    {
        try
        {
            string? body = await this.Post("v1/talk", req);
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

    private async Task<bool> PostOk<T>(string path, T payload)
    {
        try
        {
            return await this.Post(path, payload) is not null;
        }
        catch (Exception ex)
        {
            this.log($"brain /{path} failed: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

    // Any non-2xx (including the 400 a version mismatch gets) is logged and returns null: brain down.
    private async Task<string?> Post<T>(string path, T payload)
    {
        using var content = new StringContent(JsonSerializer.Serialize(payload, Json), Encoding.UTF8, "application/json");
        using HttpResponseMessage res = await this.http.PostAsync(path, content);
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
