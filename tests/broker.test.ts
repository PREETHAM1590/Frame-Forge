import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { catalogue } from "../shared/catalogue";
import { BrokerController, brokerUnsupported } from "../electron/broker";
import {
  ElevationGate,
  MockPlatform,
  WindowsPlatform,
} from "../electron/platform";
import type { BrokerStatus } from "../shared/contracts";
const ready: BrokerStatus = { state: "ready", message: "ok", version: "1.4.0" };
const absent: BrokerStatus = { state: "not-installed", message: "no" };
describe("admin service controller", () => {
  it("is silent only while the helper reports the service ready", async () => {
    let answer = ready;
    const controller = new BrokerController(async () => answer);
    expect(controller.ready).toBe(false);
    await controller.refresh();
    expect(controller.ready).toBe(true);
    answer = { state: "needs-update", message: "old" };
    await controller.refresh();
    expect(controller.ready).toBe(false);
  });
  it("treats an unreadable status as unhealthy, never as ready", async () => {
    const controller = new BrokerController(async () => {
      throw new Error("helper failed");
    });
    expect((await controller.refresh()).state).toBe("unhealthy");
    expect(controller.ready).toBe(false);
  });
  it("re-reads the status in the background when it is a minute old", async () => {
    let now = 0;
    const call = vi.fn(async () => ready);
    const controller = new BrokerController(call, () => now);
    await controller.refresh();
    now = 30000;
    expect(controller.silent).toBe(true);
    expect(call).toHaveBeenCalledTimes(1);
    now = 61000;
    expect(controller.silent).toBe(true);
    expect(call).toHaveBeenCalledTimes(2);
  });
  it("keeps the real state after a declined install and passes the reason on", async () => {
    const calls: string[] = [];
    const controller = new BrokerController(async (command) => {
      calls.push(command);
      if (command === "broker-install")
        throw new Error(
          "Administrator approval was declined. Nothing was changed.",
        );
      return absent;
    });
    await expect(controller.install()).rejects.toThrow(/declined/);
    expect(calls).toEqual(["broker-install", "broker-status"]);
    expect(controller.status).toEqual(absent);
  });
  it("starts out unsupported", () => {
    expect(new BrokerController(async () => ready).status).toEqual(
      brokerUnsupported,
    );
  });
});
describe("elevation routing", () => {
  it("routes to the prompt by default and to the service when it is ready", () => {
    const gate = new ElevationGate();
    expect([gate.route, gate.silent]).toEqual(["uac", false]);
    let up = true;
    gate.useBroker(() => up);
    expect([gate.route, gate.silent]).toEqual(["broker", true]);
    up = false;
    expect([gate.route, gate.silent]).toEqual(["uac", false]);
  });
  it("still allows one administrator step at a time, with or without the service", async () => {
    const gate = new ElevationGate();
    gate.useBroker(() => true);
    gate.hold("optimize");
    expect(() => gate.hold("broker")).toThrow(/administrator approval/);
    gate.release("optimize");
    await expect(gate.with("broker", async () => gate.current)).resolves.toBe(
      "broker",
    );
    expect(gate.current).toBeNull();
  });
  it("mock platforms never claim silent admin access", () => {
    expect(new MockPlatform().elevation.silent).toBe(false);
  });
});
describe("Windows platform and the admin service", () => {
  function platform(status: BrokerStatus) {
    const windows = new WindowsPlatform("C:\\nowhere\\Frameforge.Windows.exe");
    const sent: unknown[] = [];
    (
      windows as unknown as { call: (request: unknown) => Promise<unknown> }
    ).call = async (request) => {
      sent.push(request);
      const command = (request as { command: string }).command;
      if (command.startsWith("broker-"))
        return { ok: true, message: "x", broker: status };
      return { ok: true, message: "x", reverts: [] };
    };
    return { windows, sent };
  }
  const services = [
    { mechanism: "pauseServices" as const, items: ["SysMain"] },
  ];
  it("startup recovery asks the helper for broker-only administrator steps and never a prompt", async () => {
    const { windows, sent } = platform(ready);
    await windows.probe?.();
    await windows.boostRecover(services as never, null, false);
    expect(sent.at(-1)).toMatchObject({
      command: "boost-recover",
      elevate: true,
      brokerOnly: true,
    });
  });
  it("without the service startup recovery still opens no prompt", async () => {
    const { windows, sent } = platform(absent);
    await windows.probe?.();
    await windows.boostRecover(services as never, null, false);
    expect(sent.at(-1)).toMatchObject({ elevate: false, brokerOnly: true });
  });
  it("an interactive recovery may prompt, and is not broker-only", async () => {
    const { windows, sent } = platform(absent);
    await windows.boostRecover(services as never, null, true);
    expect(sent.at(-1)).toMatchObject({ elevate: true, brokerOnly: false });
  });
  it("probe, install and remove go through the helper and update the gate", async () => {
    const { windows, sent } = platform(ready);
    expect(windows.elevation.route).toBe("uac");
    await windows.brokerStatus();
    expect(windows.elevation.route).toBe("broker");
    expect(sent).toContainEqual({ command: "broker-status" });
    await expect(windows.brokerInstall()).resolves.toEqual(ready);
    expect(sent).toContainEqual({ command: "broker-install" });
    (windows as unknown as { call: () => Promise<unknown> }).call =
      async () => ({
        ok: true,
        message: "x",
        broker: absent,
      });
    await windows.brokerRemove();
    expect(windows.elevation.route).toBe("uac");
  });
});
describe("security-lowering items and the admin service", () => {
  const helperSecurity = () => {
    const source = readFileSync(
      "windows/Frameforge.Windows/OptimizationTable.cs",
      "utf8",
    );
    const list = /Security = \[([^\]]*)\]/.exec(source)![1]!;
    return [...list.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]!).sort();
  };
  it("the helper's never-through-the-service list is exactly the catalogue's security tier", () => {
    const tier = catalogue
      .filter((o) => o.tier === "security")
      .map((o) => o.id as string)
      .sort();
    expect(tier.length).toBeGreaterThan(5);
    expect(helperSecurity()).toEqual(tier);
  });
  it("still sends them to the helper (which opens its own Windows prompt for them) under the gate while the service is ready", async () => {
    const windows = new WindowsPlatform("C:\\nowhere\\Frameforge.Windows.exe");
    const sent: { command: string; ids?: string[] }[] = [];
    let during: string | null = null;
    (
      windows as unknown as { call: (request: unknown) => Promise<unknown> }
    ).call = async (request) => {
      const r = request as { command: string; ids?: string[] };
      sent.push(r);
      if (r.command === "broker-status")
        return { ok: true, message: "x", broker: ready };
      during = windows.elevation.current;
      return { ok: true, message: "x", verified: true };
    };
    await windows.brokerStatus();
    expect(windows.elevation.silent).toBe(true);
    await windows.apply(["uac-off"] as never, new AbortController().signal, {
      values: [],
    } as never);
    // One serialized administrator step carrying the item's own id, so the helper can tell it must use a prompt.
    expect(sent.at(-1)).toMatchObject({ command: "apply", ids: ["uac-off"] });
    expect(during).toBe("optimize");
  });
});
