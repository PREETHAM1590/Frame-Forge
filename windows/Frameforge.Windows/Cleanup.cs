namespace Frameforge.Windows;

// Opt-in cleanup of a fixed list of cache and temp folders. The request carries category ids only; every path comes from this table.
// Never follows junctions or symlinks, never deletes a root folder itself, skips files that are locked or denied, and does not touch the registry.
public sealed record CleanupFacts(string? Temp, string? WinDir, string? LocalAppData, string? UserProfile)
{
    public static CleanupFacts FromEnvironment() => new(Path.GetTempPath(), Environment.GetEnvironmentVariable("SystemRoot"), Environment.GetEnvironmentVariable("LOCALAPPDATA"), Environment.GetEnvironmentVariable("USERPROFILE"));
}

public sealed record CleanupCategory(string Id, string Label, bool Admin, bool Shader, int MinAgeHours, string[] Roots);
public sealed record CleanupPreviewRow(string Id, string Label, bool Present, bool NeedsAdmin, bool Shader, int MinAgeHours, long? Bytes, int Files, string[] Folders);
public sealed record CleanupRunRow(string Id, string Label, long FreedBytes, int Deleted, int Skipped, string Note);

public static class Cleanup
{
    public static IReadOnlyList<CleanupCategory> Categories(CleanupFacts f)
    {
        string[] Under(string? root, params string[] parts) => root is { Length: > 0 } ? parts.Select(p => Path.Combine(root, p)).ToArray() : [];
        var low = f.UserProfile is { Length: > 0 } ? Path.Combine(f.UserProfile, "AppData", "LocalLow") : null;
        return
        [
            new("userTemp", "User temporary files", false, false, 24, f.Temp is { Length: > 0 } ? [f.Temp] : []),
            new("windowsTemp", "Windows temporary files", true, false, 24, Under(f.WinDir, "Temp")),
            new("directxShaders", "DirectX shader cache", false, true, 0, Under(f.LocalAppData, "D3DSCache")),
            new("nvidiaShaders", "NVIDIA shader caches", false, true, 0, Under(f.LocalAppData, @"NVIDIA\DXCache", @"NVIDIA\GLCache").Concat(Under(low, @"NVIDIA\PerDriverVersion\DXCache")).ToArray()),
            new("amdShaders", "AMD shader caches", false, true, 0, Under(f.LocalAppData, @"AMD\DxCache", @"AMD\DxcCache", @"AMD\GLCache", @"AMD\VkCache")),
            new("intelShaders", "Intel shader caches", false, true, 0, Under(f.LocalAppData, @"Intel\ShaderCache").Concat(Under(low, @"Intel\ShaderCache")).ToArray()),
        ];
    }

    static string Norm(string p) => Path.GetFullPath(p).TrimEnd('\\', '/');
    static bool Inside(string parent, string child) => Norm(child).StartsWith(Norm(parent) + "\\", StringComparison.OrdinalIgnoreCase);
    static bool Same(string a, string b) => string.Equals(Norm(a), Norm(b), StringComparison.OrdinalIgnoreCase);

    /// <summary>The allowlist: an absolute folder that is not a drive root, the Windows folder, the profile or an ancestor of them, and is either below the profile's
    /// local data, below LocalLow, the Windows temp folder, or the user temp folder itself (whose name must say temp).</summary>
    public static bool IsSafeRoot(string? path, CleanupFacts f)
    {
        if (string.IsNullOrWhiteSpace(path) || !Path.IsPathFullyQualified(path)) return false;
        string full;
        try { full = Norm(path); } catch (ArgumentException) { return false; }
        if (Path.GetPathRoot(full) is { } drive && Same(drive, full)) return false;
        foreach (var guarded in new[] { f.WinDir, f.UserProfile }) if (guarded is { Length: > 0 } && (Same(guarded, full) || Inside(full, guarded))) return false;
        if (f.LocalAppData is { Length: > 0 } && Inside(f.LocalAppData, full)) return true;
        if (f.UserProfile is { Length: > 0 } && Inside(Path.Combine(f.UserProfile, "AppData", "LocalLow"), full)) return true;
        if (f.WinDir is { Length: > 0 } && Same(Path.Combine(f.WinDir, "Temp"), full)) return true;
        var leaf = Path.GetFileName(full);
        return f.Temp is { Length: > 0 } && Same(f.Temp, full) && (leaf.Contains("tem", StringComparison.OrdinalIgnoreCase) || leaf.Contains("tmp", StringComparison.OrdinalIgnoreCase));
    }

