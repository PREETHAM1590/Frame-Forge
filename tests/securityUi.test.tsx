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
import {
  defaultState,
  type FrameforgeApi,
  type OperationId,
} from "../shared/contracts";

const row = (id: string, ids: OperationId[], at: string) => ({
  id,
  label: "Optimization applied",
  at,
  status: "success" as const,
  message: "Windows settings re-read and verified.",
  ids,
  rollback: true,
});
function install(
  capabilities: OperationId[],
  activity: ReturnType<typeof row>[] = [],
  bootedAt = "2026-10-14T00:00:00.000Z",
) {
  const calls: { method: string; input: unknown }[] = [];
  const log =
    <T,>(method: string, value: T) =>
    async (input: unknown) => {
      calls.push({ method, input });
      return value;
    };
  window.frameforge = {
    bootstrap: async () => ({
      state: defaultState,
      hardware: {
        source: "windows",
        collectedAt: "2026-01-01T00:00:00.000Z",
        cpu: "CPU",
        gpu: [],
        memoryBytes: 1,
        freeMemoryBytes: 1,
        cores: 1,
        os: "Windows",
        drives: [],
        displays: [],
        drivers: [],
        warnings: [],
      },
      activity,
      backups: [],
      capabilities,
      bootedAt,
      startupSupported: false,
      version: "test",
      mode: "desktop",
      boost: { session: null, available: true, watching: false },
    }),
    onEvent: () => () => undefined,
    restoreStatus: async () => {
      throw new Error("not needed");
    },
    preview: async (input: { ids: OperationId[] }) => ({
      token: crypto.randomUUID(),
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      ids: input.ids,
      changes: [{ id: input.ids[0], setting: "s", before: "a", after: "b" }],
      warnings: [],
      restart: "reboot",
      admin: true,
      security: input.ids.filter((id) => id === "uac-off"),
    }),
    confirm: log(
      "confirm",
      row(crypto.randomUUID(), ["uac-off"], "2026-10-14T01:00:00.000Z"),
    ),
    rollback: async (input: { id: string }) => {
      calls.push({ method: "rollback", input });
      return {
        ...row(input.id, ["uac-off"], "2026-10-14T01:00:00.000Z"),
        status: "rolled-back" as const,
        rollback: false,
      };
    },
    restartExplorer: log("restartExplorer", true),
  } as unknown as FrameforgeApi;
  return calls;
}
beforeEach(() => {
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});

describe("catalogue browsing", () => {
  it("groups, searches and filters by risk, and lists what is not offered", async () => {
    install(["transparency-off", "uac-off"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Optimizations" }));
    expect(
      await screen.findByRole("heading", {
        name: "Security trade-offs",
        level: 2,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("heading", { name: "Quality of Life", level: 2 }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText("Search optimizations"), {
      target: { value: "transparency" },
    });
    expect(screen.getByText("Turn off transparency effects")).toBeVisible();
    expect(screen.queryByText("Turn off User Account Control")).toBeNull();
    fireEvent.change(screen.getByLabelText("Search optimizations"), {
      target: { value: "" },
    });
    fireEvent.click(
      within(screen.getByRole("group", { name: "Risk" })).getByRole("button", {
        name: "High",
      }),
    );
    expect(screen.getByText("Turn off User Account Control")).toBeVisible();
    expect(screen.queryByText("Turn off transparency effects")).toBeNull();
    expect(
      screen.getByText(/Not offered or information only/),
    ).toBeInTheDocument();
  });
  it("asks before restarting Explorer", async () => {
    const calls = install(["transparency-off"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Optimizations" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Restart Explorer/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(calls.some((c) => c.method === "restartExplorer")).toBe(false);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Restart Explorer" }),
    );
    await within(document.body).findByText("Windows Explorer restarted.");
    expect(calls.filter((c) => c.method === "restartExplorer")).toHaveLength(1);
  });
});

describe("security trade-off guardrails", () => {
  it("needs the acknowledgement and the typed name, then sends the acknowledgement", async () => {
    const calls = install(["uac-off"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    fireEvent.click(screen.getByRole("button", { name: "Optimizations" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Details for Turn off User Account Control",
      }),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Review security trade-off/ }),
    );
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("s");
    const apply = within(dialog).getByRole("button", {
      name: "Confirm & apply",
    });
    const [reviewed] = within(dialog).getAllByRole("checkbox");
    fireEvent.click(reviewed!);
    expect(apply).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText(/I understand this lowers/));
    expect(apply).toBeDisabled();
    fireEvent.change(
      within(dialog).getByLabelText(/Type .*Turn off User Account Control/),
      { target: { value: "turn off user account control" } },
    );
    expect(apply).toBeEnabled();
    fireEvent.click(apply);
    await within(dialog).findByText(/Windows settings re-read/);
    expect(calls.find((c) => c.method === "confirm")?.input).toMatchObject({
      acknowledged: ["uac-off"],
    });
  });
  it("never previews a security trade-off together with other items", async () => {
    install(["uac-off", "transparency-off"]);
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    // Presets cannot hold them, so the only way in is the single-item details dialog.
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    fireEvent.click(
      await screen.findByRole("button", { name: /Custom preset/ }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).queryByText("Turn off User Account Control"),
    ).toBeNull();
    expect(
      within(dialog).getByText("Turn off transparency effects"),
    ).toBeVisible();
  });
});

describe("dashboard security banner", () => {
  it("shows lowered settings and restores them all, newest first", async () => {
    const rows = [
      row(
        "11111111-1111-4111-8111-111111111111",
        ["uac-off"],
        "2026-10-14T02:00:00.000Z",
      ),
      row(
        "22222222-2222-4222-8222-222222222222",
        ["smartscreen-off"],
        "2026-10-14T01:00:00.000Z",
      ),
      row(
        "33333333-3333-4333-8333-333333333333",
        ["transparency-off"],
        "2026-10-14T00:30:00.000Z",
      ),
    ];
    const calls = install(["uac-off"], rows);
    render(<App />);
    const banner = await screen.findByText(
      "Security settings are lowered on this PC.",
    );
    expect(banner.closest("div")).toHaveTextContent(
      "Turn off User Account Control, Turn off Windows SmartScreen",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      /Pending restart: Turn off User Account Control/,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Restore all security settings" }),
    );
    await screen.findByText("Your setup, in focus.");
    await new Promise((r) => setTimeout(r, 50));
    expect(
      calls
        .filter((c) => c.method === "rollback")
        .map((c) => (c.input as { id: string }).id),
    ).toEqual([rows[0]!.id, rows[1]!.id]);
  });
  it("shows nothing when no security setting is lowered", async () => {
    install(
      ["uac-off"],
      [
        row(
          "33333333-3333-4333-8333-333333333333",
          ["transparency-off"],
          "2026-10-14T00:30:00.000Z",
        ),
      ],
    );
    render(<App />);
    await screen.findByText("Your setup, in focus.");
    expect(
      screen.queryByText("Security settings are lowered on this PC."),
    ).toBeNull();
  });
});
