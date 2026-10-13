using Frameforge.Windows;
using Xunit;

public class RestorePointsTests
{
    private sealed class FakeRestoreStore : IRestoreStore
    {
        public FrequencyState Frequency { get; set; } = new(false, null);
        public List<RestorePoint> Points { get; } = [];
        public List<FrequencyState> FrequencyDuringCreate { get; } = [];
        public uint CreateCode { get; set; }
        public bool AddsPoint { get; set; } = true;
        public bool Throws { get; set; }
        public bool Policy { get; set; }
        public bool PolicyDisabled() => Policy;
        public bool Locked { get; set; }
        public bool ConfigLocked() => Locked;
        public Queue<bool?> Protection { get; } = new();
        public bool? SystemDriveProtected() => Protection.Count > 0 ? Protection.Dequeue() : true;
        public string? ForeignDescription { get; set; }
        public int? SessionInterval() => 1;
        public FrequencyState ReadFrequency() => Frequency;
        public void WriteFrequency(FrequencyState state) => Frequency = state;
        public RestorePoint[] List() => [.. Points];
        public uint Create(string description)
        {
            FrequencyDuringCreate.Add(Frequency);
            if (Throws) throw new InvalidOperationException("WMI failed");
            if (CreateCode == 0 && AddsPoint) Points.Add(new(Points.Count + 1, ForeignDescription ?? description, DateTime.UtcNow));
            return CreateCode;
        }
        public uint Enable(string driveRoot) => 0;
        public bool Elevated => true;
        public string SystemDrive => "C:";
    }

    [Fact]
    public void CreatesAndVerifiesNewSequence()
    {
        var store = new FakeRestoreStore();
        var result = new RestorePoints(store).Create("Frameforge 2026-10-13", false, store.Frequency);
        Assert.Equal("created", result.Outcome);
        Assert.Equal(1, result.CreatedSequence);
        Assert.Equal("confirmed", result.DriveCoverage);
    }

    [Fact]
    public void SystemDriveReadingOffIsAWarningNotABlock()
    {
        // SPPClients is admin-only and unverified: Windows' own answer and the new sequence decide.
        var store = new FakeRestoreStore();
        store.Protection.Enqueue(false);
        var result = new RestorePoints(store).Create("Name", false, store.Frequency);
        Assert.Single(store.FrequencyDuringCreate);
        Assert.Equal("created", result.Outcome);
        Assert.Equal(1, result.Point!.Sequence);
        Assert.Equal("off", result.DriveCoverage);
        Assert.Contains("may not cover", result.Message);
    }

    [Fact]
    public void ConfigLockedStillCreatesPointsButRefusesToTurnProtectionOn()
    {
        var store = new FakeRestoreStore { Locked = true };
        var restore = new RestorePoints(store);
        Assert.True(restore.Status().ConfigLocked);
        Assert.False(restore.Status().PolicyDisabled);
        Assert.Equal("created", restore.Create("Name", false, store.Frequency).Outcome);
        var enable = restore.Enable("C:");
        Assert.False(enable.Ok);
        Assert.Equal("enable-blocked", enable.Code);
    }

    [Fact]
    public void OnlyDisableSrIsPolicyDisabled()
    {
        Assert.False(WindowsRestoreStore.PolicyBlocksRestore(name => name == "DisableConfig" ? 1 : null));
        Assert.True(WindowsRestoreStore.PolicyBlocksRestore(name => name == "DisableSR" ? 1 : null));
        Assert.False(WindowsRestoreStore.PolicyBlocksRestore(_ => null));
    }

    [Fact]
    public void AnotherAppsNewPointIsNotOurs()
    {
        var store = new FakeRestoreStore { ForeignDescription = "Windows Update" };
        var result = new RestorePoints(store).Create("Frameforge", false, store.Frequency);
        Assert.NotEqual("created", result.Outcome);
    }