    static EnumerationOptions Options() => new() { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint, ReturnSpecialDirectories = false };

    /// <summary>Files below the root that are old enough; junctions and symlinks are neither entered nor counted.</summary>
    public static (long Bytes, int Files) Scan(string root, DateTime? olderThanUtc)
    {
        long bytes = 0; var files = 0;
        if (!Directory.Exists(root)) return (0, 0);
        foreach (var file in new DirectoryInfo(root).EnumerateFiles("*", Options()))
        {
            try { if (olderThanUtc is { } cutoff && file.LastWriteTimeUtc > cutoff) continue; bytes += file.Length; files++; }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return (bytes, files);
    }

    /// <summary>Deletes old enough files one by one (a locked or denied file is counted as skipped), then removes folders that ended up empty. The root stays.</summary>
    public static (long Freed, int Deleted, int Skipped) Clean(string root, DateTime? olderThanUtc)
    {
        long freed = 0; int deleted = 0, skipped = 0;
        if (!Directory.Exists(root)) return (0, 0, 0);
        var top = new DirectoryInfo(root);
        foreach (var file in top.EnumerateFiles("*", Options()).ToList())
        {
            try
            {
                if (olderThanUtc is { } cutoff && file.LastWriteTimeUtc > cutoff) continue;
                var size = file.Length;
                if ((file.Attributes & FileAttributes.ReadOnly) != 0) file.Attributes &= ~FileAttributes.ReadOnly;
                file.Delete();
                freed += size; deleted++;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { skipped++; }
        }
        foreach (var dir in top.EnumerateDirectories("*", Options()).OrderByDescending(d => d.FullName.Length).ToList())
        {
            try { if (!dir.EnumerateFileSystemInfos().Any()) dir.Delete(false); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
        }
        return (freed, deleted, skipped);
    }

    static string[] Roots(CleanupCategory c, CleanupFacts f) => c.Roots.Where(r => IsSafeRoot(r, f) && Directory.Exists(r)).ToArray();

    public static object Preview(CleanupFacts f, bool elevated, DateTime nowUtc)
    {
        var rows = new List<CleanupPreviewRow>();
        foreach (var c in Categories(f))
        {
            var roots = Roots(c, f);
            var blocked = c.Admin && !elevated;
            long bytes = 0; var files = 0;
            if (!blocked) foreach (var r in roots) { var s = Scan(r, c.MinAgeHours > 0 ? nowUtc.AddHours(-c.MinAgeHours) : null); bytes += s.Bytes; files += s.Files; }
            rows.Add(new(c.Id, c.Label, roots.Length > 0, blocked, c.Shader, c.MinAgeHours, blocked ? null : bytes, files, roots));
        }
        return new { categories = rows, elevated };
    }

    /// <summary>Cleans the named categories. Unknown ids are ignored; administrator-only ones are skipped when this process is not elevated.</summary>
    public static object Run(IEnumerable<string> ids, CleanupFacts f, bool elevated, DateTime nowUtc)
    {
        var rows = new List<CleanupRunRow>();
        var wanted = ids.ToHashSet(StringComparer.Ordinal);
        foreach (var c in Categories(f).Where(c => wanted.Contains(c.Id)))
        {
            if (c.Admin && !elevated) { rows.Add(new(c.Id, c.Label, 0, 0, 0, "Skipped: needs Frameforge to run as administrator.")); continue; }
            long freed = 0; int deleted = 0, skipped = 0;
            var roots = Roots(c, f);
            foreach (var r in roots) { var s = Clean(r, c.MinAgeHours > 0 ? nowUtc.AddHours(-c.MinAgeHours) : null); freed += s.Freed; deleted += s.Deleted; skipped += s.Skipped; }
            rows.Add(new(c.Id, c.Label, freed, deleted, skipped, roots.Length == 0 ? "Folder not present on this PC." : skipped > 0 ? $"{skipped} file(s) in use or protected were skipped." : "Done."));
        }
        return new { categories = rows, freedBytes = rows.Sum(r => r.FreedBytes), deleted = rows.Sum(r => r.Deleted), skipped = rows.Sum(r => r.Skipped) };
    }
}
