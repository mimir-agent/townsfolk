using System;
using System.Collections.Generic;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

namespace Townsfolk;

// Wire protocol v1. Field names match brain/src/protocol.ts (camelCase on the wire).
public sealed record GameDay(string Season, int Day, int Year, int Time, string Weather, string Location);
public sealed record FriendshipInfo(int Hearts, int Points);
public sealed record TranscriptLine(string Speaker, string Text);
public sealed record Choice(string Id, string Text);

public sealed record TalkRequest(
    string SaveId,
    string Npc,
    string PlayerName,
    GameDay Day,
    FriendshipInfo Friendship,
    Choice? RecentChoice,
    List<TranscriptLine> Transcript);

public sealed record TalkResponse(string Line, List<Choice> Choices, bool End, string Source);

public sealed record DayEvent(
    string Type,
    string Npc,
    string Location,
    int Time,
    string? NpcLine = null,
    string? PlayerChoice = null,
    string? Item = null,
    string? Taste = null);

public sealed record DayEndRequest(string SaveId, string PlayerName, GameDay Day, List<DayEvent> Events);

/// <summary>HTTP client for the brain. Every method returns null or false on failure and never throws.</summary>
public sealed class BrainClient
{
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
            if (res is null || string.IsNullOrWhiteSpace(res.Line) || res.Choices is null)
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

    public async Task<bool> DayEnd(DayEndRequest req)
    {
        try
        {
            return await this.Post("v1/day-end", req) is not null;
        }
        catch (Exception ex)
        {
            this.log($"brain /v1/day-end failed: {ex.GetType().Name}: {ex.Message}");
            return false;
        }
    }

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
