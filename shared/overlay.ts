// In-game overlay: saved configuration and the pure logic behind it (what to show, where, when). No Electron here, so it tests directly.
import { z } from "zod";
import type { FpsStatus, MonitorSample } from "./contracts.js";

export const overlayCorners = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
] as const;
export const OverlayConfigSchema = z
  .object({
    /** "Show overlay": show it automatically while a boost session is active. */
    enabled: z.boolean().default(false),
    corner: z.enum(overlayCorners).default("top-left"),
    opacity: z.number().min(0.3).max(1).default(0.85),
    scale: z.number().min(0.75).max(2).default(1),
    fps: z.boolean().default(true),
    low1: z.boolean().default(true),
    graph: z.boolean().default(true),
    cpu: z.boolean().default(true),
    gpu: z.boolean().default(true),
    ram: z.boolean().default(true),
    clock: z.boolean().default(false),
  })
  .strict();
export type OverlayConfig = z.infer<typeof OverlayConfigSchema>;
export type OverlayCorner = (typeof overlayCorners)[number];
export const defaultOverlay: OverlayConfig = OverlayConfigSchema.parse({});
/** Saved settings may predate the overlay or hold something unusable: always fall back to defaults. */
export const resolveOverlay = (saved: unknown): OverlayConfig => {
  const parsed = OverlayConfigSchema.safeParse(saved ?? {});
  return parsed.success ? parsed.data : defaultOverlay;
};

/** Window size at scale 1 (CSS pixels); the page is zoomed by `scale` and the window grows with it. */
export const baseSize = { width: 240, height: 140 } as const;
const margin = 16;
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** Overlay window rectangle inside the given display's bounds. */
export function overlayRect(
  display: Rect,
  corner: OverlayCorner,
  scale: number,
): Rect {
  const width = Math.round(baseSize.width * scale);
  const height = Math.round(baseSize.height * scale);
  const right = corner.endsWith("right");
  const bottom = corner.startsWith("bottom");
  return {
    width,
    height,
    x: right ? display.x + display.width - width - margin : display.x + margin,
    y: bottom
      ? display.y + display.height - height - margin
      : display.y + margin,
  };
}

/** Auto: shown while a boost is live and "Show overlay" is on. The tray toggle (manual) overrides the automatic rule. */
export const overlayVisible = (
  config: OverlayConfig,
  boostLive: boolean,
  manual: boolean | null,
) => manual ?? (config.enabled && boostLive);

export const fpsHint = "FPS: start capture in Frameforge";
/** What the overlay window draws. null means "not measured". */
export interface OverlayModel {
  corner: OverlayCorner;
  opacity: number;
  fps: number | null;
  low1: number | null;
  /** FPS wanted but no capture is running. */
  hint: string | null;
  /** Frame times in ms, oldest first. */
  graph: number[] | null;
  cpu: number | null;
  gpu: number | null;
  ram: number | null;
  clock: string | null;
  show: {
    fps: boolean;
    low1: boolean;
    cpu: boolean;
    gpu: boolean;
    ram: boolean;
  };
}
const maxGraphPoints = 60;
export function buildModel(
  config: OverlayConfig,
  fps: Pick<FpsStatus, "state" | "fps" | "low1Fps" | "frameTimes"> | null,
  sample: MonitorSample | null,
  now: Date,
): OverlayModel {
  const capturing = fps?.state === "capturing";
  const wantsFps = config.fps || config.low1 || config.graph;
  const adapters = sample?.gpu.available ? sample.gpu.adapters : [];
  const memory = sample?.memory;
  return {
    corner: config.corner,
    opacity: config.opacity,
    fps: capturing && fps.fps !== null ? Math.round(fps.fps) : null,
    low1: capturing && fps.low1Fps !== null ? Math.round(fps.low1Fps) : null,
    hint: wantsFps && !capturing ? fpsHint : null,
    graph:
      config.graph && capturing ? fps.frameTimes.slice(-maxGraphPoints) : null,
    cpu: sample ? Math.round(sample.cpu.total) : null,
    gpu: adapters.length
      ? Math.round(Math.max(...adapters.map((a) => a.engine3d)))
      : null,
    ram:
      memory && memory.totalBytes > 0
        ? Math.round(
            ((memory.totalBytes - memory.availableBytes) / memory.totalBytes) *
              100,
          )
        : null,
    clock: config.clock
      ? now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : null,
    show: {
      fps: config.fps,
      low1: config.low1,
      cpu: config.cpu,
      gpu: config.gpu,
      ram: config.ram,
    },
  };
}
