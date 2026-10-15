using System.Globalization;
using System.Runtime.InteropServices;

namespace Frameforge.Windows;

// Physical memory, so the clean-up can report what it really freed. A fake supplies numbers in tests.
public interface IMemory { (long Available, long Total) Read(); }

public sealed class WindowsMemory : IMemory
{
    public (long Available, long Total) Read()
    {
        var status = new Status { Length = (uint)Marshal.SizeOf<Status>() };
        if (!GlobalMemoryStatusEx(ref status)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        return ((long)status.AvailablePhysical, (long)status.TotalPhysical);
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct Status { public uint Length, MemoryLoad; public ulong TotalPhysical, AvailablePhysical, TotalPageFile, AvailablePageFile, TotalVirtual, AvailableVirtual, AvailableExtendedVirtual; }
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GlobalMemoryStatusEx(ref Status status);
}

// Boost start clean-up: runs before every other change of a boost. Close or end the picked apps, pause the ones to pause,
// trim the working sets of big background processes, measure what that really freed and clear the standby list only if memory is still tight.
public sealed partial class BoostSessionEngine
{
    // Below this a before/after difference is noise (other programs allocate and free all the time).
    public const long MeasurableBytes = 50L * 1024 * 1024;
    public static bool Tight(long available, long total) => total > 0 && (available * 4 < total || available < 2L * 1024 * 1024 * 1024);
    private static string Gb(long bytes) => (bytes / (1024.0 * 1024 * 1024)).ToString("F1", CultureInfo.InvariantCulture);
    private void Pause(int milliseconds) { if (sleep is not null) sleep(milliseconds); else Thread.Sleep(milliseconds); }
    private (long Available, long Total)? ReadMemory()
    {
        try { return extras?.Memory?.Read(); }
        catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { return null; }
    }

    private void Cleanup(SessionCommand command, Mechanisms mechanisms, ProcInfo game, ProcInfo[] all)
    {
        var plan = command.Cleanup!;
        var rules = plan.Rules ?? [];
        var before = ReadMemory();
        var closed = 0;
        foreach (var rule in rules.Where(r => r.Action is "close" or "end")) closed += CloseApp(rule, plan, command.ParentPid, game, all);
        // Pausing is the mode-independent half of the list: the same capture and resume as the Suspend mechanism.
        var pausing = mechanisms with { SuspendBackground = true };
        foreach (var rule in rules.Where(r => r.Action == "suspend")) Background(rule, pausing, game, command.ParentPid, all);
        FreeMemory(command, plan, game, closed > 0 ? processes.List() : all, before, closed > 0);
    }

    private int CloseApp(BackgroundRule rule, CleanupPlan plan, int parentPid, ProcInfo game, ProcInfo[] all)
    {
        var matches = Candidates(game, parentPid, all).Where(p => string.Equals(Path.GetFileName(p.Target.ExecutablePath), rule.Image, StringComparison.OrdinalIgnoreCase)).Select(p => p.Target).ToArray();
        if (matches.Length == 0) { emit(new("skipped", "closeBackground", $"{rule.Image}: not running in your session, or protected.")); return 0; }
        var path = matches[0].ExecutablePath;
        var gone = 0;
        Run("closeBackground", () =>
        {
            var grace = Math.Clamp(plan.GraceSeconds, 1, 10) * 1000;
            processes.PostClose(matches);
            var alive = WaitGone(matches, grace);
            var forced = 0;
            if (alive.Length > 0 && rule.Action == "end")
            {
                foreach (var target in alive) try { processes.Terminate(target); forced++; } catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException) { }
                alive = WaitGone(alive, 2000);
            }
            gone = matches.Length - alive.Length;
            var relaunch = gone > 0 && plan.Relaunch && path.Length is > 0 and <= 520 && captured.Count < MaxCaptures;
            if (relaunch) Capture(new Captured("closeBackground", Launch: path));
            var after = relaunch ? " It is reopened when the session ends." : " It is not reopened.";
            if (alive.Length == 0)
                return new("closeBackground", "applied", $"{rule.Image}: closed {gone} process(es){(forced > 0 ? $", {forced} had to be ended" : "")}.{after}");
            if (gone == 0)
                return rule.Action == "end"
                    ? new("closeBackground", "failed", $"{rule.Image}: Windows would not end it.")
                    : new("closeBackground", "skipped", $"{rule.Image}: asked to close, still open after {grace / 1000} s (it may be waiting for you to save). Left running.", Code: "still-open");
            return new("closeBackground", "applied", $"{rule.Image}: closed {gone} of {matches.Length} process(es); {alive.Length} still running.{after}");
        });
        return gone;
    }
    // Exits are polled by identity (a reused pid never counts as alive); the wait is counted in sleeps so tests do not wait for real.
    private ProcessTarget[] WaitGone(ProcessTarget[] targets, int milliseconds)
    {
        var alive = targets.Where(t => processes.Read(t) is not null).ToArray();
        for (var waited = 0; alive.Length > 0 && waited < milliseconds; waited += 100)
        {
            Pause(100);
            alive = alive.Where(t => processes.Read(t) is not null).ToArray();
        }
        return alive;
    }

    private void FreeMemory(SessionCommand command, CleanupPlan plan, ProcInfo game, ProcInfo[] all, (long Available, long Total)? before, bool closedAny)
    {
        if (before is not { } start) { emit(new("unsupported", "freeMemory", "Memory could not be measured here, so nothing was trimmed.")); return; }
        var images = new HashSet<string>(plan.Trim ?? [], StringComparer.OrdinalIgnoreCase);
        var trimmed = 0; var refused = 0;
        Run("freeMemory", () =>
        {
            foreach (var p in Candidates(game, command.ParentPid, all).Where(p => images.Contains(Path.GetFileName(p.Target.ExecutablePath))))
            {
                if (processes.WorkingSet(p.Target) < plan.TrimMinBytes) continue;
                if (processes.TrimWorkingSet(p.Target)) trimmed++; else refused++;
            }
            // Trimmed pages need a moment to reach the standby list before they count as available.
            if (trimmed > 0 || closedAny) Pause(1000);
            var end = ReadMemory() ?? start;
            var freed = end.Available - start.Available;
            var megabytes = plan.TrimMinBytes / (1024 * 1024);
            var tail = trimmed > 0
                ? $"Trimmed {trimmed} background process(es) over {megabytes} MB{(refused > 0 ? $" ({refused} refused by Windows)" : "")}."
                : $"No background process over {megabytes} MB needed trimming{(refused > 0 ? $" ({refused} refused by Windows)" : "")}.";
            var tight = Tight(end.Available, end.Total);
            var purge = plan.Purge && tight;
            if (purge) PlanPurge(command);
            if (freed >= MeasurableBytes)
                return new("freeMemory", "applied", $"Freed {Gb(freed)} GB (from {Gb(start.Available)} to {Gb(end.Available)} GB available). {tail}{(tight ? " Memory is still tight." : "")}{(purge && purgeWanted ? " Clearing the standby list as well." : "")}");
            if (!Tight(start.Available, start.Total))
                return new("freeMemory", "skipped", $"Memory was already fine: {Gb(end.Available)} GB of {Gb(end.Total)} GB available, so there was nothing to free. {tail}", Code: "already-set");
            return new("freeMemory", "skipped", $"Memory is tight ({Gb(end.Available)} GB available) and trimming freed no measurable amount. {tail}{(purge && purgeWanted ? " Clearing the standby list as well." : "")}", Code: "no-change");
        });
    }

    // Reopens an app the clean-up closed, by the path saved when it was closed, unless something already runs from that path.
    private MechanismResult RevertRelaunch(Captured item)
    {
        var path = item.Launch;
        var name = path is null ? "" : Path.GetFileName(path);
        if (path is null || path.Length > 520 || !Path.IsPathRooted(path) || !Image.IsMatch(name) || ProcessSafety.Denied(name))
            throw new InvalidOperationException("Invalid saved app path.");
        if (!File.Exists(path)) return new("closeBackground", "reverted", $"{name}: no longer installed at its old place; not reopened.");
        if (processes.List().Any(p => string.Equals(p.Target.ExecutablePath, path, StringComparison.OrdinalIgnoreCase)))
            return new("closeBackground", "reverted", $"{name}: already running; not started again.");
        return processes.Launch(path)
            ? new("closeBackground", "reverted", $"{name}: reopened (its old window and tabs are not restored).")
            : new("closeBackground", "failed", $"{name}: could not be reopened.");
    }
}
