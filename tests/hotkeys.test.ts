import { describe, it, expect, vi } from "vitest";
import {
  HotkeyManager,
  hotkeyActions,
  nextMode,
  resolveForeground,
  type HotkeyDeps,
  type ShortcutApi,
} from "../electron/hotkeys";
import {
  HotkeysSchema,
  SettingsSchema,
  acceleratorFromEvent,
  defaultHotkeys,
  defaultState,
  parseAccelerator,
  type Game,
  type ProcessTarget,
} from "../shared/contracts";

const game = (name: string, exe: string): Game => ({
  id: crypto.randomUUID(),
  name,
  path: "C:\\Games",
  source: "custom",
  executablePath: exe,
  profile: "balanced",
  boostMode: "global",
  notes: "",
});
const target = (pid: number, exe: string): ProcessTarget => ({
  pid,
  startTime: "2026-10-14T10:00:00.0000000Z",
  executablePath: exe,
  name: "game",
  priority: "Normal",
});

describe("accelerator validation", () => {
  it("canonicalises and accepts normal combos", () => {
    expect(parseAccelerator("ctrl+alt+b")).toEqual({
      ok: true,
      accelerator: "Ctrl+Alt+B",
    });
    expect(parseAccelerator("Alt + Shift + f9")).toEqual({
      ok: true,
      accelerator: "Alt+Shift+F9",
    });
    expect(parseAccelerator("CommandOrControl+Alt+Esc")).toEqual({
      ok: true,
      accelerator: "Ctrl+Alt+Escape",
    });
    expect(parseAccelerator("Ctrl++")).toEqual({
      ok: true,
      accelerator: "Ctrl+Plus",
    });
  });
  it.each([
    "B",
    "F9",
    "Ctrl",
    "Shift+B",
    "Alt+F4",
    "alt+f4",
    "Ctrl+Alt+Delete",
    "Ctrl+Alt+Del",
    "Super+L",
    "Win+L",
    "Ctrl+Win+B",
    "Alt+Tab",
    "Ctrl+Shift+Esc",
    "Ctrl+C",
    "Ctrl+B+C",
    "Ctrl+Alt+Nope",
    "Ctrl+Alt+",
    "",
    "x".repeat(80),
  ])("rejects %j", (input) => {
    expect(parseAccelerator(input).ok).toBe(false);
  });
  it("is enforced at the IPC boundary and normalises stored values", () => {
    expect(HotkeysSchema.safeParse(defaultHotkeys).success).toBe(true);
    const bad = {
      ...defaultHotkeys,
      bindings: { ...defaultHotkeys.bindings, stopBoost: "Alt+F4" },
    };
    expect(HotkeysSchema.safeParse(bad).success).toBe(false);
    const lower = HotkeysSchema.parse({
      ...defaultHotkeys,
      bindings: { ...defaultHotkeys.bindings, stopBoost: "ctrl+alt+x" },
    });
    expect(lower.bindings.stopBoost).toBe("Ctrl+Alt+X");
  });
  it("rejects two actions on the same combination", () => {
    const dup = {
      ...defaultHotkeys,
      bindings: { ...defaultHotkeys.bindings, stopBoost: "ctrl+alt+b" },
    };
    expect(HotkeysSchema.safeParse(dup).success).toBe(false);
  });
  it("settings from before hotkeys existed get the defaults", () => {
    const { hotkeys: _drop, ...old } = defaultState.settings;
    void _drop;
    expect(SettingsSchema.parse(old).hotkeys).toEqual(defaultHotkeys);
  });
  it("the recorder turns a key press into an accelerator", () => {
    const e = {
      code: "KeyB",
      ctrlKey: true,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    };
    expect(acceleratorFromEvent(e)).toBe("Ctrl+Alt+B");
    expect(acceleratorFromEvent({ ...e, code: "ControlLeft" })).toBeNull();
    expect(acceleratorFromEvent({ ...e, code: "ArrowUp" })).toBe("Ctrl+Alt+Up");
    expect(
      parseAccelerator(acceleratorFromEvent({ ...e, metaKey: true })!).ok,
    ).toBe(false);
  });
});

