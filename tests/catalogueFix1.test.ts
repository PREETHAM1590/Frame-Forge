import { describe, expect, it } from "vitest";
import { catalogue } from "../shared/catalogue";
import { HelperResult } from "../shared/contracts";
import { OperationEngine } from "../electron/operations";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService } from "../electron/service";

describe("fix round 1: honest labels, drift, notes", () => {
  it("parses the helper's real snapshot shape, including null key counts", () => {
    // Captured from the published helper: a value that existed carries "created": null.
    const reply = {
      ok: true,
      message: "Snapshot captured.",
      snapshot: {
        values: [
          {
            operation: "classic-context-menu",
            path: "Software\\Classes\\CLSID\\x\\InprocServer32",
            name: "",
            kind: "String",
            existed: false,
            value: null,
            target: "",
            created: 2,
          },
          {
            operation: "storage-sense-off",
            path: "Software\\p",
            name: "01",
            kind: "DWord",
            existed: true,
            value: 1,
            target: 0,
            created: null,
          },
        ],
      },
    };
    expect(HelperResult.parse(reply).snapshot?.values).toHaveLength(2);
    expect(
      HelperResult.parse({ ok: true, message: "ok", drifted: ["uac-off"] })
        .drifted,
    ).toEqual(["uac-off"]);
  });
  it("labels what the person has to do for browser, wallpaper and sign-in items", () => {
    const restart = (id: string) => catalogue.find((o) => o.id === id)!.restart;
    expect(restart("browser-background-off")).toBe("browser");
    expect(restart("browser-hwaccel-off")).toBe("browser");
    expect(restart("jpeg-wallpaper-quality")).toBe("wallpaper");
    expect(restart("onedrive-startup-off")).toBe("signin");
  });
  it("claims only what is checked for Defender, VBS and UCPD", () => {
    const text = (id: string) => {
      const o = catalogue.find((x) => x.id === id)!;
      return `${o.description} ${o.reason}`;
    };
    expect(text("defender-off")).toMatch(/not guaranteed/);
    expect(text("defender-off")).toMatch(
      /does not confirm that Defender is actually off/,
    );
    expect(text("vbs-hyperv-off")).not.toMatch(/verified after the restart/);
    expect(text("vbs-hyperv-off")).toMatch(/does not confirm/);
    expect(text("ucpd-off")).not.toMatch(/reports that after verification/);
    expect(text("ucpd-off")).toMatch(/does not check the driver itself/);
  });
  const setup = () => {
    const repo = new Repository(":memory:");
    const platform = new MockPlatform();
    platform.capabilities = ["defender-off", "uac-off"];
    platform.capture = async (ids) => ({
      values: ids.map((id) => ({
        operation: id,
        path: "HKLM\\x",
        name: "n",
        kind: "DWord" as const,
        existed: false,
        value: null,
        target: 1,
      })),
    });
    return { repo, platform, engine: new OperationEngine(repo, platform) };
  };
  it("shows Defender's own state before and after, and says only policy values were verified", async () => {
    const { repo, platform, engine } = setup();
    platform.defenderStatus = async () =>
      "Defender reports antivirus on and real-time protection on.";
    const preview = await engine.preview(["defender-off"]);
    expect(preview.warnings.join(" ")).toMatch(
      /Windows Defender now: Defender reports antivirus on and real-time protection on/,
    );
    const done = await engine.confirm(preview.token, ["defender-off"]);
    expect(done.message).toMatch(/real-time protection on/);
    expect(done.message).toMatch(/Only the policy values are verified/);
    repo.close();
  });
  it("adds the helper's note to a rollback and surfaces a failed machine step", async () => {
    const { repo, platform, engine } = setup();
    platform.restore = async () =>
      "Windows had already changed EnableLUA to something else; it was set back to the value captured before.";
    const preview = await engine.preview(["uac-off"]);
    const done = await engine.confirm(preview.token, ["uac-off"]);
    const rolled = await engine.rollback(done.id);
    expect(rolled.status).toBe("rolled-back");
    expect(rolled.message).toMatch(/Windows had already changed EnableLUA/);
    platform.apply = async () => {
      throw new Error(
        "The machine-level step did not complete: Administrator approval was declined. Nothing was changed. The current-user changes made before it were undone.",
      );
    };
    const second = await engine.preview(["uac-off"]);
    const failed = await engine.confirm(second.token, ["uac-off"]);
    expect(failed.status).toBe("failed");
    expect(failed.message).toMatch(
      /machine-level step did not complete: Administrator approval was declined/,
    );
    repo.close();
  });
  it("reports applied optimizations that Windows changed back, at start and refresh", async () => {
    const { repo, platform } = setup();
    platform.capabilities = ["uac-off", "transparency-off"];
    const backup = repo.backup("x");
    const row = repo.beginOperation(
      ["uac-off", "transparency-off"],
      { values: [] },
      backup.id,
    );
    repo.finish(row.id, "success", "ok");
    platform.recheck = async (ids) => {
      expect(ids).toEqual(["uac-off"]); // only revert-prone items are re-read
      return ["uac-off"];
    };
    const service = new AppService(repo, platform, {
      pickGame: async () => null,
      detectGames: async () => ({
        games: [],
        warnings: [],
        launchers: [],
        perLauncher: [],
      }),
      scanFolder: async () => null,
      setStartup: () => {},
      version: "test",
    });
    const data = (await service.dispatch("bootstrap", {})) as {
      drifted: { activityId: string; ids: string[] }[];
    };
    expect(data.drifted).toEqual([{ activityId: row.id, ids: ["uac-off"] }]);
    platform.recheck = async () => [];
    const again = (await service.dispatch("bootstrap", {})) as {
      drifted: unknown[];
    };
    expect(again.drifted).toEqual([]);
    repo.close();
  });
});
