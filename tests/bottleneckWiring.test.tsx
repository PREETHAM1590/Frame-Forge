// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { getBottleneck } from "../shared/gameSettings";
import type { SmartProfile, SmartStatus } from "../shared/contracts";

const profile = (gameId: string, classification: string) =>
  ({ gameId, classification }) as unknown as SmartProfile;
const learned: SmartStatus = {
  observing: null,
  candidate: null,
  profiles: [
    profile("cpu-game", "cpu-bound"),
    profile("capped-game", "frame-capped"),
    profile("hot-game", "thermal"),
  ],
};
vi.mock("../src/api", () => ({
  request: vi.fn(async () => learned),
  onEvent: () => () => undefined,
}));

describe("per-game settings guide reads what Smart mode learned", () => {
  it("maps learned classifications to the guide's bottleneck, and gives no hint for a frame cap or an unknown game", async () => {
    const { useSmart } = await import("../src/useSmart");
    expect(getBottleneck("cpu-game")).toBeNull();
    const { result } = renderHook(() => useSmart());
    await waitFor(() => expect(result.current.status.profiles).toHaveLength(3));
    expect(getBottleneck("cpu-game")).toBe("cpu");
    expect(getBottleneck("hot-game")).toBe("thermal");
    expect(getBottleneck("capped-game")).toBeNull();
    expect(getBottleneck("never-seen")).toBeNull();
    act(() => result.current.set({ ...learned, profiles: [] }));
    expect(getBottleneck("cpu-game")).toBeNull();
  });
});
