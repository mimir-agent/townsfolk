using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Townsfolk;
using Xunit;

// v0.1.2: what the mod says at save load and on each failed talk (mod/BrainCheck.cs), and the
// health call itself against a stand-in brain on a local port (no game, no model).
public class BrainCheckTests
{
    private const string Url = "http://127.0.0.1:7341";

    [Fact]
    public void A_ready_brain_of_the_same_version_gives_no_notice() =>
        Assert.Null(BrainCheck.AtLoad(new HealthResponse(1, true, "claude-cli", "0.1.2", true), "0.1.2", Url));

    [Fact]
    public void A_brain_that_does_not_answer_is_reported_on_the_HUD()
    {
        BrainNotice n = BrainCheck.AtLoad(null, "0.1.2", Url)!;
        Assert.Contains("did not answer at http://127.0.0.1:7341", n.Log);
        Assert.Contains("not running", n.Hud);
    }

    [Fact]
    public void A_brain_older_than_0_1_2_reports_no_version_and_is_named_as_old()
    {
        BrainNotice n = BrainCheck.AtLoad(new HealthResponse(1, true, "claude-cli"), "0.1.2", Url)!;
        Assert.Equal("A brain from version older than 0.1.2 is already running on port 7341; this mod is 0.1.2. Stop it (close its window, or end the node process) and reload the save.", n.Log);
        Assert.Contains("old brain", n.Hud);
    }

    [Fact]
    public void A_brain_of_another_version_is_named_with_its_version_and_the_port()
    {
        BrainNotice n = BrainCheck.AtLoad(new HealthResponse(1, true, "claude-cli", "0.1.3", true), "0.1.2", "http://127.0.0.1:7999")!;
        Assert.StartsWith("A brain from version 0.1.3 is already running on port 7999;", n.Log);
    }

    [Fact]
    public void A_brain_that_is_not_ready_passes_its_reason_to_the_HUD()
    {
        const string why = "Claude Code is not logged in. Open a terminal, run \"claude\", log in, then restart the game.";
        BrainNotice n = BrainCheck.AtLoad(new HealthResponse(1, true, "claude-cli", "0.1.2", false, why), "0.1.2", Url)!;
        Assert.Equal("Townsfolk: " + why, n.Hud);
        Assert.Contains(why, n.Log);
    }

    [Fact]
    public void A_version_mismatch_is_reported_before_readiness() =>
        Assert.Contains("0.1.3", BrainCheck.AtLoad(new HealthResponse(1, true, "x", "0.1.3", false, "not logged in"), "0.1.2", Url)!.Log);

    private static TalkResponse Reply(string source, string? reason = null) =>
        new(1, "Hi.", new List<TalkChoice>(), true, source, null, reason);

    [Fact]
    public void A_model_reply_is_not_a_failure() => Assert.Null(BrainCheck.TalkFailure(Reply("model"), false, 25, true));

    [Fact]
    public void A_fallback_passes_on_the_brains_reason() =>
        Assert.Equal("model call failed: spawn claude ENOENT", BrainCheck.TalkFailure(Reply("fallback", "model call failed: spawn claude ENOENT"), false, 25, true));

    [Fact]
    public void A_fallback_from_an_old_brain_says_it_has_no_reason() =>
        Assert.Contains("older than 0.1.2", BrainCheck.TalkFailure(Reply("fallback"), false, 25, true));

    [Theory]
    [InlineData(true, true, "no reply within 25 s")]
    [InlineData(false, true, "the request to the brain failed")]
    [InlineData(false, false, "the host sent no reply")]
    public void No_reply_at_all_says_which_way_it_failed(bool overdue, bool onHost, string expected) =>
        Assert.Equal(expected, BrainCheck.TalkFailure(null, overdue, 25, onHost));

    // A one-shot HTTP server on a free port that answers GET /v1/health with the given body.
    private static async Task<HealthResponse?> HealthFrom(int status, string body)
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        Task serve = Task.Run(async () =>
        {
            using TcpClient c = await listener.AcceptTcpClientAsync();
            NetworkStream s = c.GetStream();
            var buf = new byte[4096];
            await s.ReadAsync(buf);
            byte[] bytes = Encoding.UTF8.GetBytes(body);
            string head = $"HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {bytes.Length}\r\nConnection: close\r\n\r\n";
            await s.WriteAsync(Encoding.ASCII.GetBytes(head));
            await s.WriteAsync(bytes);
        });
        var logs = new List<string>();
        var client = new BrainClient($"http://127.0.0.1:{port}", 5, 5, logs.Add);
        HealthResponse? h = await client.Health();
        await serve;
        listener.Stop();
        return h;
    }

    [Fact]
    public async Task Health_reads_version_ready_and_reason()
    {
        HealthResponse? h = await HealthFrom(200, "{\"v\":1,\"ok\":true,\"model\":\"claude-cli\",\"version\":\"0.1.2\",\"ready\":false,\"reason\":\"not logged in\"}");
        Assert.Equal(new HealthResponse(1, true, "claude-cli", "0.1.2", false, "not logged in"), h);
    }

    [Fact]
    public async Task Health_from_a_0_1_0_brain_has_no_version()
    {
        HealthResponse? h = await HealthFrom(200, "{\"v\":1,\"ok\":true,\"model\":\"claude-cli\"}");
        Assert.NotNull(h);
        Assert.Null(h!.Version);
        Assert.NotNull(BrainCheck.AtLoad(h, "0.1.2", Url));
    }

    [Fact]
    public async Task Health_that_is_not_a_200_is_no_answer() => Assert.Null(await HealthFrom(500, "{\"v\":1,\"error\":\"internal error\"}"));

    [Fact]
    public async Task Health_from_nothing_listening_is_no_answer()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        listener.Stop();
        Assert.Null(await new BrainClient($"http://127.0.0.1:{port}", 2, 2, _ => { }).Health());
    }
}
