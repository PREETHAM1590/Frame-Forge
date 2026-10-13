import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform, type LaunchSettingCall } from "../electron/platform";
import { LaunchSettingsService } from "../electron/launchSettings";
import { AppService, type DesktopServices } from "../electron/service";
import {
  GameSchema,
  LaunchResultSchema,
  requests,
  type LaunchResult,
  type LaunchSetting,
} from "../shared/contracts";
const exe = "C:\\Games\\Test\\game.exe";
// A fake registry behind the helper's launch-setting command, with the same state rules as LaunchSettings.cs.
class FakeHelper extends MockPlatform {
  override boostAvailable = true;
  values = new Map<string, string>();
  calls: LaunchSettingCall[] = [];
  gpus = 2;
  failApply = false;
  private key = (c: LaunchSettingCall) => `${c.setting}|${c.exe}`;
  private next(setting: LaunchSetting, prior: string | undefined) {
    if (setting === "gpuPreference")
      return (
        [
          ...(prior ?? "")
            .split(";")
            .filter((p) => p && !p.startsWith("GpuPreference=")),
          "GpuPreference=2",
        ].join(";") + ";"
      );
    return prior
      ? prior.includes("DISABLEDXMAXIMIZEDWINDOWEDMODE")
        ? prior
        : `${prior} DISABLEDXMAXIMIZEDWINDOWEDMODE`
      : "~ DISABLEDXMAXIMIZEDWINDOWEDMODE";
  }
  override async launchSetting(call: LaunchSettingCall): Promise<LaunchResult> {
    this.calls.push(call);
    const k = this.key(call);
    const base = {
      setting: call.setting,
      exe: call.exe,
      current: null,
      after: null,
      existed: false,
    };
    const result = (r: Partial<LaunchResult> & Pick<LaunchResult, "state">) =>
      LaunchResultSchema.parse({ ...base, detail: r.state, ...r });
    if (call.op === "revert") {
      const current = this.values.get(k);
      const existed = call.existed ?? false;
      if (current === (existed ? (call.value ?? undefined) : undefined))
        return result({ state: "reverted", existed });
      if (current !== call.applied)
        return result({ state: "conflict", current: current ?? null, existed });
      if (existed) this.values.set(k, call.value ?? "");
      else this.values.delete(k);
      return result({ state: "reverted", existed });
    }
    if (call.setting === "gpuPreference" && this.gpus < 2)
      return result({ state: "unsupported", detail: "Only one adapter." });
    const prior = this.values.get(k);
    const after = this.next(call.setting, prior);
    if (prior === after)
      return result({
        state: "already-set",
        current: prior ?? null,
        after,
        existed: true,
      });
    if (call.op === "read")
      return result({
        state: "ready",
        current: prior ?? null,
        after,
        existed: prior !== undefined,
      });
    if (this.failApply) throw new Error("Windows refused.");
    this.values.set(k, after);
    return result({
      state: "applied",
      current: prior ?? null,
      after,
      existed: prior !== undefined,
    });
  }
}
function setup(executablePath: string | null = exe) {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source: "steam",
    executablePath,
    profile: "gaming",
    notes: "",
  });
  repo.updateState({ ...repo.state(), games: [game] });
  const platform = new FakeHelper();
  return {
    repo,
    game,
    platform,
    service: new LaunchSettingsService(repo, platform),
  };
}
const activity = (repo: Repository) =>
  repo
    .activity()
    .filter((a) => a.label === "Launch settings")
    .map((a) => a.message);
