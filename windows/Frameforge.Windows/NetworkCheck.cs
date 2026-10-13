using System.Globalization;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Text.RegularExpressions;

namespace Frameforge.Windows;

// Diagnostics only: ICMP echo to one host. Nothing on the PC is changed.
public record NetworkResult(string Host, string? Address, int Sent, int Received, double LossPercent, double? MinMs, double? AvgMs, double? MaxMs, double? JitterMs, double?[] Samples, string Message);
public interface IPinger { double? Ping(IPAddress address, int timeoutMs); }
public interface IResolver { IPAddress? Resolve(string host); }

public sealed class WindowsPinger : IPinger
{
    public double? Ping(IPAddress address, int timeoutMs)
    {
        using var ping = new Ping();
        var reply = ping.Send(address, timeoutMs);
        return reply.Status == IPStatus.Success ? reply.RoundtripTime : null;
    }
}
public sealed class WindowsResolver : IResolver
{
    public IPAddress? Resolve(string host)
    {
        if (NetworkCheck.IsLiteral(host)) return IPAddress.TryParse(host, out var literal) ? literal : null;
        try { return Dns.GetHostAddresses(host).OrderBy(a => a.AddressFamily == AddressFamily.InterNetwork ? 0 : 1).FirstOrDefault(); }
        catch (SocketException) { return null; }
    }
}

public static class NetworkCheck
{
    public const int MinCount = 3, MaxCount = 30, TimeoutMs = 1000, SpacingMs = 200;
    private static readonly Regex Hostname = new(@"\A[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\z", RegexOptions.CultureInvariant);
    private static readonly Regex Dotted = new(@"\A\d{1,3}(?:\.\d{1,3}){3}\z", RegexOptions.CultureInvariant);
    public static bool IsLiteral(string host) => host.Contains(':') || Dotted.IsMatch(host);
    public static bool ValidHost(string? host) => host is { Length: > 0 and <= 253 } && (IsLiteral(host) ? host.All(c => char.IsAsciiHexDigit(c) || c is ':' or '.') && IPAddress.TryParse(host, out _) : Hostname.IsMatch(host) && !host.All(c => char.IsAsciiDigit(c) || c == '.'));
    // Loopback, unspecified, multicast and broadcast targets say nothing about the network path. A router on the LAN is fine.
    public static bool Useful(IPAddress address) => !IPAddress.IsLoopback(address) && !address.Equals(IPAddress.Any) && !address.Equals(IPAddress.IPv6Any) && !address.Equals(IPAddress.Broadcast) &&
        !address.IsIPv6Multicast && !(address.AddressFamily == AddressFamily.InterNetwork && address.GetAddressBytes()[0] >= 224);

    // Jitter is the mean absolute difference between consecutive round trips that were received.
    public static NetworkResult Summarize(string host, IPAddress? address, double?[] samples)
    {
        var received = samples.Where(s => s is not null).Select(s => s!.Value).ToArray();
        var loss = samples.Length == 0 ? 0 : Math.Round(100.0 * (samples.Length - received.Length) / samples.Length, 1);
        if (received.Length == 0) return new(host, address?.ToString(), samples.Length, 0, loss, null, null, null, null, samples, "No reply. The host may block ICMP, or the network is down. This does not prove games to that region fail.");
        double? jitter = received.Length > 1 ? Math.Round(received.Zip(received.Skip(1), (a, b) => Math.Abs(b - a)).Average(), 1) : null;
        var message = $"{received.Length} of {samples.Length} replies; average {received.Average():0.#} ms, jitter {(jitter is null ? "n/a" : $"{jitter:0.#} ms")}, loss {loss:0.#}%. ICMP to this host, not game traffic.";
        return new(host, address?.ToString(), samples.Length, received.Length, loss, received.Min(), Math.Round(received.Average(), 1), received.Max(), jitter, samples, message);
    }
    public static NetworkResult Run(string host, int count, IPinger pinger, IResolver resolver, Action<int>? pause = null)
    {
        if (!ValidHost(host)) throw new InvalidOperationException("Enter a host name or an IP address.");
        if (count is < MinCount or > MaxCount) throw new InvalidOperationException($"Use between {MinCount} and {MaxCount} pings.");
        var address = resolver.Resolve(host);
        if (address is null) return new(host, null, 0, 0, 100, null, null, null, null, [], "The host name could not be resolved.");
        if (!Useful(address)) throw new InvalidOperationException("That address is local or not routable, so it says nothing about the network path.");
        var samples = new List<double?>();
        for (var i = 0; i < count; i++)
        {
            try { samples.Add(pinger.Ping(address, TimeoutMs)); }
            catch (Exception error) when (error is PingException or InvalidOperationException or SocketException) { samples.Add(null); }
            if (i < count - 1) (pause ?? Thread.Sleep)(SpacingMs);
        }
        return Summarize(host, address, [.. samples]);
    }
}
