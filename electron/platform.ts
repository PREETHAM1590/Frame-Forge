import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import os from "node:os";
import {
  HelperResult,
  OperationId,
  type CreateRestorePointResult,
  type Frequency,
  type HelperRestoreStatus,
  type RestorePoints,
  type BoostCapabilities,
  type Captured,
  type Game,
  type Hardware,
  type LaunchResult,
  type LaunchSetting,
  type MechanismResult,
  type NetworkCheck,
  type ProcessTarget,
  type RunningProcess,
  type Snapshot,
} from "../shared/contracts.js";
import { adminIds, applicableIds, bootStoreIds } from "../shared/catalogue.js";
// A live `Frameforge.Windows.exe --session` process: emits "event" (one parsed JSON line) and "exit".
export interface SessionChannel {
  send(command: unknown): void;
  kill(): void;
  on(event: "event", listener: (event: unknown) => void): unknown;
  on(event: "exit", listener: () => void): unknown;
}
export type RunningGame = { gameId: string; target: ProcessTarget };
export const capabilitiesUnavailable = (detail: string): BoostCapabilities => ({
  logicalCpus: 0,
  mechanisms: (
    [
      "gameMode",
      "priority",
      "affinity",
      "powerPlan",
      "lowerBackground",
      "suspendBackground",
      "closeBackground",
      "timerResolution",
      "standbyPurge",
      "pauseServices",
      "gameBarCapture",
      "smartCores",
      "coreParking",
      "powerThrottling",
    ] as const
  ).map((id) => ({
    id,
    available: false,
    detail: detail.slice(0, 500),
    active: false,
  })),
});
export type LaunchSettingCall = {
  setting: LaunchSetting;
  exe: string;
  op: "read" | "apply" | "revert";
  /** For revert: the exact prior state and the value Frameforge wrote. */
  existed?: boolean;
  value?: string | null;
  applied?: string;
};
export interface Platform {
  capabilities: OperationId[];
  hardware(): Promise<Hardware>;
  /** reuse: the confirm step may reuse the preview's capture of the boot store instead of asking for administrator approval again. */
  capture(ids: OperationId[], reuse?: boolean): Promise<Snapshot>;
  apply(
    ids: OperationId[],
    signal: AbortSignal,
    snapshot: Snapshot,
  ): Promise<void>;
  verify(ids: OperationId[]): Promise<boolean>;
  /** Resolves with a note when Windows had changed security settings to a third value that were set back anyway. */
  restore(snapshot: Snapshot, force: boolean): Promise<string | void>;
  /** Read-only: ids among these (applied earlier) whose registry values no longer match what Frameforge wrote. */
  recheck?(ids: OperationId[]): Promise<OperationId[]>;
  /** Read-only: what Microsoft Defender itself reports, or null. */
  defenderStatus?(): Promise<string | null>;
  boostAvailable: boolean;
  /** Ends this user's explorer.exe (Windows restarts it). Only ever called after an explicit click. */
  restartExplorer(): Promise<string>;
  restoreStatus(): Promise<PlatformRestoreStatus>;
  restoreList(): Promise<RestorePoints>;
  restoreCreate(
    name: string,
    bypass: boolean,
    original: Frequency,
  ): Promise<PlatformCreateResult>;
  /** Null when the administrator prompt was declined. */
  restoreEnable(drive: string): Promise<PlatformRestoreStatus | null>;
  restoreFrequencySet(
    original: Frequency,
  ): Promise<PlatformRestoreStatus | null>;
  /** Result of an elevated creation that outlived the helper's wait; null while still running. */
  restoreResult(resultPath: string): Promise<PlatformCreateResult | null>;
  runningGames(games: Game[]): Promise<RunningGame[]>;
  backgroundProcesses(): Promise<RunningProcess[]>;
  // ownedPlan: GUID of the plan Frameforge created with consent (from SQLite, never from the renderer).
  boostCapabilities(ownedPlan: string | null): Promise<BoostCapabilities>;
  // interactive=false (automatic recovery) never opens an administrator prompt; the services step then stays pending.
  boostRecover(
    captured: Captured[],
    ownedPlan: string | null,
    interactive?: boolean,
  ): Promise<MechanismResult[]>;
  // Diagnostics only: pings the host through the helper and changes nothing.
  networkCheck(host: string, count: number): Promise<NetworkCheck>;
  // Per-game launch settings (GPU preference, fullscreen optimizations): read, apply or revert one value.
  launchSetting(call: LaunchSettingCall): Promise<LaunchResult>;
  // Creates the Frameforge plan under a GUID Frameforge already recorded.
  createPowerPlan(destination: string): Promise<void>;
  deletePowerPlan(ownedPlan: string): Promise<string>;
  spawnSession(): SessionChannel;
  /** Re-checks per-machine prerequisites and updates `capabilities`; returns a warning when the check itself failed. */
  probe?(): Promise<string | null>;
  /** The Frameforge-created plan GUID (from SQLite); optimizations treat it like a Windows performance plan. */
  setOwnedPlan?(guid: string | null): void;
}
export type PlatformRestoreStatus = HelperRestoreStatus & {
  message: string;
  /** The per-drive check confirmed protection on the system drive. */
  systemDriveConfirmed?: boolean;
  /** The elevated request is still running; nothing is confirmed yet. */
  pending?: boolean;
};
export type PlatformCreateResult = CreateRestorePointResult & {
  frequencyRestored: boolean | null;
  resultPath: string | null;
  /** The helper's per-drive answer for the system drive, when it checked. */
  driveCoverage?: "confirmed" | "off" | "unknown";
};
type HelperOutput = ReturnType<typeof HelperResult.parse>;
// Covers the UAC prompt plus the helper's 150 s wait (which itself covers the child's 120 s create).
const elevatedTimeout = 330000;
const stillRunning =
  "Windows is still creating the restore point. Frameforge checks the result when Restore & backups refreshes.";