describe("per-game launch settings", () => {
  it("previews, applies with the prior saved first, logs, and reverts to the exact prior value", async () => {
    const { repo, game, platform, service } = setup();
    platform.values.set(`gpuPreference|${exe}`, "AutoHDREnable=2097;");
    const status = await service.status(game.id);
    expect(status.settings.map((s) => [s.setting, s.state])).toEqual([
      ["gpuPreference", "ready"],
      ["fullscreenOptimizations", "ready"],
    ]);
    expect(platform.values.get(`gpuPreference|${exe}`)).toBe(
      "AutoHDREnable=2097;",
    );
    const preview = await service.preview(game.id, "gpuPreference", "apply");
    expect(preview).toMatchObject({
      before: "AutoHDREnable=2097;",
      after: "AutoHDREnable=2097;GpuPreference=2;",
      exe,
    });
    expect(preview.warning).toContain("next time the game starts");
    // Nothing was written by the preview.
    expect(platform.values.get(`gpuPreference|${exe}`)).toBe(
      "AutoHDREnable=2097;",
    );
    const applied = await service.apply(game.id, "gpuPreference", "apply");
    expect(applied.settings[0]).toMatchObject({
      state: "applied",
      canRevert: true,
    });
    // The prior value is in SQLite.
    expect(repo.meta(`launch:${game.id}:gpuPreference`)).toMatchObject({
      exe,
      existed: true,
      value: "AutoHDREnable=2097;",
      applied: "AutoHDREnable=2097;GpuPreference=2;",
    });
    expect(
      activity(repo).some((m) => m.includes("set. Prior value saved")),
    ).toBe(true);
    expect(service.hasRecords(game.id)).toBe(true);
    const reverted = await service.apply(game.id, "gpuPreference", "revert");
    expect(platform.values.get(`gpuPreference|${exe}`)).toBe(
      "AutoHDREnable=2097;",
    );
    expect(reverted.settings[0]).toMatchObject({
      state: "ready",
      canRevert: false,
    });
    expect(repo.meta(`launch:${game.id}:gpuPreference`)).toBeNull();
    expect(activity(repo).some((m) => m.includes("reverted"))).toBe(true);
  });
  it("restores an absent value by deleting it", async () => {
    const { game, platform, service } = setup();
    await service.apply(game.id, "fullscreenOptimizations", "apply");
    expect(platform.values.get(`fullscreenOptimizations|${exe}`)).toBe(
      "~ DISABLEDXMAXIMIZEDWINDOWEDMODE",
    );
    await service.apply(game.id, "fullscreenOptimizations", "revert");
    expect(platform.values.has(`fullscreenOptimizations|${exe}`)).toBe(false);
  });
  it("keeps the record on an outside change and lets the user forget it", async () => {
    const { repo, game, platform, service } = setup();
    await service.apply(game.id, "gpuPreference", "apply");
    platform.values.set(`gpuPreference|${exe}`, "Other=1;");
    const status = await service.status(game.id);
    expect(status.settings[0]).toMatchObject({
      state: "conflict",
      canRevert: true,
    });
    const after = await service.apply(game.id, "gpuPreference", "revert");
    expect(after.settings[0]!.state).toBe("conflict");
    expect(platform.values.get(`gpuPreference|${exe}`)).toBe("Other=1;");
    expect(activity(repo).some((m) => m.includes("not reverted"))).toBe(true);
    await service.apply(game.id, "gpuPreference", "forget");
    expect(service.hasRecords(game.id)).toBe(false);
    expect(platform.values.get(`gpuPreference|${exe}`)).toBe("Other=1;");
  });
  it("is unsupported without a second GPU or an executable, and never changes anything then", async () => {
    const one = setup();
    one.platform.gpus = 1;
    const status = await one.service.status(one.game.id);
    expect(status.settings[0]!.state).toBe("unsupported");
    await expect(
      one.service.apply(one.game.id, "gpuPreference", "apply"),
    ).rejects.toThrow(/Only one adapter/);
    expect(one.service.hasRecords(one.game.id)).toBe(false);

    const none = setup(null);
    const unknown = await none.service.status(none.game.id);
    expect(unknown.settings.every((s) => s.state === "unsupported")).toBe(true);
    expect(unknown.settings[0]!.detail).toContain("executable");
    await expect(
      none.service.apply(none.game.id, "fullscreenOptimizations", "apply"),
    ).rejects.toThrow(/executable/);
    expect(none.platform.calls).toEqual([]);
  });
  it("undoes a failed apply with an exact-prior revert and keeps no record", async () => {
    const { repo, game, platform, service } = setup();
    platform.failApply = true;
    await expect(
      service.apply(game.id, "gpuPreference", "apply"),
    ).rejects.toThrow(/refused/);
    expect(service.hasRecords(game.id)).toBe(false);
    expect(platform.calls.map((c) => c.op)).toEqual([
      "read",
      "apply",
      "revert",
    ]);
    expect(platform.values.size).toBe(0);
    expect(
      repo
        .activity()
        .some((a) => a.label === "Launch settings" && a.status === "failed"),
    ).toBe(true);
    // A second apply while one is recorded is refused.
    platform.failApply = false;
    await service.apply(game.id, "gpuPreference", "apply");
    await expect(
      service.apply(game.id, "gpuPreference", "apply"),
    ).rejects.toThrow(/already changed/);
  });
  it("validates requests and refuses to remove a game that still has a saved prior value", async () => {
    expect(
      requests.launchSettingApply.safeParse({
        gameId: crypto.randomUUID(),
        setting: "gpuPreference",
        action: "apply",
        confirmed: false,
      }).success,
    ).toBe(false);
    expect(
      requests.launchSettingApply.safeParse({
        gameId: crypto.randomUUID(),
        setting: "autoexec",
        action: "apply",
        confirmed: true,
      }).success,
    ).toBe(false);
    expect(
      requests.launchSettingPreview.safeParse({
        gameId: crypto.randomUUID(),
        setting: "gpuPreference",
        action: "forget",
      }).success,
    ).toBe(false);
    const repo = new Repository(":memory:");
    const platform = new FakeHelper();
    const game = GameSchema.parse({
      id: crypto.randomUUID(),
      name: "Test",
      path: "C:\\Games\\Test",
      source: "steam",
      executablePath: exe,
      profile: "gaming",
      notes: "",
    });
    repo.updateState({ ...repo.state(), games: [game] });
    const desktop: DesktopServices = {
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
    };
    const app = new AppService(repo, platform, desktop);
    const request = (method: string, input: unknown) =>
      app.dispatch(method, input);
    await request("launchSettingApply", {
      gameId: game.id,
      setting: "gpuPreference",
      action: "apply",
      confirmed: true,
    });
    await expect(request("removeGame", { id: game.id })).rejects.toThrow(
      /Revert this game's launch settings/,
    );
    await request("launchSettingApply", {
      gameId: game.id,
      setting: "gpuPreference",
      action: "revert",
      confirmed: true,
    });
    await request("removeGame", { id: game.id });
    expect(repo.state().games).toEqual([]);
    // The activity log carries the rows (Activity page).
    expect(
      repo.activity().filter((a) => a.label === "Launch settings").length,
    ).toBeGreaterThanOrEqual(2);
  });
});
