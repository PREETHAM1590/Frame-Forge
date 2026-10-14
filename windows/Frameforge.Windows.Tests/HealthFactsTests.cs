using Frameforge.Windows;
using Xunit;

public class HealthFactsTests
{
    [Fact]
    public void MapsOverlaySchemesAndPreferences()
    {
        Assert.Equal("balanced", HealthFacts.OverlayName(Guid.Empty));
        Assert.Equal("best-performance", HealthFacts.OverlayName(new("ded574b5-45a0-4f42-8737-46345c09c238")));
        Assert.Equal("best-efficiency", HealthFacts.OverlayName(new("961cc777-2547-4f9d-8174-7d86181b8a7a")));
        Assert.Equal("unknown", HealthFacts.OverlayName(new("11111111-1111-1111-1111-111111111111")));
        Assert.Null(HealthFacts.ParsePreference(null));
        Assert.Equal("high-performance", HealthFacts.ParsePreference("GpuPreference=2;"));
        Assert.Equal("power-saving", HealthFacts.ParsePreference("GpuPreference=1;"));
        Assert.Equal("auto", HealthFacts.ParsePreference("GpuPreference=0;"));
        // Other flags in the same value do not hide the preference, and a value without one means Windows decides.
        Assert.Equal("high-performance", HealthFacts.ParsePreference("SwapEffectUpgradeEnable=1;GpuPreference=2;"));
        Assert.Equal("auto", HealthFacts.ParsePreference("SwapEffectUpgradeEnable=1;"));
    }

    [Fact]
    public void ParsesNvidiaSmiRowsAndThrottleReasons()
    {
        var row = HealthFacts.ParseNvidia("NVIDIA GeForce RTX 4050 Laptop GPU, 617.14, 59, 2610, 3105, 20.12, [N/A], P3, 0x0000000000000024\n");
        Assert.NotNull(row);
        Assert.Equal(59, row!.TemperatureC);
        Assert.Equal(3105, row.MaxClockMHz);
        Assert.Null(row.PowerLimitW);
        Assert.Equal(["power cap", "thermal slowdown"], row.ThrottleReasons);
        Assert.Empty(HealthFacts.ThrottleReasons("0x0000000000000001"));
        Assert.Empty(HealthFacts.ThrottleReasons("garbage"));
        Assert.Null(HealthFacts.ParseNvidia("Failed to initialize NVML"));
        // A driver without the reasons field still parses.
        Assert.NotNull(HealthFacts.ParseNvidia("GPU, 1.0, 40, 300, 2000, 10, 80, P8"));
    }

    [Fact]
    public void FindsTheHighestRefreshRateAtTheCurrentResolution()
    {
        var modes = new[] { (1920, 1080, 60), (1920, 1080, 144), (1920, 1080, 240), (2560, 1440, 360) };
        Assert.Equal(240, HealthFacts.MaxHz(modes, 1920, 1080));
        Assert.Equal(0, HealthFacts.MaxHz(modes, 800, 600));
    }

    [Fact]
    public void DecidesFullscreenFromTheMonitorRectangleAndSkipsTheShell()
    {
        Assert.True(ForegroundApp.Covers((0, 0, 1920, 1080), (0, 0, 1920, 1080)));
        Assert.True(ForegroundApp.Covers((-8, -8, 1928, 1088), (0, 0, 1920, 1080)));
        Assert.False(ForegroundApp.Covers((100, 100, 1500, 900), (0, 0, 1920, 1080)));
        Assert.True(ForegroundApp.IsShell("explorer.exe"));
        Assert.False(ForegroundApp.IsShell("VALORANT-Win64-Shipping.exe"));
    }

    [Fact]
    public void ClassifiesGpusOverlaysAndVendorApps()
    {
        Assert.True(HealthFacts.Integrated("Intel(R) UHD Graphics"));
        Assert.False(HealthFacts.Integrated("Intel(R) Arc(TM) A770 Graphics"));
        Assert.False(HealthFacts.Integrated("NVIDIA GeForce RTX 4050 Laptop GPU"));
        Assert.True(HealthFacts.Integrated("AMD Radeon(TM) Graphics"));
        Assert.Equal("nvidia", HealthFacts.Vendor("NVIDIA GeForce RTX 4050"));
        Assert.Equal(["Discord", "steamwebhelper"], HealthFacts.DetectOverlays(["chrome", "steamwebhelper", "discord", "Discord"]));
        Assert.Equal("NitroSense", HealthFacts.DetectVendorApp(["explorer", "NitroSense"]));
        Assert.Null(HealthFacts.DetectVendorApp(["explorer"]));
    }
}
