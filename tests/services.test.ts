import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BoostSessionSchema } from "../shared/contracts";
import { catalogue, serviceOpIds } from "../shared/catalogue";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";

const table = readFileSync(
  "windows/Frameforge.Windows/OptimizationTable.cs",
  "utf8",
);
const csServices = [
  ...(/ServiceOps = new\(\)\s*\{(.*?)\};/s.exec(table)?.[1] ?? "").matchAll(
    /\["([a-z0-9-]+)"\] = "([A-Za-z0-9]+)"/g,
  ),
];

describe("Windows service optimizations", () => {
  it("lists exactly the services the helper's table switches off", () => {
    expect(csServices.map((m) => m[1]).sort()).toEqual(
      [...serviceOpIds].sort(),
    );
    for (const [, id, service] of csServices) {
      const item = catalogue.find((o) => o.id === id)!;
      expect(item.admin).toBe(true);
      expect(item.tier).toBe("advanced");
      expect(item.restart).toBe("none");
      expect(item.settings.join(" ")).toContain(`\\Services\\${service}`);
      expect(item.rollback).toMatch(/exact start type/);
      expect(item.prerequisites.join(" ")).toMatch(/Game Mode is not running/);
    }
  });
  it("has no entry that only informs: every item with an Apply is applicable", () => {
    const review = catalogue.filter((o) => !o.supported).map((o) => o.id);
    expect(review).toEqual([]);
    expect(catalogue.map((o) => o.id)).not.toContain("service-tuning");
  });
  it("waits for Game Mode before changing or rolling back a service", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.capabilities = ["sysmain-off", "mouse-precision"];
    const engine = new OperationEngine(repo, platform);
    const preview = await engine.preview(["sysmain-off"]);
    const done = await engine.confirm(preview.token);
    expect(done.status).toBe("success");
    repo.saveBoostSession(
      BoostSessionSchema.parse({
        id: crypto.randomUUID(),
        gameId: crypto.randomUUID(),
        mode: "performance",
        target: {
          pid: 4242,
          startTime: "2026-10-13T00:00:00.0000000Z",
          executablePath: "C:\\Games\\game.exe",
          name: "game",
          priority: "High",
        },
        startedAt: new Date().toISOString(),
        status: "active",
        message: "Boosted.",
      }),
      [],
    );
    await expect(engine.preview(["sysmain-off"])).rejects.toThrow(
      /Stop Game Mode before changing a Windows service/,
    );
    await expect(engine.rollback(done.id)).rejects.toThrow(
      /Stop Game Mode before changing a Windows service/,
    );
    await expect(engine.preview(["mouse-precision"])).resolves.toBeTruthy();
    repo.close();
  });
  it("shows the adapter or NVIDIA setting name instead of a registry path", async () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform(true);
    platform.capabilities = ["lso-off"];
    platform.capture = async () => ({
      values: [
        {
          operation: "lso-off" as const,
          path: "HKLM\\SYSTEM\\x\\0000",
          name: "*LsoV2IPv4",
          kind: "String" as const,
          existed: true,
          value: "1",
          target: "0",
          label: "Ethernet - Realtek (*LsoV2IPv4)",
        },
      ],
    });
    const preview = await new OperationEngine(repo, platform).preview([
      "lso-off",
    ]);
    expect(preview.changes[0]).toMatchObject({
      setting: "Ethernet - Realtek (*LsoV2IPv4)",
      before: "1",
      after: '"0"',
    });
    expect(preview.restart).toBe("reboot");
    expect(preview.admin).toBe(true);
    repo.close();
  });
});
