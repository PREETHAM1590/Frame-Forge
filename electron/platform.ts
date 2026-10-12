import { spawn } from "node:child_process";
import os from "node:os";
import {
  HelperResult,
  type Hardware,
  type OperationId,
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
}
export class WindowsPlatform implements Platform {
  capabilities: OperationId[] = ["mouse-precision", "capture-off"];
  constructor(private executable: string) {}
  private call(
    request: unknown,
    signal?: AbortSignal,
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
        20000,
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
}
