// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { Cleanup } from "../src/views/system/Cleanup";
import { DriverCheck } from "../src/views/system/DriverCheck";
import { SessionChanges } from "../src/views/gamemode/SessionChanges";
import type { BoostSession } from "../shared/contracts";

type Api = Record<string, (input: unknown) => unknown>;
const install = (api: Api) => {
  (window as unknown as { frameforge: Api }).frameforge = api;
};
afterEach(() => {
  cleanup();
  delete (window as unknown as { frameforge?: Api }).frameforge;
});

const row = (id: string, over = {}) => ({
  id,
  label: id,
  present: true,
  needsAdmin: false,
  shader: false,
  minAgeHours: 0,
  bytes: 1048576,
  files: 2,
  folders: [],
  ...over,
});

describe("Cleanup panel", () => {
  it("previews first, warns about shader caches and deletes only after confirmation", async () => {
    const run = vi.fn(() => ({
      categories: [
        {
          id: "directxShaders",
          label: "dx",
          freedBytes: 1048576,
          deleted: 2,
          skipped: 1,
          note: "1 file(s) in use or protected were skipped.",
        },
      ],
      freedBytes: 1048576,
      deleted: 2,
      skipped: 1,
    }));
    install({
      cleanupPreview: () => ({
        elevated: false,
        categories: [
          row("userTemp"),
          row("windowsTemp", { needsAdmin: true, bytes: null }),
          row("directxShaders", { shader: true }),
        ],
      }),
      cleanupRun: run,
    });
    render(<Cleanup />);
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /preview cleanup/i }));
    await screen.findByText("admin only");
    expect(screen.getByLabelText("Clean windowsTemp")).toBeDisabled();
    expect(screen.queryByText(/brief stutter/i)).toBeNull();
    fireEvent.click(screen.getByLabelText("Clean directxShaders"));
    expect(screen.getByText(/brief stutter/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^clean 1\.0 MB/i }));
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));
    await screen.findByText(/Freed 1\.0 MB/);
    expect(run).toHaveBeenCalledWith({
      ids: ["directxShaders"],
      confirmed: true,
    });
    expect(
      screen.getByText(/1 in use or protected were skipped/),
    ).toBeInTheDocument();
  });
});

describe("Driver check", () => {
  it("shows version and age and opens the vendor page by name", async () => {
    const open = vi.fn(() => true);
    install({
      gpuDrivers: () => ({
        adapters: [
          {
            name: "NVIDIA GeForce RTX 4050",
            vendor: "nvidia",
            driverVersion: "32.0.16.1714",
            displayVersion: "617.14",
            driverDate: "2020-01-01",
          },
        ],
        warnings: [],
      }),
      openDriverPage: open,
    });
    render(<DriverCheck />);
    await screen.findByText("617.14");
    expect(screen.getByText(/years old/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", { name: /nvidia drivers page/i }),
    );
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith({ vendor: "nvidia" }),
    );
  });
  it("stays quiet in the browser preview", () => {
    const { container } = render(<DriverCheck />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SessionChanges", () => {
  it("lists outcomes and the plain nothing-changed sentence", () => {
    const base = {
      mechanisms: [
        {
          id: "gameMode",
          state: "skipped",
          detail: "Windows Game Mode is already on.",
          code: "already-set",
        },
      ],
    } as unknown as BoostSession;
    render(<SessionChanges session={base} />);
    expect(
      screen.getByText(
        "This PC was already configured; expect little or no FPS difference.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("already set")).toBeInTheDocument();
  });
});
