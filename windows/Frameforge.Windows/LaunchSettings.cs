namespace Frameforge.Windows;

// Per-game launch settings: GPU preference and fullscreen-optimizations-off. Windows reads both when a game starts, so they are
// persistent settings the user applies and reverts explicitly (Frameforge keeps the prior value), not session mechanisms.
// Op "read" inspects, "apply" writes and verifies, "revert" restores the saved prior only while Frameforge's value is still in place.
public record LaunchRequest(string Setting, string Exe, string Op, bool Existed = false, string? Value = null, string? Applied = null);
// State: ready, already-set, applied, reverted, conflict, unsupported or failed.
// Current: the value now (before an apply: the prior to save). After: what the value becomes (or Applied on revert).
public record LaunchResult(string Setting, string Exe, string State, string Detail, string? Current, string? After, bool Existed);

public static class LaunchSettings
{
    public static readonly string[] Names = ["gpuPreference", "fullscreenOptimizations"];
    private static string PathOf(string setting) => setting == "gpuPreference" ? BoosterPaths.GpuPreferences : BoosterPaths.Layers;
    private static string Label(string setting) => setting == "gpuPreference" ? "High-performance GPU preference" : "Fullscreen optimizations off";
    private static bool Has(string setting, string? value) => setting == "gpuPreference" ? BoosterPaths.HasGpuPreference(value) : BoosterPaths.HasFsoOff(value);
    private static string Next(string setting, string? prior) => setting == "gpuPreference" ? BoosterPaths.WithGpuPreference(prior) : BoosterPaths.WithFsoOff(prior);

    public static LaunchResult Run(LaunchRequest request, IRegistryAccess registry, IGpuInfo gpus)
    {
        if (!Names.Contains(request.Setting) || request.Op is not ("read" or "apply" or "revert")) throw new InvalidOperationException("Unsupported launch setting request.");
        // The value name is the game's path; only a fully qualified local .exe is accepted, for every operation.
        if (!BoosterPaths.ValidExe(request.Exe)) throw new InvalidOperationException("The game's executable path is not a local .exe file.");
        var setting = request.Setting; var exe = request.Exe; var path = PathOf(setting);
        LaunchResult Result(string state, string detail, string? current = null, string? after = null, bool existed = false) => new(setting, exe, state, detail, current, after, existed);
        if (request.Op == "revert") return Revert(request, registry, path, Result);
        if (setting == "gpuPreference" && gpus.Count() < 2) return Result("unsupported", "Only one graphics adapter is installed, so there is nothing to choose between.");
        var current = registry.Read(path, exe);
        if (current.Existed && current.Kind != "String") return Result("unsupported", "The existing value has an unexpected type, so it was left alone.");
        var prior = current.Value as string;
        if (Has(setting, prior)) return Result("already-set", setting == "gpuPreference" ? "Windows already prefers the high-performance GPU for this game." : "Fullscreen optimizations are already off for this game.", prior, prior, current.Existed);
        var next = Next(setting, prior);
        if (request.Op == "read") return Result("ready", $"{Label(setting)} can be applied.", prior, next, current.Existed);
        registry.Write(path, exe, "String", next);
        return registry.Read(path, exe) is { Existed: true, Kind: "String" } now && Equals(now.Value, next)
            ? Result("applied", $"{Label(setting)} set and verified. Windows reads it the next time the game starts.", prior, next, current.Existed)
            : Result("failed", "Windows did not keep the value.", prior, next, current.Existed);
    }
    private static LaunchResult Revert(LaunchRequest request, IRegistryAccess registry, string path, Func<string, string, string?, string?, bool, LaunchResult> result)
    {
        if (request.Applied is null || (request.Existed && request.Value is null) || (!request.Existed && request.Value is not null)) throw new InvalidOperationException("Invalid saved launch setting.");
        var current = registry.Read(path, request.Exe);
        var atPrior = current.Existed == request.Existed && (!request.Existed || (current.Kind == "String" && Equals(current.Value, request.Value)));
        if (atPrior) return result("reverted", "The value is already back to what it was before Frameforge changed it.", request.Value, request.Value, request.Existed);
        if (!(current.Existed && current.Kind == "String" && Equals(current.Value, request.Applied)))
            return result("conflict", "The value was changed outside Frameforge, so it was left as it is.", current.Value as string, request.Applied, request.Existed);
        if (request.Existed) registry.Write(path, request.Exe, "String", request.Value!); else registry.Delete(path, request.Exe);
        var after = registry.Read(path, request.Exe);
        return after.Existed == request.Existed && (!request.Existed || Equals(after.Value, request.Value))
            ? result("reverted", request.Existed ? "Prior value restored and verified." : "Removed (the game had no value before) and verified.", request.Value, request.Value, request.Existed)
            : result("failed", "Windows did not restore the prior value.", after.Value as string, request.Value, request.Existed);
    }
}
