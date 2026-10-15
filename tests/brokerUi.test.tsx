// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { AdminAccess } from "../src/components/AdminAccess";
import type { BrokerStatus, FrameforgeApi } from "../shared/contracts";

function install(first: BrokerStatus, after?: BrokerStatus | Error) {
  const calls: string[] = [];
  window.frameforge = {
    onEvent: () => () => undefined,
    brokerStatus: async () => {
      calls.push("brokerStatus");
      return first;
    },
    brokerInstall: async (input: unknown) => {
      calls.push(`brokerInstall:${JSON.stringify(input)}`);
      if (after instanceof Error) throw after;
      return after!;
    },
    brokerRemove: async (input: unknown) => {
      calls.push(`brokerRemove:${JSON.stringify(input)}`);
      if (after instanceof Error) throw after;
      return after!;
    },
  } as unknown as FrameforgeApi;
  return calls;
}
afterEach(() => {
  cleanup();
  delete (window as { frameforge?: unknown }).frameforge;
});
describe("Settings > Administrator access", () => {
  it("explains the trade-off and offers one approval when nothing is set up", async () => {
    const calls = install(
      { state: "not-installed", message: "Admin access is not set up." },
      {
        state: "ready",
        message: "Admin access is approved.",
        version: "1.4.0",
      },
    );
    render(<AdminAccess />);
    await screen.findByText("Admin access is not set up.");
    expect(screen.getByText(/privileged component/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Remove admin service" }),
    ).toBeNull();
    // Nothing is requested until the click.
    expect(calls).toEqual(["brokerStatus"]);
    fireEvent.click(screen.getByRole("button", { name: "Approve admin once" }));
    await screen.findByText("Admin access is approved.");
    expect(calls).toContain('brokerInstall:{"confirmed":true}');
    expect(screen.getByText("Approved")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Approve admin once" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Remove admin service" }),
    ).toBeEnabled();
  });
  it("removes the service with one click and shows the result", async () => {
    const calls = install(
      { state: "ready", message: "Admin access is approved." },
      { state: "not-installed", message: "Admin access is not set up." },
    );
    render(<AdminAccess />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Remove admin service" }),
    );
    await screen.findByText("Admin access is not set up.");
    expect(calls).toContain('brokerRemove:{"confirmed":true}');
  });
  it("shows a declined prompt as an error and keeps the real status", async () => {
    install(
      { state: "not-installed", message: "Admin access is not set up." },
      new Error("Administrator approval was declined. Nothing was changed."),
    );
    render(<AdminAccess />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Approve admin once" }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/declined/);
    await waitFor(() =>
      expect(screen.getByText("Admin access is not set up.")).toBeVisible(),
    );
  });
  it("asks for a fresh approval when the service is out of date or broken", async () => {
    install({ state: "needs-update", message: "Old version." });
    render(<AdminAccess />);
    await screen.findByText("Old version.");
    expect(screen.getByRole("button", { name: "Approve again" })).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Remove admin service" }),
    ).toBeEnabled();
  });
  it("offers nothing in a build without the Windows helper", async () => {
    install({ state: "unsupported", message: "Only in the Windows app." });
    render(<AdminAccess />);
    await screen.findByText("Only in the Windows app.");
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});
