using Frameforge.Windows;
using Xunit;

public class HardwareDiscoveryTests
{
    [Fact]
    public void DecodesZeroPaddedEdidNames()
    {
        Assert.Equal("DELL S2721DGF", HardwareDiscovery.Edid("DELL S2721DGF\0\0\0".Select(c => (ushort)c).ToArray()));
        Assert.Null(HardwareDiscovery.Edid(new ushort[] { 0, 0 }));
        Assert.Null(HardwareDiscovery.Edid(null));
    }
}
