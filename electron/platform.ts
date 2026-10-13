import { spawn } from "node:child_process";
import os from "node:os";
import {
  HelperResult,
  type CreateRestorePointResult,
  type Frequency,
  type HelperRestoreStatus,
  type RestorePoints,
  type Game,
  type Hardware,
  type OperationId,
  type ProcessTarget,
  type Snapshot,
} from "../shared/contracts.js";
export interface Platform {
  capabilities: OperationId[];
  hardware(): Promise<Hardware>;
  capture(ids: OperationId[]): Promise<Snapshot>;
  apply(
    ids: OperationId[],
    signal: AbortSignal,
    snapshot: Snapshot,
  ): Promise<void>;
  verify(ids: OperationId[]): Promise<boolean>;
  restore(snapshot: Snapshot, force: boolean): Promise<void>;
  boostAvailable: boolean;
  gameProcesses(game: Game): Promise<ProcessTarget[]>;
  boostStart(expected: ProcessTarget): Promise<ProcessTarget>;
  boostStop(snapshot: ProcessTarget): Promise<string>;
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
}
export type PlatformRestoreStatus = HelperRestoreStatus & { message: string };
export type PlatformCreateResult = CreateRestorePointResult & {
  frequencyRestored: boolean | null;
  resultPath: string | null;
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
  capabilities: OperationId[] = [
    "mouse-precision",
    "capture-off",
    "power-plan",
  ];
  boostAvailable = true;
  constructor(private executable: string) {}
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
          if (!result.ok) throw new Error(result.message);
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
  async hardware() {
    const result = await this.call({ command: "hardware" });
    if (!result.hardware) throw new Error("Missing hardware response");
    return result.hardware;
  }
  async capture(ids: OperationId[]) {
    const result = await this.call({ command: "capture", ids });
    if (!result.snapshot) throw new Error("Missing Windows snapshot");
    return result.snapshot;
  }
  async apply(ids: OperationId[], signal: AbortSignal, snapshot: Snapshot) {
    await this.call({ command: "apply", ids, snapshot }, signal);
  }
  async verify(ids: OperationId[]) {
    return (await this.call({ command: "verify", ids })).verified === true;
  }
  async restore(snapshot: Snapshot, force: boolean) {
    await this.call({ command: "restore", snapshot, force });
  }
  async gameProcesses(game: Game) {
    const result = await this.call(
      {
        command: "processes",
        gamePath: game.path,
        executablePath: game.executablePath,
      },
      undefined,
      10000,
    );
    return result.processes ?? [];
  }
  async boostStart(expected: ProcessTarget) {
    const result = await this.call({
      command: "boost-start",
      target: expected,
    });
    if (!result.boostSnapshot) throw new Error("Missing process snapshot");
    return result.boostSnapshot;
  }
  async boostStop(snapshot: ProcessTarget) {
    return (await this.call({ command: "boost-stop", target: snapshot }))
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
    if (result.code === "elevated-pending")
      return { ...(await this.restoreStatus()), message: result.message };
    return restoreStatusOf(result);
  }
  async restoreEnable(drive: string) {
    return this.elevatedStatus(await this.elevated("restore-enable", [drive]));
  }
  async restoreFrequencySet(original: Frequency) {
    return this.elevatedStatus(
      await this.elevated("restore-frequency-set", frequencyArgs(original)),
    );
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
  async restore() {
    this.applied = [];
  }
  async gameProcesses(): Promise<ProcessTarget[]> {
    return [];
  }
  async boostStart(expected: ProcessTarget): Promise<ProcessTarget> {
    throw new Error(`Game booster is unavailable for ${expected.name}.`);
  }
  async boostStop(): Promise<string> {
    throw new Error("Game booster is unavailable.");
  }
  async restoreStatus(): Promise<PlatformRestoreStatus> {
    return {
      protection: "unknown",
      policyDisabled: false,
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
