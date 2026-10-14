using System.ComponentModel;
using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public class StartupTests
{
    private sealed class MemoryApproved : IStartupApprovedStore
    {
        public Dictionary<(bool, string, string), byte[]> Values { get; } = new();
        public int Writes, Deletes;
        public byte[]? Read(StartupLocation l) => Values.GetValueOrDefault((l.Machine, l.Sub, l.Name))?.ToArray();
        public void Write(StartupLocation l, byte[] value) { Writes++; Values[(l.Machine, l.Sub, l.Name)] = value; }
        public void Delete(StartupLocation l) { Deletes++; Values.Remove((l.Machine, l.Sub, l.Name)); }
    }
    private sealed class Sources : IStartupSources
    {
        public string SystemRoot => @"C:\Windows";
        public IEnumerable<(string, string)> RunValues(string source) => source switch
        {
            "hkcu-run" => [("Discord", "\"C:\\Users\\a\\Discord\\Update.exe\" --processStart Discord.exe"), ("Missing", @"C:\nowhere\x.exe -q")],
            "hklm-run" => [("SecurityHealth", @"%windir%\system32\SecurityHealthSystray.exe"), ("RtkAudUService", "\"C:\\Program Files\\Realtek\\RtkAudUService64.exe\" -background")],
            "hklm-runonce" => [("Once", @"C:\once.exe")],
            _ => [],
        };
        public IEnumerable<(string, string, string)> FolderItems(bool machine) => machine ? [] : [("Tool.lnk", @"C:\Tools\tool.exe", @"C:\Users\a\Startup\Tool.lnk")];
        public IEnumerable<(string, string, bool)> LogonTasks() => [(@"\Updater", @"C:\Updater\u.exe /silent", false)];
        public IEnumerable<(string, string, bool)> StoreTasks() => [("Spotify (SpotifyStartup)", "SpotifyAB.SpotifyMusic_abc", true)];
        public StartupFile Inspect(string path) => path switch
        {
            "" or @"C:\nowhere\x.exe" => new(false, 0, ""),
            _ when path.Contains("Realtek") => new(true, 3_000_000, "Realtek Semiconductor"),
            @"C:\Tools\tool.exe" => new(true, 80_000_000, "Tool Co"),
            _ => new(true, 20_000_000, "Contoso"),
        };
    }

    [Fact]
    public void DecodesAndEncodesLikeTaskManager()
    {
        Assert.True(StartupApproved.Enabled(null));
        Assert.True(StartupApproved.Enabled([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        Assert.True(StartupApproved.Enabled([6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        Assert.False(StartupApproved.Enabled([3, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        Assert.False(StartupApproved.Enabled([7, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8]));
        var when = new DateTime(2026, 10, 15, 12, 0, 0, DateTimeKind.Utc);
        var disabled = StartupApproved.EncodeDisabled(when);
        Assert.Equal(12, disabled.Length);
        Assert.Equal(3, disabled[0]);
        Assert.Equal(when.ToFileTimeUtc(), BitConverter.ToInt64(disabled, 4));
        Assert.Equal(new byte[12] { 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 }, StartupApproved.EncodeEnabled());
        Assert.Equal("030000000000000000000000", StartupApproved.Hex([3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
        Assert.Null(StartupApproved.Hex(null));
    }

    [Theory]
    [InlineData("hkcu-run|Discord", false, "Run", "Discord")]
    [InlineData("hklm-run|A|B", true, "Run", "A|B")]
    [InlineData("hklm-run32|X", true, "Run32", "X")]
    [InlineData("hkcu-folder|Tool.lnk", false, "StartupFolder", "Tool.lnk")]
    [InlineData("hklm-folder|Tool.lnk", true, "StartupFolder", "Tool.lnk")]
    public void MapsEachSourceToItsStartupApprovedKey(string id, bool machine, string sub, string name) => Assert.Equal(new StartupLocation(machine, sub, name), StartupApproved.LocationOf(id));

    [Theory]
    [InlineData("hkcu-runonce|X")]
    [InlineData("task|\\Updater")]
    [InlineData("uwp|X")]
    [InlineData("nobar")]
    [InlineData("hkcu-run|")]
    public void RejectsListedOnlyOrMalformedIds(string id) => Assert.Throws<InvalidOperationException>(() => StartupApproved.LocationOf(id));

    private static readonly StartupLocation User = new(false, "Run", "Discord");
    [Fact]
    public void DisableThenRestoreIsByteIdenticalWhenValueWasAbsent()
    {
        var store = new MemoryApproved();
        var disabled = StartupApproved.Write(store, User, "-", "disable", () => DateTime.UnixEpoch);
        Assert.Equal("applied", disabled.State);
        Assert.False(StartupApproved.Enabled(store.Read(User)));
        var restored = StartupApproved.Write(store, User, disabled.After!, "-");
        Assert.Equal("applied", restored.State);
        Assert.Null(store.Read(User));
    }
    [Fact]
    public void RestoresAnExistingValueExactlyIncludingOddBytes()
    {
        var store = new MemoryApproved();
        byte[] prior = [6, 0, 0, 0, 9, 8, 7, 6, 5, 4, 3, 2];
        store.Values[(false, "Run", "Discord")] = prior;
        var disabled = StartupApproved.Write(store, User, StartupApproved.Hex(prior)!, "disable");
        Assert.Equal("applied", disabled.State);
        Assert.Equal("applied", StartupApproved.Write(store, User, disabled.After!, StartupApproved.Hex(prior)!).State);
        Assert.Equal(prior, store.Read(User));
    }
    [Fact]
    public void ConflictChangesNothingAndRepeatIsAlreadySet()
    {
        var store = new MemoryApproved();
        store.Values[(false, "Run", "Discord")] = [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        // Caller believed it was absent, so enabling must not overwrite what Task Manager wrote.
        var conflict = StartupApproved.Write(store, User, "-", StartupApproved.Hex(StartupApproved.EncodeEnabled())!);
        Assert.Equal("conflict", conflict.State);
        Assert.Equal(0, store.Writes);
        Assert.Equal("already-set", StartupApproved.Write(store, User, "-", "disable").State);
        Assert.Equal(0, store.Writes);
        Assert.Equal("already-set", StartupApproved.Write(new MemoryApproved(), User, "-", "enable").State);
    }
    [Fact]
    public void RefusesMalformedTokens()
    {
        var store = new MemoryApproved();
        Assert.Throws<InvalidOperationException>(() => StartupApproved.Write(store, User, "zz", "disable"));
        Assert.Throws<InvalidOperationException>(() => StartupApproved.Write(store, User, "-", "delete"));
        Assert.Throws<InvalidOperationException>(() => StartupApproved.Write(store, User, "-", "abc"));
    }

    private sealed class Launcher(Func<IReadOnlyList<string>, IElevatedChild?> start) : IElevatedLauncher { public IElevatedChild? Start(IReadOnlyList<string> arguments) => start(arguments); }
    [Fact]
    public void UserItemsNeverPromptAndMachineItemsPromptOnce()
    {
        var store = new MemoryApproved();
        var launcher = new Launcher(_ => throw new Win32Exception(1223));
        Assert.Equal("applied", StartupApproved.Run(new("set", "hkcu-run|Discord", false, "-"), store, launcher, elevated: false).State);
        var declined = StartupApproved.Run(new("set", "hklm-run|Other", false, "-"), store, launcher, elevated: false);
        Assert.Equal("declined", declined.State);
        Assert.Null(store.Read(new(true, "Run", "Other")));
        // Already elevated: written inline, no prompt.
        Assert.Equal("applied", StartupApproved.Run(new("set", "hklm-run|Other", false, "-"), store, launcher, elevated: true).State);
    }
    [Fact]
    public void ElevatedChildChangesNothingWithoutAFreshRequestOrForUserItems()
    {
        var store = new MemoryApproved();
        var dir = Directory.CreateTempSubdirectory();
        try
        {
            var result = Path.Combine(dir.FullName, "frameforge-0123456789abcdef0123456789abcdef.json");
            File.WriteAllBytes(result, []);
            // No .req file: the freshness guard refuses (exit 3) and nothing is written.
            Assert.Equal(ElevationRequest.NotFreshExitCode, StartupApproved.RunElevatedChild(["write", result, "hklm-run|A", "-", "disable"], v => JsonSerializer.Serialize(v), store));
            Assert.Equal(0, store.Writes);
            Assert.Equal(2, StartupApproved.RunElevatedChild(["write", result], v => "", store));
        }
        finally { dir.Delete(true); }
    }

    [Fact]
    public void ListsSourcesWithPublisherStateImpactAndCriticalFlags()
    {
        var approved = new MemoryApproved();
        approved.Values[(false, "Run", "Discord")] = StartupApproved.EncodeDisabled(DateTime.UnixEpoch);
        var list = StartupLister.Build(new Sources(), approved);
        var byId = list.Items.ToDictionary(i => i.Id);
        var discord = byId["hkcu-run|Discord"];
        Assert.Equal(@"C:\Users\a\Discord\Update.exe", discord.Path);
        Assert.False(discord.Enabled);
        Assert.True(discord.CanToggle);
        Assert.Equal("medium", discord.Impact);
        Assert.Equal("Contoso", discord.Publisher);
        Assert.Equal("user", discord.Scope);
        Assert.Equal("unknown", byId["hkcu-run|Missing"].Impact);
        Assert.Contains("not found", byId["hkcu-run|Missing"].Note);
        Assert.True(byId["hklm-run|SecurityHealth"].Critical);
        Assert.True(byId["hklm-run|RtkAudUService"].Critical);
        Assert.False(discord.Critical);
        Assert.Equal("high", byId["hkcu-folder|Tool.lnk"].Impact);
        Assert.True(byId["hkcu-folder|Tool.lnk"].CanToggle);
        // Listed only: no switch, Frameforge cannot change them.
        foreach (var id in new[] { "hklm-runonce|Once", @"task|\Updater", "uwp|Spotify (SpotifyStartup)" }) Assert.False(byId[id].CanToggle);
        Assert.Null(byId["hklm-runonce|Once"].Enabled);
        Assert.False(byId[@"task|\Updater"].Enabled);
        Assert.True(byId["uwp|Spotify (SpotifyStartup)"].Enabled);
        Assert.Empty(list.Warnings);
    }
    [Fact]
    public void ProtectedFlagUsesWholeWordsForShortVendorNames()
    {
        Assert.Null(StartupLister.CriticalReason("TelegramDesktop", @"C:\T\t.exe", "Telegram", @"C:\Windows"));
        Assert.Null(StartupLister.CriticalReason("Reset helper", @"C:\T\t.exe", "Contoso", @"C:\Windows"));
        Assert.NotNull(StartupLister.CriticalReason("AMD Software", @"C:\T\t.exe", "AMD", @"C:\Windows"));
        Assert.NotNull(StartupLister.CriticalReason("x", @"C:\Windows\System32\x.exe", "", @"C:\Windows"));
    }
    [Theory]
    [InlineData("\"C:\\A B\\x.exe\" /s", @"C:\A B\x.exe")]
    [InlineData(@"C:\A B\x.exe /s", @"C:\A B\x.exe")]
    [InlineData("notepad", "notepad")]
    public void ParsesTheProgramFromACommandLine(string command, string expected) => Assert.Equal(expected, StartupLister.ExecutablePath(command));
}
