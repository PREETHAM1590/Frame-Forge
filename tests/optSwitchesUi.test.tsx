// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  within,
  waitFor,
} from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import App from "../src/App";
import { catalogue } from "../shared/catalogue";
import { pendingStore } from "../src/pendingChanges";
import {
  defaultState as unansweredState,
  type FrameforgeApi,
  type OperationId,
} from "../shared/contracts";

const defaultState = {
  ...unansweredState,
  settings: { ...unansweredState.settings, privacyAsked: true },
};
const nm = (id: OperationId) => catalogue.find((o) => o.id === id)!.name;
const A1 = "11111111-1111-4111-8111-111111111111";
type State = "on" | "off" | "unknown";
const applied = (id: string, ids: OperationId[]) => ({
  id,
  label: "Optimization applied",
  at: "2026-10-14T01:00:00.000Z",
  status: "success" as const,
  message: "Windows settings re-read and verified.",
  ids,
  rollback: true,
});
function install(
  capabilities: OperationId[],
  states: Partial<Record<OperationId, State>>,
  activity: ReturnType<typeof applied>[] = [],
) {
  const calls: { method: string; input: unknown }[] = [];
  type Row = Omit<ReturnType<typeof applied>, "status"> & { status: string };
  const world: {
    states: Partial<Record<OperationId, State>>;
    activity: Row[];
    declined: boolean;
  } = {
    states: { ...states },
    activity: [...activity],
    declined: false,
  };
  const log = (method: string, input: unknown) => calls.push({ method, input });
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
      activity: world.activity,
      backups: [],
      capabilities,
      bootedAt: "2026-10-14T00:00:00.000Z",
      startupSupported: false,
      version: "test",
      mode: "desktop",
      boost: { session: null, available: true, watching: false },
    }),
    onEvent: () => () => undefined,
    restoreStatus: async () => {
      throw new Error("not needed");
    },
    optimizationStatus: async () =>
      capabilities.map((id) => ({
        id,
        state: world.states[id] ?? "unknown",
      })),
    preview: async (input: { ids: OperationId[] }) => {
      log("preview", input);
      return {
        token: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        ids: input.ids,
        changes: input.ids.map((id) => ({
          id,
          setting: `setting of ${id}`,
          before: "a",
          after: "b",
        })),
        warnings: [],
        restart: "none",
        admin: input.ids.includes("uac-off"),
        security: input.ids.filter((id) => id === "uac-off"),
      };
    },
    confirm: async (input: { token: string }) => {
      log("confirm", input);
      if (world.declined)
        return {
          ...applied(crypto.randomUUID(), ["capture-off"]),
          status: "cancelled" as const,
          rollback: false,
          message:
            "Not applied — administrator approval was declined. Nothing was changed.",
        };
      const row = applied(crypto.randomUUID(), ["capture-off"]);
      world.activity = [row, ...world.activity];
      world.states["capture-off"] = "on";
      return row;
    },
    rollbackBatch: async (input: { ids: string[] }) => {
      log("rollbackBatch", input);
      for (const a of world.activity.filter((x) => input.ids.includes(x.id)))
        for (const id of a.ids) world.states[id] = "off";
      world.activity = world.activity.map((a) =>
        input.ids.includes(a.id)
          ? { ...a, status: "rolled-back" as const, rollback: false }
          : a,
      );
      return world.activity.filter((a) => input.ids.includes(a.id));
    },
  } as unknown as FrameforgeApi;
  return { calls, world };
}
const sw = (name: string) => screen.findByRole("switch", { name });
async function open(
  capabilities: OperationId[],
  states: Partial<Record<OperationId, State>>,
  activity: ReturnType<typeof applied>[] = [],
) {
  const env = install(capabilities, states, activity);
  render(<App />);
  await screen.findByText("Your setup, in focus.");
  fireEvent.click(screen.getByRole("button", { name: "Optimizations" }));
  return env;
}
beforeEach(() => {
  window.scrollTo = () => {};
  pendingStore.clear();
});
afterEach(() => {
  cleanup();
  delete window.frameforge;
});

describe("real state on every row", () => {
  it("maps applied, already-set, off, unknown and unavailable", async () => {
    await open(
      [
        "mouse-precision",
        "transparency-off",
        "capture-off",
        "explorer-no-recent",
      ],
      {
        "mouse-precision": "on",
        "transparency-off": "on",
        "capture-off": "off",
      },
      [applied(A1, ["mouse-precision"])],
    );
    const mouse = await sw(nm("mouse-precision"));
    await waitFor(() => expect(mouse).toBeChecked());
    expect(mouse).toBeEnabled();
    expect(
      screen.getByText("On — applied by Frameforge, can undo"),
    ).toBeVisible();
    const already = await sw(nm("transparency-off"));
    await waitFor(() => expect(already).toBeChecked());
    expect(already).toBeDisabled();
    expect(already).toHaveAttribute(
      "title",
      "Windows already had this; nothing to undo",
    );
    expect(screen.getByText("On — already set in Windows")).toBeVisible();
    const off = await sw(nm("capture-off"));
    expect(off).not.toBeChecked();
    await waitFor(() => expect(off).toBeEnabled());
    const unknown = await sw(nm("explorer-no-recent"));
    expect(unknown).toBeDisabled();
    expect(unknown).toHaveAttribute(
      "title",
      "Can't read without administrator; open Details",
    );
    // Not in the capability list at all.
    expect(await sw(nm("sticky-keys-shortcut-off"))).toBeDisabled();
  });
});