class FakeShortcuts implements ShortcutApi {
  owned = new Set<string>();
  mine = new Map<string, () => void>();
  register(accelerator: string, cb: () => void) {
    if (this.owned.has(accelerator) || this.mine.has(accelerator)) return false;
    this.mine.set(accelerator, cb);
    return true;
  }
  unregister(accelerator: string) {
    this.mine.delete(accelerator);
  }
}
describe("HotkeyManager", () => {
  const noop = {
    toggleBoost: vi.fn(),
    stopBoost: vi.fn(),
    toggleOverlay: vi.fn(),
    cycleMode: vi.fn(),
  };
  it("registers every binding and unregisters on dispose", () => {
    const api = new FakeShortcuts();
    const m = new HotkeyManager(api, noop);
    m.apply(defaultHotkeys);
    expect([...api.mine.keys()].sort()).toEqual(
      Object.values(defaultHotkeys.bindings).sort(),
    );
    api.mine.get("Ctrl+Alt+S")!();
    expect(noop.stopBoost).toHaveBeenCalled();
    m.dispose();
    expect(api.mine.size).toBe(0);
  });
  it("reports a combination another app owns as a conflict and keeps the rest", () => {
    const api = new FakeShortcuts();
    api.owned.add("Ctrl+Alt+O");
    const m = new HotkeyManager(api, noop);
    m.apply(defaultHotkeys);
    expect(m.failed).toEqual(["toggleOverlay"]);
    expect(m.registered).toEqual(["toggleBoost", "stopBoost", "cycleMode"]);
  });
  it("treats a throwing register as a conflict", () => {
    const api: ShortcutApi = {
      register: () => {
        throw new Error("bad");
      },
      unregister: () => {},
    };
    const m = new HotkeyManager(api, noop);
    m.apply(defaultHotkeys);
    expect(m.registered).toEqual([]);
    expect(m.failed).toHaveLength(4);
  });
  it("re-applying swaps bindings; disabled registers nothing", () => {
    const api = new FakeShortcuts();
    const m = new HotkeyManager(api, noop);
    m.apply(defaultHotkeys);
    m.apply({
      ...defaultHotkeys,
      bindings: { ...defaultHotkeys.bindings, stopBoost: "Ctrl+Alt+X" },
    });
    expect(api.mine.has("Ctrl+Alt+S")).toBe(false);
    expect(api.mine.has("Ctrl+Alt+X")).toBe(true);
    m.apply({ ...defaultHotkeys, enabled: false });
    expect(api.mine.size).toBe(0);
    expect(m.failed).toEqual([]);
  });
});

const own = {
  exe: "C:\\Frameforge\\Frameforge.exe",
  systemRoot: "C:\\Windows",
};
describe("foreground game resolution", () => {
  const exe = "C:\\Games\\Test\\game.exe";
  const g = game("Test", exe);
  const running = [{ gameId: g.id, target: target(10, exe) }];
  it("matches a library game case-insensitively and picks the foreground pid", () => {
    const r = resolveForeground(
      { pid: 10, path: "c:/games/test/GAME.exe" },
      [g],
      running,
      own,
    );
    expect(r).toMatchObject({ kind: "game", target: { pid: 10 } });
  });
  it("offers to add a program that is not in the library", () => {
    expect(
      resolveForeground(
        { pid: 1, path: "D:\\x\\other.exe" },
        [g],
        running,
        own,
      ),
    ).toEqual({ kind: "unknown", exe: "D:\\x\\other.exe" });
  });
  it("never treats Frameforge, Windows or an unknown window as a game", () => {
    for (const p of [
      own.exe,
      "C:\\Windows\\explorer.exe",
      "C:\\WINDOWS\\System32\\x.exe",
    ])
      expect(
        resolveForeground({ pid: 2, path: p }, [g], running, own).kind,
      ).toBe("ignored");
    expect(resolveForeground(null, [g], running, own).kind).toBe("none");
    // C:\WindowsApps-style siblings are not under C:\Windows.
    expect(
      resolveForeground(
        { pid: 2, path: "C:\\Windows2\\a.exe" },
        [g],
        running,
        own,
      ).kind,
    ).toBe("unknown");
  });
  it("says so when the library game is not running", () => {
    expect(resolveForeground({ pid: 10, path: exe }, [g], [], own).kind).toBe(
      "notRunning",
    );
  });
});

