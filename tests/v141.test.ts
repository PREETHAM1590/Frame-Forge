import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CloseAsker } from "../electron/background";

afterEach(() => vi.useRealTimers());
describe("in-app close prompt (main process side)", () => {
  it("sends the event and resolves with the renderer's choice, however long it takes", async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => true);
    const asker = new CloseAsker(send, 3000);
    const answer = asker.ask();
    expect(send).toHaveBeenCalledOnce();
    asker.reply({ action: "shown", remember: false });
    await vi.advanceTimersByTimeAsync(60_000);
    asker.reply({ action: "tray", remember: true });
    await expect(answer).resolves.toEqual({ action: "tray", remember: true });
  });
  it("falls back (null) when the renderer never confirms within 3 s", async () => {
    vi.useFakeTimers();
    const asker = new CloseAsker(() => true, 3000);
    const answer = asker.ask();
    let settled = false;
    void answer.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(answer).resolves.toBeNull();
    // A late reply after the fallback is ignored.
    asker.reply({ action: "quit", remember: false });
  });
  it("falls back at once when there is no usable renderer", async () => {
    await expect(new CloseAsker(() => false).ask()).resolves.toBeNull();
  });
  it("main.ts no longer uses a native box for the first-run privacy question", () => {
    const main = readFileSync("electron/main.ts", "utf8");
    expect(main).not.toContain("Check for updates automatically?");
    expect(main).toContain("closeAsker.ask()");
  });
});
