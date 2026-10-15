// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { RecommendedSettings } from "../src/views/games/RecommendedSettings";
import {
  GameEntrySchema,
  activeTiers,
  adviseGame,
  frameCapAdvice,
  gameDatabase,
  getBottleneck,
  matchGame,
  profileHardware,
  setBottleneckProvider,
  tailorSettings,
} from "../shared/gameSettings";
import type { Game, Hardware } from "../shared/contracts";

const hw = (over: Partial<Hardware> = {}): Hardware => ({
  source: "windows",
  collectedAt: "2026-01-01T00:00:00.000Z",
  cpu: "13th Gen Intel(R) Core(TM) i5-13420H",
  gpu: ["Intel(R) UHD Graphics", "NVIDIA GeForce RTX 4050 Laptop GPU"],
  memoryBytes: 16 * 1024 ** 3,
  freeMemoryBytes: 8 * 1024 ** 3,
  cores: 12,
  os: "Windows 11",
  drives: [],
  displays: ["1920 x 1080 @ 240 Hz on NVIDIA GeForce RTX 4050 Laptop GPU"],
  drivers: [],
  warnings: [],
  ...over,
});
const game = (
  name: string,
  exe: string | null,
  path = "C:\\Games\\x",
): Game => ({
  id: crypto.randomUUID(),
  name,
  path,
  source: "riot",
  executablePath: exe,
  profile: "balanced",
  notes: "",
  boostMode: "global",
});
const desktop = () =>
  hw({ gpu: ["NVIDIA GeForce RTX 4070"], cpu: "AMD Ryzen 7 7800X3D" });
afterEach(() => {
  cleanup();
  setBottleneckProvider(null);
});

describe("database", () => {
  it("covers the required games and every entry validates with https sources", () => {
    for (const e of gameDatabase) {
      expect(() => GameEntrySchema.parse(e)).not.toThrow();
      expect(e.settings.every((s) => s.source.startsWith("https://"))).toBe(
        true,
      );
    }
    const ids = gameDatabase.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      "valorant",
      "cs2",
      "fortnite",
      "apex-legends",
      "warzone",
      "roblox",
      "minecraft-java",
      "gta-v",
      "cyberpunk-2077",
      "outlast-trials",
    ])
      expect(ids).toContain(id);
  });
  it("rejects an entry that is not guide-only or has a bad source", () => {
    const e = gameDatabase[0];
    expect(() =>
      GameEntrySchema.parse({ ...e, configPolicy: "safe-edit" }),
    ).toThrow();
    const bad = {
      ...e,
      settings: [{ ...e.settings[0], source: "http://x.test" }],
    };
    expect(() => GameEntrySchema.parse(bad)).toThrow();
  });
  it("never recommends frame generation in competitive shooters", () => {
    for (const e of gameDatabase.filter((x) => x.goal === "competitive"))
      expect(e.frameGen).not.toBe("optional");
  });
});

describe("matching", () => {
  it("matches by exe, steam app id and path, and returns null for unknown games", () => {
    expect(
      matchGame(game("V", "D:\\Riot\\VALORANT-Win64-Shipping.exe"))?.id,
    ).toBe("valorant");
    expect(
      matchGame(
        game(
          "x",
          null,
          "D:\\SteamLibrary\\steamapps\\common\\Counter-Strike Global Offensive",
        ),
      )?.id,
    ).toBe("cs2");
    expect(matchGame(game("x", null), "1091500")?.id).toBe("cyberpunk-2077");
    expect(matchGame(game("Unknown", "C:\\g\\unknown.exe"))).toBeNull();
    expect(matchGame(game("Java app", "C:\\java\\javaw.exe"))).toBeNull();
  });
});

