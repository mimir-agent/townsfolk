using System.Collections.Generic;
using System.IO;
using System.Threading.Tasks;
using Townsfolk;
using Xunit;

// v0.1.3: reading a streamed /v1/talk body (BrainClient.ReadTalkStream).
public class TalkStreamTests
{
    private const string Reply = "{\"v\":1,\"line\":\"Hey there.\",\"choices\":[],\"end\":true,\"source\":\"model\"}";

    private static async Task<(string? body, List<string> lines)> Read(string text)
    {
        var lines = new List<string>();
        string? body = await BrainClient.ReadTalkStream(new StringReader(text), lines.Add);
        return (body, lines);
    }

    [Fact]
    public async Task Partial_line_first_then_the_whole_reply()
    {
        var (body, lines) = await Read("{\"v\":1,\"partial\":true,\"line\":\"Hey there.\"}\n" + Reply + "\n");
        Assert.Equal(new[] { "Hey there." }, lines);
        Assert.Equal(Reply, body);
    }

    [Fact]
    public async Task A_plain_json_body_is_the_reply_and_no_line_is_passed_early()
    {
        var (body, lines) = await Read(Reply);
        Assert.Empty(lines);
        Assert.Equal(Reply, body);
    }

    [Fact]
    public async Task A_body_cut_off_after_the_partial_has_no_reply()
    {
        var (body, lines) = await Read("{\"v\":1,\"partial\":true,\"line\":\"Hey there.\"}\n");
        Assert.Single(lines);
        Assert.Null(body);
    }

    [Fact]
    public async Task Only_one_partial_is_taken_and_a_wrong_version_partial_is_not_a_line()
    {
        var (_, lines) = await Read("{\"v\":2,\"partial\":true,\"line\":\"no\"}\n" + Reply + "\n");
        Assert.Empty(lines);
    }
}
