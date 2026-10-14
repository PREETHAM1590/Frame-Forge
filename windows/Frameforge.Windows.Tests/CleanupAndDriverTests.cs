using System.Text.Json;
using Frameforge.Windows;
using Xunit;

public sealed class TempTree : IDisposable
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "ff-clean-" + Guid.NewGuid().ToString("N"));
    public TempTree() => Directory.CreateDirectory(Root);
    public void Dispose() { try { Directory.Delete(Root, true); } catch (IOException) { } catch (UnauthorizedAccessException) { } }
}

public class CleanupTests
{
    static CleanupFacts Facts(string profile) => new(Path.Combine(profile, "AppData", "Local", "Temp"), Path.Combine(profile, "Windows"), Path.Combine(profile, "AppData", "Local"), profile);

    [Fact]
    public void AllowlistRejectsRootsProfileWindowsAndAncestors()
    {
        var f = Facts(@"C:\Users\me");
        Assert.True(Cleanup.IsSafeRoot(@"C:\Users\me\AppData\Local\D3DSCache", f));
        Assert.True(Cleanup.IsSafeRoot(@"C:\Users\me\AppData\Local\NVIDIA\DXCache", f));
        Assert.True(Cleanup.IsSafeRoot(@"C:\Users\me\AppData\LocalLow\NVIDIA\PerDriverVersion\DXCache", f));
        Assert.True(Cleanup.IsSafeRoot(@"C:\Users\me\AppData\Local\Temp", f));
        Assert.True(Cleanup.IsSafeRoot(@"C:\Users\me\Windows\Temp", f));
        foreach (var bad in new[] { @"C:\", @"C:\Users", @"C:\Users\me", @"C:\Users\me\Windows", @"C:\Users\me\Windows\System32", @"C:\Users\me\Documents", @"C:\Users\me\AppData\Local\..\Documents", "relative\\path", "", @"C:\Users\me\AppData\Local" + "\\.." })
            Assert.False(Cleanup.IsSafeRoot(bad, f), bad);
        Assert.False(Cleanup.IsSafeRoot(null, f));
    }

    [Fact]
    public void CustomTempMustLookLikeTempAndNotBeADriveRoot()
    {
        var f = new CleanupFacts(@"D:\Scratch", @"C:\Windows", @"C:\Users\me\AppData\Local", @"C:\Users\me");
        Assert.False(Cleanup.IsSafeRoot(@"D:\Scratch", f));
        Assert.True(Cleanup.IsSafeRoot(@"D:\Temp", new CleanupFacts(@"D:\Temp", @"C:\Windows", @"C:\Users\me\AppData\Local", @"C:\Users\me")));
        Assert.False(Cleanup.IsSafeRoot(@"D:\", new CleanupFacts(@"D:\", @"C:\Windows", @"C:\Users\me\AppData\Local", @"C:\Users\me")));
    }

    [Fact]
    public void CategoriesOnlyContainSafeKnownFolders()
    {
        var f = Facts(@"C:\Users\me");
        var all = Cleanup.Categories(f);
        Assert.Equal(["userTemp", "windowsTemp", "directxShaders", "nvidiaShaders", "amdShaders", "intelShaders"], all.Select(c => c.Id));
        Assert.All(all.SelectMany(c => c.Roots), r => Assert.True(Cleanup.IsSafeRoot(r, f), r));
        Assert.True(all.Single(c => c.Id == "windowsTemp").Admin);
        Assert.DoesNotContain(all, c => c.Id.Contains("browser", StringComparison.OrdinalIgnoreCase) || c.Id.Contains("recycle", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public void CleanDeletesContentsKeepsRootAndSkipsLockedFiles()
    {
        using var t = new TempTree();
        Directory.CreateDirectory(Path.Combine(t.Root, "a", "b"));
        File.WriteAllText(Path.Combine(t.Root, "one.bin"), new string('x', 100));
        File.WriteAllText(Path.Combine(t.Root, "a", "b", "two.bin"), new string('x', 200));
        var locked = Path.Combine(t.Root, "locked.bin");
        File.WriteAllText(locked, new string('x', 300));
        var readOnly = Path.Combine(t.Root, "ro.bin");
        File.WriteAllText(readOnly, "ro");
        File.SetAttributes(readOnly, FileAttributes.ReadOnly);
        using (new FileStream(locked, FileMode.Open, FileAccess.Read, FileShare.None))
        {
            var (freed, deleted, skipped) = Cleanup.Clean(t.Root, null);
            Assert.Equal(1, skipped);
            Assert.Equal(3, deleted);
            Assert.Equal(100 + 200 + 2, freed);
        }
        Assert.True(Directory.Exists(t.Root));
        Assert.True(File.Exists(locked));
        Assert.False(Directory.Exists(Path.Combine(t.Root, "a")));
    }

    [Fact]
    public void PreviewCountsBytesAndNeverDeletes()
    {
        using var t = new TempTree();
        File.WriteAllText(Path.Combine(t.Root, "f.bin"), new string('x', 500));
        Assert.Equal((500L, 1), Cleanup.Scan(t.Root, null));
        Assert.True(File.Exists(Path.Combine(t.Root, "f.bin")));
    }

    [Fact]
    public void AgeFilterLeavesRecentFiles()
    {
        using var t = new TempTree();
        var fresh = Path.Combine(t.Root, "fresh.bin");
        var old = Path.Combine(t.Root, "old.bin");
        File.WriteAllText(fresh, "new");
        File.WriteAllText(old, "old");
        File.SetLastWriteTimeUtc(old, DateTime.UtcNow.AddDays(-3));
        var cutoff = DateTime.UtcNow.AddHours(-24);
        Assert.Equal(1, Cleanup.Scan(t.Root, cutoff).Files);
        Cleanup.Clean(t.Root, cutoff);
        Assert.True(File.Exists(fresh));
        Assert.False(File.Exists(old));
    }

    [Fact]
    public void JunctionsAreNeverFollowed()
    {
        using var outside = new TempTree();
        using var t = new TempTree();
        File.WriteAllText(Path.Combine(outside.Root, "precious.txt"), "keep");
        var link = Path.Combine(t.Root, "link");
        try { Directory.CreateSymbolicLink(link, outside.Root); }
        catch (Exception error) when (error is UnauthorizedAccessException or IOException) { return; /* symlinks need privileges; junction-free CI is fine */ }
        Assert.Equal(0, Cleanup.Scan(t.Root, null).Files);
        Cleanup.Clean(t.Root, null);
        Assert.True(File.Exists(Path.Combine(outside.Root, "precious.txt")));
    }

    [Fact]
    public void RunSkipsAdminCategoriesWhenNotElevatedAndIgnoresUnknownIds()
    {
        var f = Facts(@"C:\Users\nobody-ff-test");
        var json = JsonSerializer.Serialize(Cleanup.Run(["windowsTemp", "../etc", "C:\\Windows"], f, false, DateTime.UtcNow), HelperJson.Options);
        Assert.Contains("needs Frameforge to run as administrator", json);
        Assert.DoesNotContain("etc", json.Replace("Frameforge", ""));
    }

    [Fact]
    public void PreviewMarksAdminCategoryWithoutSizing()
    {
        var f = Facts(@"C:\Users\nobody-ff-test");
        var json = JsonSerializer.Serialize(Cleanup.Preview(f, false, DateTime.UtcNow), HelperJson.Options);
        using var doc = JsonDocument.Parse(json);
        var win = doc.RootElement.GetProperty("categories").EnumerateArray().Single(c => c.GetProperty("id").GetString() == "windowsTemp");
        Assert.True(win.GetProperty("needsAdmin").GetBoolean());
        Assert.Equal(JsonValueKind.Null, win.GetProperty("bytes").ValueKind);
    }
}

public class GpuDriverTests
{
    [Theory]
    [InlineData("32.0.15.6094", "560.94")]
    [InlineData("32.0.16.1714", "617.14")]
    [InlineData("31.0.15.3623", "536.23")]
    [InlineData("32.0.101.6874", "168.74")]
    public void ConvertsNvidiaWmiVersion(string wmi, string shown) => Assert.Equal(shown, GpuDrivers.NvidiaVersion(wmi));

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1.2.3")]
    [InlineData("a.b.c.d")]
    [InlineData("1.0.0.1")]
    public void RejectsUnreadableVersions(string? wmi) => Assert.Null(GpuDrivers.NvidiaVersion(wmi));

    [Fact]
    public void ParsesNvidiaSmiOutput()
    {
        var rows = GpuDrivers.ParseNvidiaSmi("NVIDIA GeForce RTX 4050 Laptop GPU, 617.14\r\nNVIDIA RTX A2000, 551.61\r\nbroken line\r\n");
        Assert.Equal([("NVIDIA GeForce RTX 4050 Laptop GPU", "617.14"), ("NVIDIA RTX A2000", "551.61")], rows);
        Assert.Empty(GpuDrivers.ParseNvidiaSmi(null));
        Assert.Empty(GpuDrivers.ParseNvidiaSmi("NVIDIA-SMI has failed because it couldn't communicate, x"));
    }

    [Fact]
    public void ParsesDriverDates()
    {
        Assert.Equal("2026-09-17", GpuDrivers.ParseDriverDate("20260917053000.000000+330"));
        Assert.Equal("2025-05-25", GpuDrivers.ParseDriverDate(new DateTime(2025, 5, 25)));
        Assert.Null(GpuDrivers.ParseDriverDate("not a date"));
        Assert.Null(GpuDrivers.ParseDriverDate(null));
        Assert.Null(GpuDrivers.ParseDriverDate("99999999000000.000000+000"));
    }

    [Theory]
    [InlineData(@"PCI\VEN_10DE&DEV_28A1&SUBSYS_171E1025", "nvidia")]
    [InlineData(@"PCI\VEN_1002&DEV_73BF", "amd")]
    [InlineData(@"PCI\VEN_8086&DEV_A7A8", "intel")]
    [InlineData(@"ROOT\BasicDisplay", "other")]
    public void DetectsVendor(string pnp, string vendor) => Assert.Equal(vendor, GpuDrivers.Vendor(pnp));

    [Fact]
    public void MergeKeepsPciAdaptersAndPrefersSmiVersion()
    {
        var wmi = new List<Dictionary<string, object?>>
        {
            new() { ["Name"] = "NVIDIA GeForce RTX 4050 Laptop GPU", ["DriverVersion"] = "32.0.16.1714", ["DriverDate"] = new DateTime(2026, 9, 17), ["PNPDeviceID"] = @"PCI\VEN_10DE&DEV_28A1" },
            new() { ["Name"] = "Microsoft Remote Display Adapter", ["DriverVersion"] = "10.0.1.1", ["DriverDate"] = null, ["PNPDeviceID"] = @"SWD\REMOTEDISPLAY" },
            new() { ["Name"] = "Intel(R) UHD Graphics", ["DriverVersion"] = "32.0.101.6874", ["DriverDate"] = new DateTime(2025, 5, 25), ["PNPDeviceID"] = @"PCI\VEN_8086&DEV_A7A8" },
        };
        var list = GpuDrivers.Merge(wmi, [("NVIDIA GeForce RTX 4050 Laptop GPU", "617.14")]);
        Assert.Equal(2, list.Count);
        Assert.Equal("617.14", list[0].DisplayVersion);
        Assert.Equal("2026-09-17", list[0].DriverDate);
        Assert.Null(list[1].DisplayVersion);
        Assert.Equal("intel", list[1].Vendor);
    }
}
