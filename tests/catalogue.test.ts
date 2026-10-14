import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  adminIds,
  applicableIds,
  bootStoreIds,
  catalogue,
  presets,
  securityIds,
  upsertPreset,
} from "../shared/catalogue";
import { OperationId } from "../shared/contracts";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";

// The C# table is the enforcement point; this test keeps the catalogue honest about it.
const table = readFileSync(
  "windows/Frameforge.Windows/OptimizationTable.cs",
  "utf8",
);
const rows = table
  .split("\n")
  .filter((l) => /^\s+(D|S|B|Sv|Ss|new)\("[a-z0-9-]+"/.test(l))
  .map((l) => ({
    id: /\("([a-z0-9-]+)"/.exec(l)![1]!,
    // Constants in the table that hold machine paths count as machine settings.
    machine:
      /HKLM|WinPolicy|WuPolicy|ExplorerPolicy|\bEdge\b|\bChrome\b|\bMm\b|\bDg\b|Defender|\bB\(|\bSv\(|\bSs\(|PvCap/.test(
        l,
      ),
    boot: /\bB\(/.test(l),
  }))
  .filter((r) => r.id !== "game-mode");
const csIds = [...new Set(rows.map((r) => r.id))];

describe("optimization catalogue", () => {
  it("has exactly one complete entry for every operation id", () => {
    const ids = catalogue.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...OperationId.options].sort());
    for (const o of catalogue) {
      expect(o.name.length).toBeGreaterThan(3);
      expect(o.rollback.length).toBeGreaterThan(10);
      expect(o.settings.length).toBeGreaterThan(0);
      expect(o.prerequisites.length).toBeGreaterThan(0);
      if (o.supported) {
        expect(o.description).not.toMatch(/\bFPS (gain|boost|increase)/i);
        expect(o.reason.length).toBeGreaterThan(10);
      }
    }
  });
  it("matches the Windows helper's table", () => {
    expect(csIds.filter((id) => id !== "power-plan").sort()).toEqual(
      applicableIds.filter((id) => id !== "power-plan").sort(),
    );
    expect(
      [...new Set(rows.filter((r) => r.machine).map((r) => r.id))].sort(),
    ).toEqual([...adminIds].sort());
    expect(
      [...new Set(rows.filter((r) => r.boot).map((r) => r.id))].sort(),
    ).toEqual([...bootStoreIds].sort());
    const security = /Security = \[(.*?)\];/s.exec(table)![1]!;
    expect(
      [...security.matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).sort(),
    ).toEqual([...securityIds].sort());
  });
  it("labels admin, security and advanced items consistently", () => {
    for (const o of catalogue.filter((x) => x.tier === "security")) {
      expect(o.risk).toBe("High");
      expect(o.category).toBe("Security trade-offs");
      expect(o.admin).toBe(true);
      expect(o.consequence?.length).toBeGreaterThan(20);
    }
    for (const o of catalogue.filter((x) => x.admin))
      expect(o.tier).not.toBe("standard");
    for (const o of catalogue.filter(
      (x) => x.tier === "standard" && x.supported,
    ))
      expect(o.admin).toBe(false);
  });
  it("keeps presets to safe, current-user, low-risk items", () => {
    for (const p of presets)
      for (const id of p.ids) {
        const o = catalogue.find((x) => x.id === id)!;
        expect(o.supported).toBe(true);
        expect(o.tier).toBe("standard");
        expect(o.admin).toBe(false);
        expect(securityIds).not.toContain(id);
      }
    const beginner = presets.find((p) => p.name === "Beginner")!;
    for (const id of beginner.ids)
      expect(catalogue.find((x) => x.id === id)!.risk).toBe("Low");
  });
  it("never saves a security trade-off into a custom preset", () => {
    expect(() =>
      upsertPreset([], { name: "Mine", ids: ["defender-off"] }, () =>
        crypto.randomUUID(),
      ),
    ).toThrow(/never part of a preset/);
  });
  it("has no information-only entries: every offered item can be applied", () => {
    for (const o of catalogue.filter((x) => !x.supported))
      expect([
        "hardware-scheduling",
        "startup-review",
        "driver-review",
        "dns-tuning",
      ]).toContain(o.id);
    expect(catalogue.some((o) => o.name.startsWith("Not offered"))).toBe(false);
  });
});

describe("security trade-offs in the engine", () => {
  const setup = () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform();
    platform.capabilities = ["uac-off", "transparency-off"];
    platform.capture = async (ids) => ({
      values: ids.map((id) => ({
        operation: id,
        path: "HKLM\\SOFTWARE\\x",
        name: "EnableLUA",
        kind: "DWord" as const,
        existed: false,
        value: null,
        target: 0,
      })),
    });
    return { repo, platform, engine: new OperationEngine(repo, platform) };
  };
  it("previews the exact target, consequence, restart and administrator need", async () => {
    const { repo, engine } = setup();
    const preview = await engine.preview(["uac-off"]);
    expect(preview.changes[0]).toMatchObject({
      before: "Not set",
      after: "0 (DWORD)",
    });
    expect(preview.security).toEqual(["uac-off"]);
    expect(preview.admin).toBe(true);
    expect(preview.restart).toBe("reboot");
    expect(preview.warnings.join(" ")).toMatch(/administrator/);
    expect(preview.warnings.join(" ")).toMatch(/full administrator power/);
    repo.close();
  });
  it("refuses to apply without the acknowledgement and applies with it", async () => {
    const { repo, engine, platform } = setup();
    const first = await engine.preview(["uac-off"]);
    await expect(engine.confirm(first.token)).rejects.toThrow(
      /Acknowledge.*Turn off User Account Control/,
    );
    expect(platform.applied).toEqual([]);
    expect(repo.activity()).toHaveLength(0);
    const second = await engine.preview(["uac-off"]);
    // A different item's acknowledgement does not count.
    await expect(
      engine.confirm(second.token, ["transparency-off"]),
    ).rejects.toThrow(/Acknowledge/);
    const third = await engine.preview(["uac-off"]);
    const done = await engine.confirm(third.token, ["uac-off"]);
    expect(done.status).toBe("success");
    expect(done.message).toMatch(/Restart the PC/);
    repo.close();
  });
  it("says so when Windows reverted the change instead of reporting success", async () => {
    const { repo, engine, platform } = setup();
    platform.failVerification = true;
    const preview = await engine.preview(["uac-off"]);
    const done = await engine.confirm(preview.token, ["uac-off"]);
    expect(done.status).toBe("failed");
    expect(done.message).toMatch(/reverted or did not keep the change/);
    repo.close();
  });
  it("does not ask for an acknowledgement for ordinary items", async () => {
    const { repo, engine } = setup();
    const preview = await engine.preview(["transparency-off"]);
    expect(preview.security).toEqual([]);
    expect((await engine.confirm(preview.token)).status).toBe("success");
    repo.close();
  });
});
