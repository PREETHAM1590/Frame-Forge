import { describe, expect, it, vi } from "vitest";
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
