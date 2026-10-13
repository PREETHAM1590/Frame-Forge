import { describe, it, expect } from "vitest";
import { Repository } from "../electron/repository";
import { MockPlatform } from "../electron/platform";
import { AppService } from "../electron/service";
import { upsertPreset } from "../shared/catalogue";
function service() {
  const repo = new Repository(":memory:");
  const svc = new AppService(repo, new MockPlatform(), {
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
  return { repo, svc };
}
type Saved = { presets: { id: string; name: string; ids: string[] }[] };
const save = (
  svc: AppService,
  input: { id?: string; name: string; ids: string[] },
) => svc.dispatch("savePreset", input) as Promise<Saved>;
describe("custom preset IPC", () => {
  it("updates in place by id and keeps the order and id", async () => {
    const { repo, svc } = service();
    await save(svc, { name: "One", ids: ["mouse-precision"] });
    const two = (await save(svc, { name: "Two", ids: ["capture-off"] }))
      .presets;
    const edited = await save(svc, {
      id: two[1].id,
      name: "Two renamed",
      ids: ["capture-off", "mouse-precision"],
    });
    expect(edited.presets.map((p) => p.name)).toEqual(["One", "Two renamed"]);
    expect(edited.presets[1]).toEqual({
      id: two[1].id,
      name: "Two renamed",
      ids: ["capture-off", "mouse-precision"],
    });
    // Saving under its own name (different case) is not a clash.
    await save(svc, {
      id: two[1].id,
      name: "two RENAMED",
      ids: ["capture-off"],
    });
    expect(svc.bootstrap().state.presets).toHaveLength(2);
    repo.close();
  });
  it("rejects duplicate names case-insensitively, including built-in presets", async () => {
    const { repo, svc } = service();
    const [first] = (
      await save(svc, { name: "Mine", ids: ["mouse-precision"] })
    ).presets;
    await expect(
      save(svc, { name: " mine ", ids: ["capture-off"] }),
    ).rejects.toThrow(/already exists/);
    await expect(
      save(svc, { name: "GAMING", ids: ["capture-off"] }),
    ).rejects.toThrow(/already exists/);
    const other = (await save(svc, { name: "Other", ids: ["capture-off"] }))
      .presets[1];
    await expect(
      save(svc, { id: other.id, name: "MINE", ids: ["capture-off"] }),
    ).rejects.toThrow(/already exists/);
    expect(svc.bootstrap().state.presets.map((p) => p.name)).toEqual([
      "Mine",
      "Other",
    ]);
    expect(svc.bootstrap().state.presets[0].id).toBe(first.id);
    repo.close();
  });
  it("validates at the boundary and rejects an unknown id", async () => {
    const { repo, svc } = service();
    await expect(
      svc.dispatch("savePreset", {
        id: "nope",
        name: "X",
        ids: ["capture-off"],
      }),
    ).rejects.toThrow();
    await expect(
      save(svc, {
        id: crypto.randomUUID(),
        name: "X",
        ids: ["capture-off"],
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      svc.dispatch("savePreset", { name: "X", ids: ["nonsense"] }),
    ).rejects.toThrow();
    await expect(
      svc.dispatch("savePreset", {
        name: "X",
        ids: ["capture-off"],
        extra: 1,
      }),
    ).rejects.toThrow();
    expect(svc.bootstrap().state.presets).toHaveLength(0);
    repo.close();
  });
  it("deletes by id and leaves the others", async () => {
    const { repo, svc } = service();
    await save(svc, { name: "A", ids: ["capture-off"] });
    const { presets } = await save(svc, { name: "B", ids: ["capture-off"] });
    await svc.dispatch("removePreset", { id: presets[0].id });
    expect(svc.bootstrap().state.presets.map((p) => p.name)).toEqual(["B"]);
    // The freed name can be reused.
    await save(svc, { name: "A", ids: ["capture-off"] });
    expect(svc.bootstrap().state.presets).toHaveLength(2);
    repo.close();
  });
  it("upsertPreset does not mutate its input", () => {
    const list = [
      { id: crypto.randomUUID(), name: "A", ids: ["capture-off" as const] },
    ];
    const copy = structuredClone(list);
    upsertPreset(list, { name: "B", ids: ["capture-off"] }, () =>
      crypto.randomUUID(),
    );
    expect(list).toEqual(copy);
  });
});