function createResultOf(result: HelperOutput): PlatformCreateResult {
  const pending = result.code === "elevated-pending";
  const outcome = cancelled(result)
    ? "elevation-cancelled"
    : pending
      ? "pending"
      : result.code === "elevated-missing"
        ? "failed"
        : result.outcome;
  if (!outcome) throw new Error("Missing restore point result");
  return {
    outcome,
    point: result.point ?? null,
    lastPoint: result.lastPoint ?? null,
    message: pending ? stillRunning : result.message,
    frequencyRestored: result.frequencyRestored ?? null,
    resultPath: result.resultPath ?? null,
    driveCoverage: result.driveCoverage,
  };
}
function restoreStatusOf(result: HelperOutput): PlatformRestoreStatus {
  if (!result.restoreStatus) throw new Error("Missing restore status");
  return { ...result.restoreStatus, message: result.message };
}
const cancelled = (result: HelperOutput) =>
  result.code === "elevation-cancelled";
const frequencyArgs = (f: Frequency) => [
  f.existed ? "1" : "0",
  String(f.minutes ?? -1),
];
export class WindowsPlatform implements Platform {
  static readonly supported: OperationId[] = applicableIds;
  capabilities: OperationId[] = [...WindowsPlatform.supported];
  boostAvailable = true;
  private ownedPlan: string | null = null;
  constructor(private executable: string) {}
  setOwnedPlan(guid: string | null) {
    this.ownedPlan = guid;
  }
  private call(
    request: unknown,
    signal?: AbortSignal,
    timeoutMs = 20000,
  ): Promise<ReturnType<typeof HelperResult.parse>> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], {
        windowsHide: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let output = "";
      let done = false;
      let terminationError: Error | undefined;
      const finish = (error?: Error) => {
        if (done) return;
        done = true;
        clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
      };
      // Recovery must not run until the mutating helper has fully exited.
      const terminate = (error: Error) => {
        if (done || terminationError) return;
        terminationError = error;
        child.kill();
      };
      const abort = () =>
        terminate(
          new Error(
            "Operation cancelled; recovery will restore the captured state.",
          ),
        );
      const timeout = setTimeout(
        () => terminate(new Error("Windows helper timed out.")),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        if (terminationError) return;
        output += chunk.toString();
        if (output.length > 1024 * 1024)
          terminate(new Error("Helper response exceeded the limit."));
      });
      child.stderr.on("data", () => {
        /* Helper diagnostics are intentionally not copied into user logs. */
      });
      child.on("error", () => {
        if (!child.pid) finish(new Error("Windows helper could not start."));
        else terminate(new Error("Windows helper failed."));
      });
      child.on("close", (code) => {
        if (done) return;
        if (terminationError) {
          finish(terminationError);
          return;
        }
        try {
          if (code !== 0) throw new Error("Windows helper failed.");
          const result = HelperResult.parse(JSON.parse(output));
          if (!result.ok)
            throw Object.assign(new Error(result.message), {
              code: result.code,
            });
          finish();
          resolve(result);
        } catch (e) {
          finish(
            e instanceof Error ? e : new Error("Invalid helper response."),
          );
        }
      });
      child.stdin.on("error", () =>
        terminate(new Error("Windows helper input failed.")),
      );
      if (signal?.aborted) {
        abort();
        return;
      }
      child.stdin.end(JSON.stringify(request) + "\n");
    });
  }
  // power-plan needs a performance plan (High performance, Ultimate or the owned copy); a read-only capture tells.
  async probe(): Promise<string | null> {
    let absent = false;
    let warning: string | null = null;
    try {
      await this.capture(["power-plan"]);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      // Only the helper's own refusal means the plan is missing; anything else is a failed check.
      absent = /not present/i.test(message);
      if (!absent)
        warning = `The power plan check failed (${message}). Retry Refresh.`;
    }
    // Windows version, GPU driver and similar facts decide which of the remaining optimizations exist on this PC.
    let here: Set<string> | null = null;
    try {
      const result = await this.call({ command: "supported" });
      here = new Set(result.supported ?? []);
    } catch {
      warning ??= "The Windows compatibility check failed. Retry Refresh.";
    }
    this.capabilities = WindowsPlatform.supported.filter(
      (id) =>
        (!absent || id !== "power-plan") &&
        (!here || id === "power-plan" || here.has(id)),
    );
    return warning;
  }
  async hardware() {
    const result = await this.call({ command: "hardware" });
    if (!result.hardware) throw new Error("Missing hardware response");
    return result.hardware;
  }
  // Reading the boot store needs one administrator prompt; the confirm step reuses the preview's answer for a few minutes.
  private bootCapture = new Map<string, { at: number; snapshot: Snapshot }>();
  // The elevated apply step re-reads what it wrote, so verify does not ask for approval a second time.
  private appliedCheck: { key: string; verified: boolean } | null = null;
  private static key(ids: OperationId[]) {
    return [...ids].sort().join(",");
  }
  private static elevatedTimeout = 330000;
  async capture(ids: OperationId[], reuse = false) {
    const needsAdmin = ids.some((id) => bootStoreIds.includes(id));
    const key = WindowsPlatform.key(ids);
    const hit = this.bootCapture.get(key);
    this.bootCapture.delete(key);
    if (reuse && needsAdmin && hit && Date.now() - hit.at < 300000)
      return hit.snapshot;
    const result = await this.call(
      { command: "capture", ids, ownedPlan: this.ownedPlan },
      undefined,
      needsAdmin ? WindowsPlatform.elevatedTimeout : 20000,
    );
    if (!result.snapshot) throw new Error("Missing Windows snapshot");
    if (needsAdmin)
      this.bootCapture.set(key, { at: Date.now(), snapshot: result.snapshot });
    return result.snapshot;
  }
  async apply(ids: OperationId[], signal: AbortSignal, snapshot: Snapshot) {
    const machine = ids.some((id) => adminIds.includes(id));
    this.appliedCheck = null;
    const result = await this.call(
      { command: "apply", ids, snapshot, ownedPlan: this.ownedPlan },
      signal,
      machine ? WindowsPlatform.elevatedTimeout : 20000,
    );
    if (typeof result.verified === "boolean")
      this.appliedCheck = {
        key: WindowsPlatform.key(ids),
        verified: result.verified,
      };
  }
  async verify(ids: OperationId[]) {
    const check = this.appliedCheck;
    this.appliedCheck = null;
    let rest = ids;
    if (check && check.key === WindowsPlatform.key(ids)) {
      if (!check.verified) return false;
      rest = ids.filter((id) => !adminIds.includes(id));
      if (!rest.length) return true;
    }
    return (
      (
        await this.call({
          command: "verify",
          ids: rest,
          ownedPlan: this.ownedPlan,
        })
      ).verified === true
    );
  }
  async restore(snapshot: Snapshot, force: boolean) {
    this.bootCapture.clear();
    const machine = snapshot.values.some((v) => adminIds.includes(v.operation));
    const result = await this.call(
      { command: "restore", snapshot, force, ownedPlan: this.ownedPlan },
      undefined,
      machine ? WindowsPlatform.elevatedTimeout : 20000,
    );
    const plain = "Snapshot restored and verified.";
    return result.message.startsWith(plain)
      ? result.message.slice(plain.length).trim() || undefined
      : undefined;
  }
  async recheck(ids: OperationId[]) {
    const result = await this.call({ command: "recheck", ids });
    return (result.drifted ?? []).filter(
      (id): id is OperationId => OperationId.safeParse(id).success,
    );
  }
  async defenderStatus() {
    return (await this.call({ command: "defender-status" }, undefined, 10000))
      .message;
  }
  async restartExplorer() {
    return (await this.call({ command: "restart-explorer" })).message;
  }
  async runningGames(games: Game[]) {
    const result = await this.call(
      {
        command: "running-games",
        games: games.map((g) => ({
          id: g.id,
          path: g.path,
          executablePath: g.executablePath,
        })),
      },
      undefined,
      10000,
    );
    return result.runningGames ?? [];
  }
  async backgroundProcesses() {
    const result = await this.call(
      { command: "background-processes" },
      undefined,
      10000,
    );
    return result.backgroundProcesses ?? [];
  }
  async boostCapabilities(ownedPlan: string | null) {
    const result = await this.call({
      command: "boost-capabilities",
      ownedPlan,
    });
    if (!result.capabilities) throw new Error("Missing booster capabilities");
    return result.capabilities;
  }
  async boostRecover(
    captured: Captured[],
    ownedPlan: string | null,
    interactive = true,
  ) {
    // Restarting paused services opens one administrator prompt, which can outlast the usual 20 s budget.
    const result = await this.call(
      { command: "boost-recover", captured, ownedPlan, elevate: interactive },
      undefined,
      captured.some((c) => c.mechanism === "pauseServices")
        ? elevatedTimeout
        : 20000,
    );
    if (!result.reverts) throw new Error("Missing recovery results");
    return result.reverts;
  }
  async launchSetting(call: LaunchSettingCall) {
    const result = await this.call({
      command: "launch-setting",
      launch: {
        setting: call.setting,
        exe: call.exe,
        op: call.op,
        existed: call.existed ?? false,
        value: call.value ?? null,
        applied: call.applied ?? null,
      },
    });
    if (!result.launch) throw new Error("Missing launch setting result");
    return result.launch;
  }
  async networkCheck(host: string, count: number) {
    // Up to 30 pings at 1 s timeout and 200 ms spacing, plus name resolution.
    const result = await this.call(
      { command: "network-check", host, count },
      undefined,
      60000,
    );
    if (!result.network) throw new Error("Missing network check result");
    return result.network;
  }
  async createPowerPlan(destination: string) {
    await this.call({ command: "power-create-plan", ownedPlan: destination });
  }
  async deletePowerPlan(ownedPlan: string) {
    return (await this.call({ command: "power-delete-plan", ownedPlan }))
      .message;
  }
  // GC-7: the helper elevates itself; the Node side never builds a command line.
  private elevated(action: string, args: string[]) {
    return this.call(
      { command: "elevated", elevated: { action, args } },
      undefined,
      elevatedTimeout,
    );
  }
  async restoreStatus() {
    return restoreStatusOf(await this.call({ command: "restore-status" }));
  }
  async restoreList(): Promise<RestorePoints> {
    const result = await this.elevated("restore-list", []);
    return {
      points: result.restorePoints ?? [],
      available: !cancelled(result) && result.available === true,
      message: result.message,
      createdSequence: null,
      ...(cancelled(result) && { cancelled: true }),
    };
  }
  async restoreCreate(
    name: string,
    bypass: boolean,
    original: Frequency,
  ): Promise<PlatformCreateResult> {
    try {
      return createResultOf(
        await this.elevated("restore-create", [
          name,
          bypass ? "1" : "0",
          ...frequencyArgs(original),
        ]),
      );
    } catch (error) {
      // The elevated child may still finish; verify later instead of reporting failure.
      if (
        error instanceof Error &&
        error.message === "Windows helper timed out."
      )
        return {
          outcome: "pending",
          point: null,
          lastPoint: null,
          message:
            "Windows is still creating the restore point. Use Load restore points to verify it.",
          frequencyRestored: null,
          resultPath: null,
        };
      throw error;
    }
  }
  async restoreResult(resultPath: string) {
    const result = createResultOf(
      await this.call({ command: "elevated-result", resultPath }),
    );
    return result.outcome === "pending" ? null : result;
  }
  // An elevated request still running carries no status; re-read it unelevated instead.
  private async elevatedStatus(result: HelperOutput) {
    if (cancelled(result)) return null;
    // The unelevated re-read only has the any-drive hint, so it proves nothing about this request.
    if (result.code === "elevated-pending")
      return {
        ...(await this.restoreStatus()),
        protection: "unknown" as const,
        message: result.message,
        pending: true,
      };
    return restoreStatusOf(result);
  }
  async restoreEnable(drive: string) {
    const status = await this.elevatedStatus(
      await this.elevated("restore-enable", [drive]),
    );
    // The helper reports "enabled" after Enable only from the per-drive check.
    return status && !status.pending
      ? { ...status, systemDriveConfirmed: status.protection === "enabled" }
      : status;
  }
  async restoreFrequencySet(original: Frequency) {
    return this.elevatedStatus(
      await this.elevated("restore-frequency-set", frequencyArgs(original)),
    );
  }
  spawnSession(): SessionChannel {
    // detached: libuv otherwise puts the child in a kill-on-close job, and the helper
    // must outlive a crashed Frameforge long enough to revert (stdin EOF).
    const child = spawn(this.executable, ["--session"], {
      windowsHide: true,
      shell: false,
      detached: true,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const channel = new EventEmitter();
    let exited = false;
    const exit = () => {
      if (exited) return;
      exited = true;
      channel.emit("exit");
    };
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.length > 65536) return;
      try {
        channel.emit("event", JSON.parse(line));
      } catch {
        /* Ignore malformed helper lines; the session schema rejects them anyway. */
      }
    });
    child.on("error", exit);
    child.on("close", exit);
    child.stdin.on("error", () => {});
    return Object.assign(channel, {
      send: (command: unknown) => {
        if (child.stdin.writable)
          child.stdin.write(JSON.stringify(command) + "\n");
      },
      kill: () => child.kill(),
    });
  }
}
export function fallbackHardware(
  warning = "Windows helper unavailable. Only runtime readings are shown.",
): Hardware {
  return {
    source: "fallback",
    collectedAt: new Date().toISOString(),
    cpu: os.cpus()[0]?.model ?? "Unavailable",
    cores: os.cpus().length,
    gpu: [],
    memoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    os: `${os.type()} ${os.release()}`,
    drives: [],
    displays: [],
    drivers: [],
    warnings: [warning],
  };
}
export class MockPlatform implements Platform {
  capabilities: OperationId[] = [];
  applied: OperationId[] = [];
  failVerification = false;
  boostAvailable = false;
  /** Tests may supply the optional read-only checks. */
  defenderStatus?: () => Promise<string | null>;
  recheck?: (ids: OperationId[]) => Promise<OperationId[]>;
  constructor(testOperations = false) {
    if (testOperations) this.capabilities = ["mouse-precision", "capture-off"];
  }
  async hardware() {
    return fallbackHardware();
  }
  async capture(ids: OperationId[]): Promise<Snapshot> {
    return {
      values: ids.map((id) => ({
        operation: id,
        path: "test",
        name: "test",
        kind: "String",
        existed: true,
        value: "1",
      })),
    };
  }
  async apply(ids: OperationId[], signal: AbortSignal) {
    if (signal.aborted) throw new Error("Cancelled");
    this.applied = [...ids];
  }
  async verify() {
    return !this.failVerification;
  }
  async restore(): Promise<string | void> {
    this.applied = [];
  }
  async runningGames(): Promise<RunningGame[]> {
    return [];
  }
  async backgroundProcesses(): Promise<RunningProcess[]> {
    throw new Error("Game booster requires the Windows helper.");
  }
  async boostCapabilities() {
    return capabilitiesUnavailable("Game booster requires the Windows helper.");
  }
  async boostRecover(captured: Captured[]): Promise<MechanismResult[]> {
    void captured;
    throw new Error("Game booster requires the Windows helper.");
  }
  async launchSetting(call: LaunchSettingCall): Promise<LaunchResult> {
    void call;
    throw new Error("Launch settings need the Windows helper.");
  }
  async networkCheck(host: string, count: number): Promise<NetworkCheck> {
    void host;
    void count;
    throw new Error("The network check requires the Windows helper.");
  }
  async createPowerPlan(destination: string): Promise<void> {
    void destination;
    throw new Error("Game booster requires the Windows helper.");
  }
  async deletePowerPlan(ownedPlan: string): Promise<string> {
    void ownedPlan;
    throw new Error("Game booster requires the Windows helper.");
  }
  spawnSession(): SessionChannel {
    throw new Error("Game booster requires the Windows helper.");
  }
  async restartExplorer(): Promise<string> {
    throw new Error("Restarting Explorer requires the Windows helper.");
  }
  async restoreStatus(): Promise<PlatformRestoreStatus> {
    return {
      protection: "unknown",
      policyDisabled: false,
      configLocked: false,
      frequency: { existed: false, minutes: null },
      elevated: false,
      systemDrive: "C:",
      message: restoreUnavailable,
    };
  }
  async restoreList(): Promise<RestorePoints> {
    return {
      points: [],
      available: false,
      createdSequence: null,
      message: restoreUnavailable,
    };
  }
  // Overload signatures keep the full shape for test subclasses.
  restoreCreate(
    name: string,
    bypass: boolean,
    original: Frequency,
  ): Promise<PlatformCreateResult>;
  async restoreCreate(): Promise<PlatformCreateResult> {
    throw new Error(restoreUnavailable);
  }
  restoreEnable(drive: string): Promise<PlatformRestoreStatus | null>;
  async restoreEnable(): Promise<PlatformRestoreStatus | null> {
    throw new Error(restoreUnavailable);
  }
  restoreFrequencySet(
    original: Frequency,
  ): Promise<PlatformRestoreStatus | null>;
  async restoreFrequencySet(): Promise<PlatformRestoreStatus | null> {
    throw new Error(restoreUnavailable);
  }
  restoreResult(resultPath: string): Promise<PlatformCreateResult | null>;
  async restoreResult(): Promise<PlatformCreateResult | null> {
    return null;
  }
}
const restoreUnavailable =
  "Windows System Restore needs the Windows helper, which is not available in this build.";