describe("tailoring", () => {
  it("profiles a laptop RTX 4050 with 240 Hz", () => {
    expect(profileHardware(hw())).toMatchObject({
      vendor: "nvidia",
      vramGb: 6,
      lowVram: true,
      laptop: true,
      refreshHz: 240,
      cpuThreads: 12,
    });
  });
  it("prefers a measured bottleneck and hides GPU-only settings on CPU-bound PCs", () => {
    const valorant = gameDatabase[0];
    const p = profileHardware(desktop());
    const tiers = activeTiers(p, null, valorant);
    expect(tiers).toEqual(["cpu"]);
    expect(
      tailorSettings(valorant.settings, tiers).map((s) => s.key),
    ).not.toContain("resolution");
    expect(activeTiers(p, "gpu", valorant)).toEqual(["gpu"]);
    expect(activeTiers(profileHardware(hw()), null, valorant)).toEqual([
      "laptop",
      "vram",
      "cpu",
    ]);
  });
  it("picks tier-specific values and sorts by impact", () => {
    const cs2 = gameDatabase.find((e) => e.id === "cs2")!;
    const out = tailorSettings(cs2.settings, ["laptop", "vram", "cpu"]);
    expect(out.find((s) => s.key === "msaa")?.value).toBe("2x MSAA");
    expect(out[0].impact).toBe("high");
  });
  it("falls back to generic guidance for unknown games, driven by the bottleneck", () => {
    setBottleneckProvider(() => "cpu");
    expect(getBottleneck("a")).toBe("cpu");
    const a = adviseGame(
      { id: "a", name: "Unknown", path: "C:\\u", executablePath: null },
      desktop(),
    );
    expect(a.entry).toBeNull();
    expect(a.settings.map((s) => s.key)).toContain("view");
    setBottleneckProvider(() => {
      throw new Error("boom");
    });
    expect(getBottleneck("a")).toBeNull();
  });
});

describe("frame cap", () => {
  const valorant = gameDatabase[0];
  it("caps 3 below refresh in the in-game limiter on AMD", () => {
    const c = frameCapAdvice(
      profileHardware(hw({ gpu: ["AMD Radeon RX 7800 XT"] })),
      valorant,
    );
    expect(c.cap).toBe(237);
    expect(c.where).toContain("In-game");
  });
  it("lets Reflex cap on NVIDIA and points to NVCP when the game has no limiter", () => {
    expect(frameCapAdvice(profileHardware(hw()), valorant).where).toContain(
      "Reflex",
    );
    const gta = gameDatabase.find((e) => e.id === "gta-v")!;
    expect(frameCapAdvice(profileHardware(hw()), gta).where).toContain(
      "NVIDIA Control Panel",
    );
  });
  it("copes with an unknown refresh rate", () => {
    expect(
      frameCapAdvice(profileHardware(hw({ displays: [] })), valorant).cap,
    ).toBeNull();
  });
});

describe("UI", () => {
  it("renders VALORANT guidance for this PC, read-only, with a checklist button", () => {
    render(
      <RecommendedSettings
        game={game("VALORANT", "C:\\Riot\\VALORANT-Win64-Shipping.exe")}
        hardware={hw()}
      />,
    );
    expect(screen.getByText(/240 Hz display/)).toBeInTheDocument();
    expect(screen.getAllByText(/never edits VALORANT/).length).toBeGreaterThan(
      0,
    );
    expect(screen.getByText(/Vanguard anti-cheat/)).toBeInTheDocument();
    expect(screen.getByText(/Reflex keeps frames/)).toBeInTheDocument();
    expect(screen.getAllByText(/impact/).length).toBeGreaterThan(2);
    expect(screen.getAllByRole("link", { name: /Source/ })[0]).toHaveAttribute(
      "href",
      expect.stringMatching(/^https:/),
    );
    expect(
      screen.getByRole("button", { name: /Copy as checklist/ }),
    ).toBeInTheDocument();
  });
  it("copies the checklist", async () => {
    let text = "";
    Object.assign(navigator, {
      clipboard: { writeText: async (t: string) => void (text = t) },
    });
    render(
      <RecommendedSettings game={game("CS2", "C:\\cs2.exe")} hardware={hw()} />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy as checklist/ }));
    expect(await screen.findByText("Copied.")).toBeInTheDocument();
    expect(text).toContain("[ ] Vertical Sync: Disabled");
  });
  it("shows general advice for unknown games", () => {
    render(
      <RecommendedSettings game={game("Mystery", null)} hardware={hw()} />,
    );
    expect(screen.getByText(/No curated entry/)).toBeInTheDocument();
  });
});
