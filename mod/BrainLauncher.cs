using System;
using System.Diagnostics;
using System.IO;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using StardewModdingAPI;

namespace Townsfolk;

/// <summary>
/// Host computer only. When a save loads and nothing answers on the brain's port, starts the
/// bundled brain (node on brain/start.mjs, no window, output to brain.log next to the mod) and
/// stops it again when the game quits. A brain the player started by hand is left alone.
/// </summary>
public sealed class BrainLauncher : IDisposable
{
    private const int StartupSeconds = 30;

    private readonly IMonitor monitor;
    private readonly string modDir;
    private readonly string brainUrl;
    private readonly string? nodePath;
    private readonly HttpClient probe = new() { Timeout = TimeSpan.FromSeconds(2) };
    private readonly object gate = new();
    private Process? child;
    private StreamWriter? logFile;
    private Task? starting;

    public BrainLauncher(IMonitor monitor, string modDir, string brainUrl, string? nodePath)
    {
        this.monitor = monitor;
        this.modDir = modDir;
        this.brainUrl = brainUrl;
        this.nodePath = nodePath;
        AppDomain.CurrentDomain.ProcessExit += (_, _) => this.Dispose();
    }

    /// <summary>
    /// Completes once a brain answers /v1/health, or once it is clear none will (logged). Never
    /// throws and never blocks the game thread. Asked again, it reuses a start that is still
    /// running and starts a new brain only if ours has died.
    /// </summary>
    public Task EnsureRunning()
    {
        lock (this.gate)
        {
            if (this.starting is null || (this.starting.IsCompleted && !this.IsOurs))
                this.starting = Task.Run(this.Start);
            return this.starting;
        }
    }

    private bool IsOurs => this.child is { HasExited: false };

    /// <summary>True when the brain answering now is the one this launcher started.</summary>
    public bool OwnsRunningBrain
    {
        get
        {
            lock (this.gate)
                return this.IsOurs;
        }
    }

    /// <summary>Stops the brain this launcher started and starts it again. Only for a brain it owns (OwnsRunningBrain).</summary>
    public Task Restart()
    {
        this.Dispose();
        lock (this.gate)
        {
            this.starting = Task.Run(this.Start);
            return this.starting;
        }
    }

    private async Task Start()
    {
        try
        {
            if (await this.Healthy())
            {
                if (!this.IsOurs)
                    this.monitor.Log("A brain is already answering; not starting another.", LogLevel.Info);
                return;
            }
            if (!Uri.TryCreate(this.brainUrl, UriKind.Absolute, out Uri? uri) || !uri.IsLoopback)
            {
                this.monitor.Log($"BrainUrl {this.brainUrl} is not on this computer; the brain is not started by the mod.", LogLevel.Warn);
                return;
            }
            string script = Path.Combine(this.modDir, "brain", "start.mjs");
            if (!File.Exists(script))
            {
                this.monitor.Log($"No bundled brain at {script}; start the brain by hand (start-brain.cmd or start-brain.sh).", LogLevel.Warn);
                return;
            }

            bool windows = RuntimeInformation.IsOSPlatform(OSPlatform.Windows);
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            var extra = NodeLocator.ExtraDirs(windows, home, Environment.GetEnvironmentVariable("ProgramFiles"), Environment.GetEnvironmentVariable("APPDATA"));
            string? pathVar = Environment.GetEnvironmentVariable("PATH");
            string? node = NodeLocator.Find(this.nodePath, pathVar, windows, extra, File.Exists);
            if (node is null)
            {
                this.monitor.Log(
                    string.IsNullOrWhiteSpace(this.nodePath)
                        ? "Node.js 24 or newer was not found, so the brain was not started. Install it from https://nodejs.org, or set NodePath in config.json, or start the brain by hand."
                        : $"NodePath {this.nodePath} does not exist, so the brain was not started.",
                    LogLevel.Warn);
                return;
            }

            var info = new ProcessStartInfo(node)
            {
                WorkingDirectory = Path.GetDirectoryName(script)!,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            info.ArgumentList.Add(script);
            info.Environment["TOWNSFOLK_PORT"] = uri.Port.ToString();
            // The brain exits by itself if the game is killed and cannot stop it.
            info.Environment["TOWNSFOLK_PARENT_PID"] = Environment.ProcessId.ToString();
            info.Environment["PATH"] = NodeLocator.AugmentedPath(pathVar, windows, Path.GetDirectoryName(node) ?? "", extra);

            string logPath = Path.Combine(this.modDir, "brain.log");
            this.logFile = new StreamWriter(new FileStream(logPath, FileMode.Create, FileAccess.Write, FileShare.ReadWrite)) { AutoFlush = true };
            Process p = new() { StartInfo = info, EnableRaisingEvents = true };
            p.OutputDataReceived += (_, e) => this.WriteLog(e.Data);
            p.ErrorDataReceived += (_, e) => this.WriteLog(e.Data);
            p.Exited += (_, _) => this.monitor.Log("The brain stopped.", LogLevel.Debug);
            p.Start();
            p.BeginOutputReadLine();
            p.BeginErrorReadLine();
            this.child = p;
            this.monitor.Log($"Started the brain (node {node}); its log is {logPath}.", LogLevel.Info);

            for (int i = 0; i < StartupSeconds * 4 && !p.HasExited; i++)
            {
                if (await this.Healthy())
                    return;
                await Task.Delay(250);
            }
            this.monitor.Log(p.HasExited
                ? $"The brain exited right after starting. See {logPath}."
                : $"The brain did not answer within {StartupSeconds} s. See {logPath}.", LogLevel.Warn);
        }
        catch (Exception ex)
        {
            this.monitor.Log($"Could not start the brain: {ex.GetType().Name}: {ex.Message}", LogLevel.Warn);
        }
    }

    private async Task<bool> Healthy()
    {
        try
        {
            using HttpResponseMessage res = await this.probe.GetAsync(new Uri(new Uri(this.brainUrl), "v1/health"));
            return res.IsSuccessStatusCode;
        }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException)
        {
            return false;
        }
    }

    private void WriteLog(string? line)
    {
        if (line is null)
            return;
        lock (this.gate)
            this.logFile?.WriteLine(line);
    }

    /// <summary>Stops the brain this launcher started, and with it the claude processes it started. A brain started by hand is not touched.</summary>
    public void Dispose()
    {
        Process? p;
        lock (this.gate)
        {
            p = this.child;
            this.child = null;
        }
        try
        {
            if (p is { HasExited: false })
            {
                p.Kill(entireProcessTree: true);
                // Restart starts a new brain on the same port right after this.
                p.WaitForExit(3000);
            }
        }
        catch (Exception ex)
        {
            this.monitor.Log($"Could not stop the brain: {ex.Message}", LogLevel.Debug);
        }
        lock (this.gate)
        {
            this.logFile?.Dispose();
            this.logFile = null;
        }
    }
}