    [Fact]
    public void UnknownSystemDriveCoverageIsStated()
    {
        var store = new FakeRestoreStore();
        store.Protection.Enqueue(null);
        store.Protection.Enqueue(null);
        var result = new RestorePoints(store).Create("Name", false, store.Frequency);
        Assert.Equal("created", result.Outcome);
        Assert.Contains("C: coverage could not be confirmed", result.Message);
        Assert.Equal("unknown", result.DriveCoverage);
    }

    [Fact]
    public void EnableNeverClaimsSystemDriveFromAnyDriveHint()
    {
        var store = new FakeRestoreStore();
        store.Protection.Enqueue(null);
        var result = new RestorePoints(store).Enable("C:");
        Assert.Equal("unknown", result.RestoreStatus!.Protection);
        Assert.DoesNotContain("turned on for C:", result.Message);
    }

    [Fact]
    public void PendingResultIsReadLaterAndDeleted()
    {
        var path = Path.Combine(Path.GetTempPath(), $"frameforge-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(path, "");
            using (new FileStream(path, FileMode.Open, FileAccess.Write, FileShare.None))
                Assert.Equal("elevated-pending", ((RestoreResult)RestoreCommands.ReadResult(path)).Code);
            Assert.Equal("elevated-pending", ((RestoreResult)RestoreCommands.ReadResult(path)).Code);
            File.WriteAllText(path, "{\"ok\":true,\"message\":\"done\",\"outcome\":\"created\"}");
            var result = (System.Text.Json.JsonElement)RestoreCommands.ReadResult(path);
            Assert.Equal("created", result.GetProperty("outcome").GetString());
            Assert.False(File.Exists(path));
            Assert.Equal("elevated-missing", ((RestoreResult)RestoreCommands.ReadResult(path)).Code);
            Assert.Throws<InvalidOperationException>(() => RestoreCommands.ReadResult(@"C:\Windows\win.ini"));
        }
        finally { File.Delete(path); }
    }

    [Fact]
    public void UnchangedSequenceIsThrottledNotSuccess()
    {
        var store = new FakeRestoreStore { AddsPoint = false };
        store.Points.Add(new(7, "Earlier", DateTime.UtcNow.AddMinutes(-5)));
        var result = new RestorePoints(store).Create("Again", false, store.Frequency);
        Assert.Equal("throttled", result.Outcome);
        Assert.Equal(7, result.LastPoint!.Sequence);
    }

    [Fact]
    public void UnchangedSequenceOutsideWindowIsFailedNotThrottled()
    {
        var store = new FakeRestoreStore { AddsPoint = false };
        store.Points.Add(new(7, "Old", DateTime.UtcNow.AddDays(-3)));
        var result = new RestorePoints(store).Create("Again", false, store.Frequency);
        Assert.Equal("failed", result.Outcome);
        Assert.Equal("restore-not-created", result.Code);
    }

    [Theory]
    [InlineData(false, null)]
    [InlineData(true, 1440)]
    public void BypassRestoresOriginalFrequency(bool existed, int? minutes)
    {
        var original = new FrequencyState(existed, minutes);
        var store = new FakeRestoreStore { Frequency = original };
        var result = new RestorePoints(store).Create("Override", true, original);
        Assert.Equal("created", result.Outcome);
        Assert.Equal(new FrequencyState(true, 0), store.FrequencyDuringCreate.Single());
        Assert.Equal(original, store.Frequency);
        Assert.True(result.FrequencyRestored);
    }

    [Theory]
    [InlineData(false, null)]
    [InlineData(true, 60)]
    public void BypassRestoresOriginalFrequencyWhenCreateThrows(bool existed, int? minutes)
    {
        var original = new FrequencyState(existed, minutes);
        var store = new FakeRestoreStore { Frequency = original, Throws = true };
        Assert.Throws<InvalidOperationException>(() => new RestorePoints(store).Create("Override", true, original));
        Assert.Equal(original, store.Frequency);
    }