describe("hotkey actions", () => {
  const exe = "C:\\Games\\Test\\game.exe";
  const g = game("Test", exe);
  function setup(over: Partial<HotkeyDeps> = {}) {
    const notices: string[] = [];
    const clicks: Array<{ label: string; run: () => void } | undefined> = [];
    const state = structuredClone(defaultState);
    state.games = [g];
    state.booster.mode = "balanced";
    const deps: HotkeyDeps = {
      state: () => state,
      foreground: async () => ({ pid: 10, path: exe }),
      running: async () => [{ gameId: g.id, target: target(10, exe) }],
      live: () => false,
      start: vi.fn(async () => ({}) as never),
      stop: vi.fn(async () => null),
      setMode: vi.fn(),
      addGame: vi.fn(async () => {}),
      toggleOverlay: () => false,
      notify: (t, c) => {
        notices.push(t);
        clicks.push(c);
      },
      own,
      ...over,
    };
    return { deps, notices, clicks, actions: hotkeyActions(deps), state };
  }
  const settle = () => new Promise((r) => setTimeout(r, 10));
  it("boosts the foreground library game and skips admin steps by default", async () => {
    const s = setup();
    s.actions.toggleBoost();
    await settle();
    expect(s.deps.start).toHaveBeenCalledWith(
      g.id,
      expect.objectContaining({ pid: 10 }),
      true,
    );
    expect(s.notices).toEqual(["Boosting Test"]);
  });
  it("allows admin prompts only when the setting is on", async () => {
    const s = setup();
    s.state.settings.hotkeys.allowAdmin = true;
    s.actions.toggleBoost();
    await settle();
    expect(s.deps.start).toHaveBeenCalledWith(g.id, expect.anything(), false);
  });
  it("stops a live boost when pressed again", async () => {
    const s = setup({ live: () => true });
    s.actions.toggleBoost();
    await settle();
    expect(s.deps.stop).toHaveBeenCalled();
    expect(s.deps.start).not.toHaveBeenCalled();
  });
  it("offers Add to library for a program that is not in the library", async () => {
    const s = setup({
      foreground: async () => ({ pid: 5, path: "C:\\Other\\new.exe" }),
    });
    s.actions.toggleBoost();
    await settle();
    expect(s.notices[0]).toContain("new is not in your library");
    s.clicks[0]!.run();
    await settle();
    expect(s.deps.addGame).toHaveBeenCalledWith("C:\\Other\\new.exe");
    expect(s.deps.start).not.toHaveBeenCalled();
  });
  it("reports a start failure instead of throwing", async () => {
    const s = setup({
      start: vi.fn(async () => {
        throw new Error("Booster mode is Off for Test.");
      }),
    });
    s.actions.toggleBoost();
    await settle();
    expect(s.notices).toEqual(["Booster mode is Off for Test."]);
  });
  it("stop hotkey with nothing running says so", async () => {
    const s = setup();
    s.actions.stopBoost();
    await settle();
    expect(s.notices).toEqual(["No boost is running."]);
    expect(s.deps.stop).not.toHaveBeenCalled();
  });
  it("overlay hotkey is a guarded no-op without the overlay module", async () => {
    const s = setup();
    s.actions.toggleOverlay();
    await settle();
    expect(s.notices[0]).toContain("not available");
    const t = vi.fn(() => true);
    const s2 = setup({ toggleOverlay: t });
    s2.actions.toggleOverlay();
    await settle();
    expect(t).toHaveBeenCalled();
    expect(s2.notices).toEqual([]);
  });
  it("cycles the mode and wraps around; refused while a boost is live", async () => {
    expect(nextMode("balanced")).toBe("performance");
    expect(nextMode("custom")).toBe("off");
    const s = setup();
    s.actions.cycleMode();
    await settle();
    expect(s.deps.setMode).toHaveBeenCalledWith("performance");
    const live = setup({ live: () => true });
    live.actions.cycleMode();
    await settle();
    expect(live.deps.setMode).not.toHaveBeenCalled();
  });
});