describe("pending changes and Review & save", () => {
  it("flipping marks a row pending, flipping back cancels, nothing reaches Windows", async () => {
    const { calls } = await open(["capture-off"], { "capture-off": "off" });
    const s = await sw(nm("capture-off"));
    await waitFor(() => expect(s).toBeEnabled());
    fireEvent.click(s);
    expect(s).toBeChecked();
    expect(screen.getByText("Will turn on")).toBeVisible();
    expect(
      screen.getByRole("region", { name: "Pending changes" }),
    ).toHaveTextContent("1 change pending (0 need administrator)");
    fireEvent.click(s);
    expect(s).not.toBeChecked();
    expect(
      screen.queryByRole("region", { name: "Pending changes" }),
    ).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it("one review applies the turn-ons and undoes the turn-offs, then settles to Windows' state", async () => {
    const { calls } = await open(
      ["capture-off", "mouse-precision"],
      { "capture-off": "off", "mouse-precision": "on" },
      [applied(A1, ["mouse-precision"])],
    );
    const on = await sw(nm("capture-off"));
    const off = await sw(nm("mouse-precision"));
    await waitFor(() => expect(off).toBeChecked());
    fireEvent.click(on);
    fireEvent.click(off);
    expect(
      screen.getByRole("region", { name: "Pending changes" }),
    ).toHaveTextContent("2 changes pending");
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("setting of capture-off");
    expect(within(dialog).getByText(/Turning off/)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm & apply" }),
    );
    const rows = await within(dialog).findByRole("list", {
      name: "Result for each switch",
    });
    expect(rows).toHaveTextContent(`${nm("mouse-precision")}: Off (verified)`);
    expect(rows).toHaveTextContent(`${nm("capture-off")}: On (verified)`);
    expect(calls.map((c) => c.method)).toEqual([
      "preview",
      "confirm",
      "rollbackBatch",
    ]);
    expect(
      calls.find((c) => c.method === "rollbackBatch")?.input,
    ).toMatchObject({ ids: [A1], confirmed: true });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(off).not.toBeChecked());
    expect(on).toBeChecked();
    expect(
      screen.queryByRole("region", { name: "Pending changes" }),
    ).toBeNull();
  });
  it("closing the review keeps the switches pending; Discard reverts them visually", async () => {
    const { calls } = await open(["capture-off"], { "capture-off": "off" });
    const s = await sw(nm("capture-off"));
    await waitFor(() => expect(s).toBeEnabled());
    fireEvent.click(s);
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("setting of capture-off");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(s).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(s).not.toBeChecked();
    expect(calls.map((c) => c.method)).toEqual(["preview"]);
  });
  it("a security item needs the typed confirmation inside the combined review", async () => {
    const { calls } = await open(["uac-off", "capture-off"], {
      "uac-off": "off",
      "capture-off": "off",
    });
    const sec = await sw(nm("uac-off"));
    await waitFor(() => expect(sec).toBeEnabled());
    fireEvent.click(sec);
    fireEvent.click(await sw(nm("capture-off")));
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("setting of uac-off");
    // One preview covers both, security item included.
    expect(calls.filter((c) => c.method === "preview")).toHaveLength(1);
    const apply = within(dialog).getByRole("button", {
      name: "Confirm & apply",
    });
    fireEvent.click(within(dialog).getByLabelText(/I reviewed/));
    fireEvent.click(within(dialog).getByLabelText(/I understand this lowers/));
    expect(apply).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Type/), {
      target: { value: nm("uac-off") },
    });
    expect(apply).toBeEnabled();
  });
  it("leaving the page with pending changes asks to stay or discard", async () => {
    await open(["capture-off"], { "capture-off": "off" });
    const s = await sw(nm("capture-off"));
    await waitFor(() => expect(s).toBeEnabled());
    fireEvent.click(s);
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    const ask = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(ask).getByRole("button", { name: /Stay/ }));
    expect(s).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "Presets" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Discard and leave",
      }),
    );
    expect(pendingStore.count()).toBe(0);
    await screen.findByRole("heading", { name: "Presets", level: 1 });
  });
  it("a declined administrator step skips the turn-offs and lists the failure per row", async () => {
    const { calls, world } = await open(
      ["capture-off", "mouse-precision"],
      { "capture-off": "off", "mouse-precision": "on" },
      [applied(A1, ["mouse-precision"])],
    );
    world.declined = true;
    const on = await sw(nm("capture-off"));
    const off = await sw(nm("mouse-precision"));
    await waitFor(() => expect(off).toBeChecked());
    fireEvent.click(on);
    fireEvent.click(off);
    fireEvent.click(screen.getByRole("button", { name: "Review & save" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("setting of capture-off");
    fireEvent.click(within(dialog).getByRole("checkbox"));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Confirm & apply" }),
    );
    await within(dialog).findByText(/Turning items off was not attempted/);
    expect(calls.map((c) => c.method)).toEqual(["preview", "confirm"]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    // Switches settle to what Windows reports: unchanged.
    await waitFor(() => expect(on).not.toBeChecked());
    expect(off).toBeChecked();
  });
});
