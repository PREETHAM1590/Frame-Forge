// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import { defaultState } from "../shared/contracts";
beforeEach(() => {
  localStorage.clear();
  window.scrollTo = () => {};
});
afterEach(() => cleanup());
describe("configuration and safety UI", () => {
  it("labels demo data and disables Windows confirmation", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(screen.getByText("Demo data")).toBeVisible();
    fireEvent.click(screen.getByText("Consistent pointer movement"));
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("button", { name: "Confirm & apply" }),
    ).toBeDisabled();
  });
  it("creates a named configuration backup through the accessible dialog", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
    fireEvent.click(screen.getByRole("button", { name: "Create backup" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Backup name"), {
      target: { value: "My configuration" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Create backup" }),
    );
    expect(await screen.findByText("My configuration")).toBeVisible();
  });
  it("shows booster modes in demo mode with Start disabled and explained", async () => {
    localStorage.setItem(
      "frameforge-demo-v1",
      JSON.stringify({
        state: {
          ...defaultState,
          games: [
            {
              id: crypto.randomUUID(),
              name: "Demo game",
              path: "C:\\Games\\Demo",
              source: "custom",
              executablePath: null,
              profile: "balanced",
              boostMode: "global",
              notes: "",
            },
          ],
        },
        backups: [],
        activity: [],
      }),
    );
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Game Mode" }));
    const modes = await screen.findByRole("group", { name: "Boost mode" });
    for (const name of [
      "Off",
      "Balanced",
      "Performance",
      "Competitive",
      "Custom",
    ])
      expect(within(modes).getByRole("button", { name })).toBeVisible();
    const start = screen.getByRole("button", { name: "Start boost" });
    expect(start).toBeDisabled();
    expect(start).toHaveAttribute(
      "title",
      "Game booster requires the desktop app.",
    );
    fireEvent.click(within(modes).getByRole("button", { name: "Performance" }));
    expect(
      await screen.findByText("Performance power plan"),
    ).toBeInTheDocument();
    expect(screen.getByText("Standby list purge")).toBeInTheDocument();
  });
});