    [Fact]
    public void BypassRefusesWhenFrequencyChangedExternally()
    {
        var store = new FakeRestoreStore { Frequency = new(true, 30) };
        Assert.Throws<InvalidOperationException>(() => new RestorePoints(store).Create("Override", true, new(false, null)));
        Assert.Empty(store.FrequencyDuringCreate);
    }

    [Theory]
    [InlineData(1058u)]
    [InlineData(0x80070422u)]
    public void ServiceDisabledIsProtectionDisabled(uint code)
    {
        var store = new FakeRestoreStore { CreateCode = code };
        Assert.Equal("protection-disabled", new RestorePoints(store).Create("Name", false, store.Frequency).Outcome);
    }

    [Fact]
    public void PolicyBlocksBeforeCreating()
    {
        var store = new FakeRestoreStore { Policy = true };
        Assert.Equal("policy-disabled", new RestorePoints(store).Create("Name", false, store.Frequency).Outcome);
        Assert.Empty(store.FrequencyDuringCreate);
    }

    [Fact]
    public void TimeoutIsReportedAsFailed()
    {
        var store = new SlowStore();
        var result = new RestorePoints(store, TimeSpan.FromMilliseconds(50)).Create("Name", false, new(false, null));
        Assert.Equal("restore-timeout", result.Code);
    }
    private sealed class SlowStore : IRestoreStore
    {
        public bool PolicyDisabled() => false;
        public bool ConfigLocked() => false;
        public bool? SystemDriveProtected() => null;
        public int? SessionInterval() => null;
        public FrequencyState ReadFrequency() => new(false, null);
        public void WriteFrequency(FrequencyState state) { }
        public RestorePoint[] List() => [];
        public uint Create(string description) { Thread.Sleep(2000); return 0; }
        public uint Enable(string driveRoot) => 0;
        public bool Elevated => true;
        public string SystemDrive => "C:";
    }

    [Theory]
    [InlineData("\"; calc")]
    [InlineData("abc\n")]
    [InlineData("")]
    [InlineData("a&b")]
    public void DescriptionValidatorRejectsUnsafeText(string text) => Assert.False(RestoreCommands.ValidDescription(text));

    [Fact]
    public void DescriptionValidatorLimitsLength()
    {
        Assert.True(RestoreCommands.ValidDescription("Frameforge (before update) 2026-10-13"));
        Assert.True(RestoreCommands.ValidDescription(new string('a', 64)));
        Assert.False(RestoreCommands.ValidDescription(new string('a', 65)));
    }

    [Theory]
    [InlineData("restore-create", new[] { "\"; calc", "0", "0", "-1" })]
    [InlineData("restore-create", new[] { "Name", "2", "0", "-1" })]
    [InlineData("restore-create", new[] { "Name", "0", "1", "-1" })]
    [InlineData("restore-create", new[] { "Name", "0", "0", "5" })]
    [InlineData("restore-enable", new[] { "C:\\" })]
    [InlineData("restore-list", new[] { "extra" })]
    [InlineData("cmd", new string[0])]
    public void ParserRejectsInvalidRequests(string action, string[] args) =>
        Assert.Throws<InvalidOperationException>(() => RestoreCommands.Parse(new(action, args)));

    [Fact]
    public void ResultPathValidator()
    {
        var name = $"frameforge-{Guid.NewGuid():N}.json";
        var valid = Path.Combine(Path.GetTempPath(), name);
        var wrong = Path.Combine(Path.GetTempPath(), $"other-{Guid.NewGuid():N}.json");
        try
        {
            File.WriteAllText(valid, "");
            File.WriteAllText(wrong, "");
            Assert.True(RestoreCommands.ValidResultPath(valid));
            Assert.False(RestoreCommands.ValidResultPath(wrong));
            Assert.False(RestoreCommands.ValidResultPath($@"\\server\share\{name}"));
            Assert.False(RestoreCommands.ValidResultPath(name));
            File.WriteAllText(valid, "{}");
            Assert.False(RestoreCommands.ValidResultPath(valid));
        }
        finally { File.Delete(valid); File.Delete(wrong); }
    }
}
