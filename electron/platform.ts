import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import os from "node:os";
import {
  HelperResult,
  type BoostCapabilities,
  type Captured,
  type Game,
  type Hardware,
  type MechanismResult,
  type OperationId,
  type ProcessTarget,
  type RunningProcess,
  type Snapshot,
} from "../shared/contracts.js";
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
    ] as const
  ).map((id) => ({ id, available: false, detail })),
});
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
  runningGames(games: Game[]): Promise<RunningGame[]>;
  backgroundProcesses(): Promise<RunningProcess[]>;
  boostCapabilities(): Promise<BoostCapabilities>;
  boostRecover(captured: Captured[]): Promise<MechanismResult[]>;
  spawnSession(): SessionChannel;
}
export class WindowsPlatform implements Platform {
  capabilities: OperationId[] = ["mouse-precision", "capture-off"];
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
  async boostCapabilities() {
    const result = await this.call({ command: "boost-capabilities" });
    if (!result.capabilities) throw new Error("Missing booster capabilities");
    return result.capabilities;
  }
  async boostRecover(captured: Captured[]) {
    const result = await this.call({ command: "boost-recover", captured });
    if (!result.reverts) throw new Error("Missing recovery results");
    return result.reverts;
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
  spawnSession(): SessionChannel {
    throw new Error("Game booster requires the Windows helper.");
  }
}
