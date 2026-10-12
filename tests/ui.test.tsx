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
  it("separates Windows System Restore from app backups and disables demo creation", async () => {
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Restore & backups" }));
    expect(
      screen.getByRole("heading", {
        name: "Windows System Restore (whole-PC recovery)",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "App configuration backups" }),
    ).toBeVisible();
    const create = screen.getByRole("button", { name: "Create restore point" });
    expect(create).toBeDisabled();
    expect(create).toHaveAccessibleDescription(
      "Windows System Restore requires the desktop app.",
    );
  });
});
