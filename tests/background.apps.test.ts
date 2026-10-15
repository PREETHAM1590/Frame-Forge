import { describe, expect, it } from "vitest";
import type { RunningProcess } from "../shared/contracts";
import {
  backgroundRows,
  classifyApp,
  effectiveBackground,
  groupProcesses,
  neverTouch,
  suggestedRules,
  totals,
} from "../shared/background";

const MB = 1024 * 1024;
const proc = (
  image: string,
  mb: number,
  cpu = 0,
  protectedFlag = false,
): RunningProcess => ({
  image,
  pid: Math.floor(Math.random() * 90000) + 1,
  protected: protectedFlag,
  workingSetBytes: mb * MB,
  cpuPercent: cpu,
});
const running = [
  ...Array.from({ length: 5 }, () => proc("brave.exe", 300, 1)),
  proc("OneDrive.exe", 80, 0.5),
  proc("MicrosoftEdgeUpdate.exe", 8, 0),
  proc("steamwebhelper.exe", 180, 2),
  proc("steam.exe", 90, 0.5),
  proc("Discord.exe", 400, 1),
  proc("NVIDIA Overlay.exe", 90, 0),
  proc("Code.exe", 700, 2),
  proc("tiny-notes.exe", 20, 0),
  proc("explorer.exe", 150, 1, true),
  proc("VALORANT-Win64-Shipping.exe", 3000, 60),
  proc("RiotClientServices.exe", 120, 0),
];

describe("apps to close or pause while gaming", () => {
  it("groups processes by app and sums memory and CPU", () => {
    const brave = groupProcesses(running).find((g) => g.key === "brave.exe")!;
    expect(brave.processes).toBe(5);
    expect(brave.ramBytes).toBe(1500 * MB);
    expect(brave.cpuPercent).toBe(5);
  });

  it("suggests heavy non-essential apps and never voice, overlays, launchers or protected programs", () => {
    const names = (rows: ReturnType<typeof backgroundRows>) =>
      rows.filter((r) => r.suggested).map((r) => r.name);
    const rows = backgroundRows(running, [], false, {
      gameImage: "VALORANT-Win64-Shipping.exe",
      gameSource: "riot",
    });
    expect(names(rows)).toEqual(
      expect.arrayContaining([
        "brave",
        "OneDrive",
        "MicrosoftEdgeUpdate",
        "steamwebhelper",
        "Code",
      ]),
    );
    for (const never of [
      "Discord",
      "NVIDIA Overlay",
      "steam",
      "explorer",
      "RiotClientServices",
      "VALORANT-Win64-Shipping",
      "tiny-notes",
    ])
      expect(names(rows)).not.toContain(never);
    expect(neverTouch("Discord.exe")).toMatch(/voice/);
    expect(neverTouch("Frameforge.exe")).toMatch(/Frameforge/);
    expect(neverTouch("EasyAntiCheat.exe")).not.toBeNull();
    expect(neverTouch("brave.exe")).toBeNull();
  });

  it("a launcher's web helper is blocked only for the launcher that runs the game", () => {
    const g = groupProcesses([proc("steamwebhelper.exe", 200, 2)])[0]!;
    expect(classifyApp(g, { gameSource: "steam" }).blocked).toBeTruthy();
    expect(classifyApp(g, { gameSource: "riot" }).suggested).toBe(true);
  });

  it("pre-ticks the suggested set until the person saves their own", () => {
    const fresh = backgroundRows(running, [], false);
    expect(fresh.find((r) => r.name === "brave")!.selected).toBe(true);
    expect(fresh.find((r) => r.name === "Discord")!.selected).toBe(false);
    // Once chosen, only the saved apps are ticked, even if that is none.
    const emptyChosen = backgroundRows(running, [], true);
    expect(emptyChosen.some((r) => r.selected)).toBe(false);
    const saved = backgroundRows(
      running,
      [{ image: "Code.exe", action: "close" }],
      true,
    );
    const code = saved.find((r) => r.name === "Code")!;
    expect(code.selected).toBe(true);
    expect(code.chosenAction).toBe("close");
    expect(saved.find((r) => r.name === "brave")!.selected).toBe(false);
  });

  it("keeps saved apps that are not running so they can be removed", () => {
    const rows = backgroundRows(
      running,
      [{ image: "Spotify.exe", action: "lower" }],
      true,
    );
    const spotify = rows.find((r) => r.name === "Spotify")!;
    expect(spotify.processes).toBe(0);
    expect(spotify.selected).toBe(true);
  });

  it("a per-game list overrides the saved list, which overrides the suggestions", () => {
    const config = {
      background: [{ image: "Code.exe", action: "lower" as const }],
      backgroundChosen: true,
    };
    expect(
      effectiveBackground(
        { background: [{ image: "brave.exe", action: "close" }] },
        config,
        running,
      ).source,
    ).toBe("game");
    expect(effectiveBackground({}, config, running)).toMatchObject({
      source: "saved",
      rules: config.background,
    });
    const fallback = effectiveBackground({}, { background: [] }, running, {
      gameImage: "VALORANT-Win64-Shipping.exe",
    });
    expect(fallback.source).toBe("suggested");
    expect(fallback.rules.map((r) => r.image)).toContain("brave.exe");
    expect(fallback.rules.map((r) => r.image)).not.toContain("Discord.exe");
    // An empty list the person saved on purpose is respected.
    expect(
      effectiveBackground(
        {},
        { background: [], backgroundChosen: true },
        running,
      ),
    ).toMatchObject({ source: "saved", rules: [] });
  });

  it("suggested rules are valid image names and capped", () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      proc(`updater${i}.exe`, 50),
    );
    expect(suggestedRules(many).length).toBeLessThanOrEqual(20);
    for (const r of suggestedRules(running))
      expect(r.image).toMatch(/^[\w .()-]{1,64}\.exe$/i);
  });

  it("totals tell closing (frees memory) apart from pausing (only stops CPU use)", () => {
    const rows = backgroundRows(
      running,
      [
        { image: "Code.exe", action: "close" },
        { image: "brave.exe", action: "suspend" },
      ],
      true,
    );
    const t = totals(rows);
    expect(t.count).toBe(2);
    expect(t.closeBytes).toBe(700 * MB);
    expect(t.heldBytes).toBe(1500 * MB);
  });
});
