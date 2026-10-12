import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { BoostEngine } from "../electron/booster";
import { GameSchema, type ProcessTarget } from "../shared/contracts";
const target: ProcessTarget = {
  pid: 321,
  startTime: "2026-10-12T10:00:00.0000000Z",
  executablePath: "C:\\Games\\Test\\game.exe",
  name: "game",
  priority: "Normal",
};
class TestPlatform extends MockPlatform {
  override boostAvailable = true;
  targets: ProcessTarget[] = [target];
  restored = false;
  failStart = false;
  failStop = false;
  override async gameProcesses() {
    return this.targets;
  }
  override async boostStart(expected: ProcessTarget) {
    if (this.failStart) throw new Error("Verification failed");
    return expected;
  }
  override async boostStop() {
    if (this.failStop) throw new Error("Process changed externally");
    this.restored = true;
    return "Previous process priority restored.";
  }
}
function setup() {
  const repo = new Repository(":memory:");
  const game = GameSchema.parse({
    id: crypto.randomUUID(),
    name: "Test",
    path: "C:\\Games\\Test",
    source: "steam",
    profile: "gaming",
    notes: "",
  });
  repo.updateState({ ...repo.state(), games: [game] });
  const platform = new TestPlatform();
  return { repo, game, platform, engine: new BoostEngine(repo, platform) };
}
describe("real booster orchestration", () => {
  it("persists original identity and priority before invoking changes, then restores", async () => {
    const { repo, game, platform, engine } = setup();
    const apply = platform.boostStart.bind(platform);
    platform.boostStart = async (expected) => {
      expect(repo.boostSession()?.status).toBe("preparing");
      expect(repo.boostSession()?.target.priority).toBe("Normal");
      return apply(expected);
    };
    const session = await engine.start(game.id, target);
    expect(session.status).toBe("active");
    expect((await engine.stop())?.status).toBe("ended");
    expect(platform.restored).toBe(true);
    repo.close();
  });
  it("rejects targets not freshly matched to the selected saved game", async () => {
    const { repo, game, engine } = setup();
    await expect(
      engine.start(game.id, { ...target, pid: 999 }),
    ).rejects.toThrow(/running|target/i);
    expect(repo.boostSession()).toBeNull();
    repo.close();
  });
  it("recovers a failed apply and retains a failed restore for retry", async () => {
    const { repo, game, platform, engine } = setup();
    platform.failStart = true;
    platform.failStop = true;
    const result = await engine.start(game.id, target);
    expect(result.status).toBe("recovery-needed");
    expect(repo.boostSession()?.target.pid).toBe(target.pid);
    platform.failStop = false;
    expect((await engine.stop())?.status).toBe("ended");
    repo.close();
  });
  it("does not boost processes already running at elevated priority", async () => {
    const { repo, game, platform, engine } = setup();
    platform.targets = [{ ...target, priority: "High" }];
    await expect(engine.start(game.id, platform.targets[0])).rejects.toThrow(
      /Normal/,
    );
    repo.close();
  });
});
