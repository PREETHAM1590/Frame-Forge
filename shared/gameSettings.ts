// Curated per-game settings guidance (v1.4.0). READ-ONLY: Frameforge never writes game config files; it only tells you what to set in the game's own menu.
// Evidence is grade C (guides) unless a source says otherwise, so impact is qualitative and no FPS numbers are promised.
// Source of truth: docs/research/gamer-community-techniques.md section 5.
import { z } from "zod";
import type { Hardware } from "./contracts.js";

export const gameSettingsVersion = "2026.10.1";
export const tiers = ["cpu", "gpu", "vram", "laptop"] as const;
export type Tier = (typeof tiers)[number];
export type Bottleneck = "cpu" | "gpu" | "vram" | "thermal" | "memory";
const Url = z.url().refine((u) => u.startsWith("https://"), "https only");
const Impact = z.enum(["high", "medium", "low"]);
export type Impact = z.infer<typeof Impact>;

const TieredValue = z
  .object({
    default: z.string().min(1),
    cpu: z.string().optional(),
    gpu: z.string().optional(),
    vram: z.string().optional(),
    laptop: z.string().optional(),
  })
  .strict();
const SettingSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    value: TieredValue,
    impact: Impact,
    /** Plain-language reason shown under the setting. */
    why: z.string().min(1),
    /** Only show when one of these tiers is active (omitted: always). */
    appliesTo: z.array(z.enum(tiers)).optional(),
    source: Url,
  })
  .strict();
export const GameEntrySchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    name: z.string().min(1),
    /** Lower-case executable file names. */
    exes: z.array(z.string().min(1)).min(1),
    steamAppId: z.string().regex(/^\d+$/).optional(),
    /** Lower-case fragments of the install path (forward slashes). */
    pathHints: z.array(z.string()).default([]),
    engine: z.string().min(1),
    api: z.string().min(1),
    goal: z.enum(["competitive", "quality"]),
    boundBy: z.array(z.enum(["cpu", "gpu", "vram"])).min(1),
    antiCheat: z.enum([
      "Vanguard",
      "EAC",
      "VAC",
      "BattlEye",
      "Ricochet",
      "Hyperion",
      "none",
    ]),
    /** Always guide-only: Frameforge does not edit game files. */
    configPolicy: z.literal("guide-only"),
    reflex: z
      .object({
        nvidiaReflex: z.boolean(),
        amdAntiLag: z.boolean(),
        note: z.string(),
      })
      .strict(),
    upscalers: z.array(z.string()),
    frameGen: z.enum(["avoid", "optional", "unavailable"]),
    /** Where the in-game frame limiter lives; null when the game has none (use NVIDIA Control Panel / RTSS). */
    frameLimiter: z.string().nullable(),
    settings: z.array(SettingSchema).min(1),
    notes: z.array(z.string()),
    lastVerified: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict();
export type GameEntry = z.infer<typeof GameEntrySchema>;
export type GameSetting = z.infer<typeof SettingSchema>;

const U = {
  valorant: "https://www.pcgamesn.com/valorant/best-settings-for-fps",
  cs2: "https://dotesports.com/counter-strike/news/best-video-settings-for-cs2",
  fortnite: "https://www.evetech.co.za/best-settings-fortnite-pc/e/3807",
  fortnitePerf:
    "https://www.esports.net/news/fortnite/fortnite-low-vs-performance-mode",
  fortniteDx12:
    "https://www.computerbase.de/2019-11/patch-11.20-fortnite-directx-12/",
  apex: "https://www.esportstales.com/apex-legends/how-to-increase-fps-videoconfig-settings-launch-options",
  warzone:
    "https://www.pcgamesn.com/call-of-duty-warzone/settings-best-pc-keybinds",
  warzone2: "https://noping.com/blog/best-pc-settings-for-warzone",
  roblox:
    "https://primagames.com/tips/can-you-be-banned-in-roblox-for-using-an-fps-unlocker",
  minecraft: "https://www.exitlag.com/blog/sodium-minecraft/",
  cyberpunk:
    "https://www.notebookcheck.com/Cyberpunk-2077-Phantom-Liberty-im-Test-Laptop-und-Desktop-Benchmarks.758157.0.html",
  outlast: "https://howmanyfps.com/fix-fps/the-outlast-trials",
  outlast2:
    "https://commonsensegamer.com/the-outlast-trials-how-to-fix-crashes-and-performance-issues-hcma/",
  gsync:
    "https://www.blurbusters.com/gsync/gsync101-input-lag-tests-and-settings/7/",
  reflex: "https://www.techspot.com/article/2123-nvidia-reflex-rtx/",
  ram: "https://www.techspot.com/article/3066-single-stick-vs-dual-channel-ram/",
  gta: "https://www.nvidia.com/en-us/geforce/guides/grand-theft-auto-v-pc-graphics-and-performance-guide/",
  frameGen:
    "https://amp.hothardware.com/news/dlss-3-frame-generation-digital-foundry-testing",
} as const;

type V = z.infer<typeof TieredValue>;
const s = (
  key: string,
  label: string,
  value: V | string,
  impact: Impact,
  why: string,
  source: string,
  appliesTo?: Tier[],
) => ({
  key,
  label,
  value: typeof value === "string" ? { default: value } : value,
  impact,
  why,
  source,
  ...(appliesTo ? { appliesTo } : {}),
});
const noFrameGen = (game: string) =>
  `Frame generation adds latency and is not worth it in ${game}. Keep it off.`;

export const gameDatabase: GameEntry[] = [
  {
    id: "valorant",
    name: "VALORANT",
    exes: ["valorant-win64-shipping.exe", "valorant.exe"],
    pathHints: ["riot games/valorant"],
    engine: "Unreal Engine 4",
    api: "DirectX 11",
    goal: "competitive",
    boundBy: ["cpu"],
    antiCheat: "Vanguard",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: true,
      note: "Set NVIDIA Reflex Low Latency to On (or On + Boost) under Settings > Video > General.",
    },
    upscalers: [],
    frameGen: "unavailable",
    frameLimiter: "Settings > Video > General > Limit FPS Always",
    settings: [
      s(
        "multithreaded",
        "Multithreaded Rendering",
        "On",
        "medium",
        "Spreads rendering over more CPU cores, which helps when one core is the limit.",
        U.valorant,
        ["cpu", "laptop"],
      ),
      s(
        "vsync",
        "Vertical Sync",
        "Off",
        "high",
        "V-Sync adds input delay. Use a frame cap near your refresh rate instead.",
        U.gsync,
      ),
      s(
        "mode",
        "Display mode",
        "Fullscreen",
        "low",
        "Exclusive fullscreen avoids compositor overhead on some systems.",
        U.valorant,
      ),
      s(
        "cosmetic",
        "Vignette, Distortion, Cast Shadows",
        "Off",
        "low",
        "Cosmetic effects with a small cost. Switching them off also gives a cleaner image.",
        U.valorant,
      ),
      s(
        "textures",
        "Material and Texture Quality",
        { default: "Low", vram: "Low", gpu: "Medium" },
        "low",
        "Guides disagree on this one, which suggests it matters little.",
        U.valorant,
      ),
      s(
        "resolution",
        "Resolution scale",
        {
          default: "100%",
          gpu: "Lower only if the GPU is at 95%+",
          laptop: "Lower only if the GPU is at 95%+",
        },
        "low",
        "On a CPU-bound PC, lowering resolution barely helps.",
        U.valorant,
        ["gpu", "vram", "laptop"],
      ),
    ],
    notes: [
      "Vanguard is a kernel-level anti-cheat. Frameforge never edits VALORANT files; set everything in the game menu.",
      "Dual-channel RAM is the highest-value hardware item for CPU-bound shooters.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "cs2",
    name: "Counter-Strike 2",
    exes: ["cs2.exe"],
    steamAppId: "730",
    pathHints: ["counter-strike global offensive"],
    engine: "Source 2",
    api: "Vulkan / DirectX 11",
    goal: "competitive",
    boundBy: ["cpu"],
    antiCheat: "VAC",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: true,
      note: "Enable NVIDIA Reflex in Video settings; AMD users can use Radeon Anti-Lag in the driver.",
    },
    upscalers: ["FSR", "NVIDIA Image Scaling"],
    frameGen: "unavailable",
    frameLimiter: "Console: fps_max <number> (0 is uncapped)",
    settings: [
      s(
        "vsync",
        "Vertical Sync",
        "Disabled",
        "high",
        "V-Sync adds input delay.",
        U.gsync,
      ),
      s(
        "msaa",
        "Anti-aliasing",
        { default: "4x MSAA", vram: "2x MSAA", laptop: "2x MSAA" },
        "medium",
        "MSAA is the main GPU cost in CS2 video settings.",
        U.cs2,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "shaders",
        "Shader Detail",
        "Low",
        "medium",
        "Lower shader detail is a cheap FPS gain for little visual loss.",
        U.cs2,
      ),
      s(
        "models",
        "Model / Texture Detail",
        { default: "Medium", vram: "Low" },
        "low",
        "Medium keeps players readable; Low saves VRAM.",
        U.cs2,
      ),
      s(
        "ram",
        "Dual-channel RAM",
        "Two matched sticks",
        "high",
        "A CS2 test showed 1% lows moving little, but dual channel is the best-evidenced CPU-bound fix.",
        U.ram,
        ["cpu", "laptop"],
      ),
    ],
    notes: [
      "autoexec.cfg is Valve-supported, but Frameforge stays guide-only.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "fortnite",
    name: "Fortnite",
    exes: ["fortniteclient-win64-shipping.exe"],
    pathHints: ["fortnite"],
    engine: "Unreal Engine 5",
    api: "DirectX 12 / DirectX 11 / Performance mode",
    goal: "competitive",
    boundBy: ["cpu", "gpu"],
    antiCheat: "EAC",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: false,
      note: "Set NVIDIA Reflex Low Latency to On, or On + Boost on RTX 30/40/50 cards.",
    },
    upscalers: ["DLSS", "FSR", "TSR"],
    frameGen: "avoid",
    frameLimiter: "Settings > Video > Frame Rate Limit",
    settings: [
      s(
        "mode",
        "Rendering mode",
        {
          default: "Performance mode",
          gpu: "Performance mode",
          cpu: "DirectX 11 or Performance mode",
        },
        "high",
        "Performance mode has the lowest GPU cost at the price of image quality.",
        U.fortnitePerf,
      ),
      s(
        "api",
        "DirectX version",
        "Test DX11 and DX12 on this PC",
        "medium",
        "DX12 helped lows and AMD in 2019 but lost FPS on an RTX 2080. Rebuild shaders after switching.",
        U.fortniteDx12,
      ),
      s(
        "res3d",
        "3D resolution",
        {
          default: "100%",
          gpu: "Lower or use DLSS Quality",
          laptop: "Lower or use DLSS Quality",
        },
        "high",
        "Fewer pixels to render when the GPU is the limit.",
        U.fortnite,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "textures",
        "Textures",
        { default: "Medium", vram: "Low" },
        "medium",
        "Texture memory is the VRAM cost.",
        U.fortnite,
        ["vram", "laptop"],
      ),
      s(
        "shadows",
        "Shadows and effects",
        "Off / Low",
        "medium",
        "Shadows and effects are the expensive options in the non-Performance modes.",
        U.fortnite,
        ["gpu", "laptop"],
      ),
    ],
    notes: [
      noFrameGen("Fortnite competitive play"),
      "Easy Anti-Cheat is active; use in-game settings only.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "apex-legends",
    name: "Apex Legends",
    exes: ["r5apex.exe", "r5apex_dx12.exe"],
    steamAppId: "1172470",
    pathHints: ["apex legends"],
    engine: "Source (modified)",
    api: "DirectX 11",
    goal: "competitive",
    boundBy: ["cpu"],
    antiCheat: "EAC",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: true,
      note: "Set NVIDIA Reflex to Enabled (or Enabled + Boost), or turn on Radeon Anti-Lag.",
    },
    upscalers: ["Dynamic resolution", "NVIDIA Image Scaling"],
    frameGen: "unavailable",
    frameLimiter: "Settings > Video > Frame Rate Cap",
    settings: [
      s(
        "vsync",
        "V-Sync",
        "Disabled",
        "high",
        "V-Sync adds input delay.",
        U.gsync,
      ),
      s(
        "cap",
        "Frame rate cap",
        "Just under your refresh rate",
        "medium",
        "Keeps G-SYNC/FreeSync from touching its ceiling.",
        U.gsync,
      ),
      s(
        "model",
        "Model detail and effects",
        { default: "Low", gpu: "Medium" },
        "medium",
        "The engine is CPU-heavy; model detail and effects detail are the CPU-side costs.",
        U.apex,
        ["cpu", "laptop"],
      ),
      s(
        "textures",
        "Texture streaming budget",
        { default: "Match your VRAM", vram: "Low / Medium" },
        "medium",
        "Setting it above your VRAM causes stutter.",
        U.apex,
        ["vram", "laptop"],
      ),
    ],
    notes: [
      "videoconfig.txt and launch options are community-standard, but EA never confirmed that editing is safe, so Frameforge only describes menu settings.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "warzone",
    name: "Call of Duty: Warzone",
    exes: ["cod.exe", "modernwarfare.exe"],
    pathHints: ["call of duty", "warzone"],
    engine: "IW engine",
    api: "DirectX 12",
    goal: "competitive",
    boundBy: ["gpu", "vram"],
    antiCheat: "Ricochet",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: true,
      note: "Set NVIDIA Reflex Low Latency to On (or On + Boost).",
    },
    upscalers: ["DLSS", "FSR", "XeSS"],
    frameGen: "avoid",
    frameLimiter: "Settings > Graphics > Custom Framerate Limit",
    settings: [
      s(
        "textures",
        "Texture Resolution",
        { default: "Normal", vram: "Low" },
        "high",
        "Textures eat VRAM. Running out causes the worst stutter.",
        U.warzone,
        ["vram", "gpu", "laptop"],
      ),
      s(
        "shadows",
        "Shadow Map Resolution",
        "Low",
        "medium",
        "Shadows are among the biggest GPU costs.",
        U.warzone,
        ["gpu", "laptop"],
      ),
      s(
        "rt",
        "Ray tracing",
        "Off",
        "high",
        "Big GPU cost with no competitive benefit.",
        U.warzone2,
        ["gpu", "laptop", "vram"],
      ),
      s(
        "volumetrics",
        "Volumetrics and SSAO",
        "Low / Off",
        "medium",
        "Expensive effects that also reduce visibility in fights.",
        U.warzone2,
        ["gpu", "laptop"],
      ),
      s(
        "upscale",
        "Upscaling",
        {
          default: "Quality",
          gpu: "Balanced if below your target",
          laptop: "Balanced if below your target",
        },
        "high",
        "Renders at a lower resolution and scales it up.",
        U.warzone,
        ["gpu", "vram", "laptop"],
      ),
    ],
    notes: [
      noFrameGen("Warzone"),
      "Borderless windowed was claimed to cost 5-10% in one guide and disputed in another. Test it yourself.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "roblox",
    name: "Roblox",
    exes: ["robloxplayerbeta.exe"],
    pathHints: ["roblox/versions", "roblox\\versions"],
    engine: "Roblox engine",
    api: "DirectX 11 / Vulkan",
    goal: "competitive",
    boundBy: ["cpu"],
    antiCheat: "Hyperion",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: false,
      amdAntiLag: true,
      note: "Roblox has no Reflex support. AMD users can use Radeon Anti-Lag in the driver.",
    },
    upscalers: [],
    frameGen: "unavailable",
    frameLimiter: "Roblox Settings > Maximum Frame Rate (up to 240)",
    settings: [
      s(
        "fps",
        "Maximum Frame Rate",
        "Your refresh rate (up to 240)",
        "medium",
        "The built-in limiter replaces risky FPS unlockers.",
        U.roblox,
      ),
      s(
        "quality",
        "Graphics Quality",
        {
          default: "Automatic",
          gpu: "Lower only if the GPU cannot hold the cap",
        },
        "low",
        "It mostly changes GPU load, and Roblox is usually CPU-bound.",
        U.roblox,
        ["gpu", "vram", "laptop"],
      ),
    ],
    notes: [
      "Do not use FPS unlockers. Hyperion anti-cheat can ban them.",
      "Shift+F5 shows the FPS counter.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "minecraft-java",
    name: "Minecraft: Java Edition",
    exes: ["minecraft.exe", "minecraftlauncher.exe"],
    pathHints: [".minecraft", "minecraft launcher"],
    engine: "Java (LWJGL)",
    api: "OpenGL",
    goal: "quality",
    boundBy: ["cpu", "gpu"],
    antiCheat: "none",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: false,
      amdAntiLag: true,
      note: "No Reflex support. Radeon Anti-Lag works in the driver.",
    },
    upscalers: [],
    frameGen: "unavailable",
    frameLimiter: "Options > Video Settings > Max Framerate",
    settings: [
      s(
        "render",
        "Render Distance",
        { default: "12", cpu: "8-10", laptop: "8-10" },
        "high",
        "Fewer chunks to build and draw. Lower this before Simulation Distance.",
        U.minecraft,
      ),
      s(
        "sim",
        "Simulation Distance",
        { default: "8", cpu: "5-6" },
        "medium",
        "How far entities and crops tick. Mostly a CPU cost.",
        U.minecraft,
        ["cpu", "laptop"],
      ),
      s(
        "sodium",
        "Sodium optimisation mod",
        "Consider it",
        "high",
        "The community default. The 20-300% claims are anecdotal and shrink on strong PCs. Frameforge does not install mods.",
        U.minecraft,
      ),
    ],
    notes: [
      "Mods change game files. Install them yourself from the official source.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "gta-v",
    name: "Grand Theft Auto V",
    exes: ["gta5.exe", "gta5_enhanced.exe"],
    steamAppId: "271590",
    pathHints: ["grand theft auto v"],
    engine: "RAGE",
    api: "DirectX 11",
    goal: "quality",
    boundBy: ["gpu", "cpu"],
    antiCheat: "BattlEye",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: false,
      amdAntiLag: true,
      note: "No Reflex support. Radeon Anti-Lag works in the driver.",
    },
    upscalers: ["FSR 1", "DLSS (Enhanced edition)"],
    frameGen: "unavailable",
    frameLimiter: null,
    settings: [
      s(
        "res",
        "Resolution",
        { default: "Native", gpu: "Lower first", laptop: "Lower first" },
        "high",
        "The biggest GPU lever, so change it first.",
        U.gta,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "msaa",
        "MSAA and Reflection MSAA",
        { default: "2x", gpu: "Off or 2x" },
        "high",
        "8x to 4x to 2x are large steps. Reflection MSAA is also expensive.",
        U.gta,
        ["gpu", "laptop"],
      ),
      s(
        "grass",
        "Grass Quality",
        "Normal",
        "medium",
        "Ultra to Normal gave about +12 FPS in one user report.",
        U.gta,
        ["gpu", "laptop"],
      ),
      s(
        "textures",
        "Texture Quality",
        { default: "Very High", vram: "High" },
        "low",
        "Cheap if your VRAM allows it.",
        U.gta,
        ["vram", "laptop"],
      ),
      s(
        "pop",
        "Population Density",
        { default: "Medium", cpu: "Low" },
        "low",
        "Low impact overall, a little CPU saving.",
        U.gta,
        ["cpu"],
      ),
    ],
    notes: [
      "Sources are dated (2015-2023); the grass figure comes from one user report. GTA Online uses BattlEye; use in-game settings only.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "cyberpunk-2077",
    name: "Cyberpunk 2077",
    exes: ["cyberpunk2077.exe"],
    steamAppId: "1091500",
    pathHints: ["cyberpunk 2077"],
    engine: "REDengine 4",
    api: "DirectX 12",
    goal: "quality",
    boundBy: ["gpu", "vram"],
    antiCheat: "none",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: true,
      amdAntiLag: true,
      note: "NVIDIA Reflex is available. It is required when frame generation is on.",
    },
    upscalers: ["DLSS", "FSR", "XeSS"],
    frameGen: "optional",
    frameLimiter: null,
    settings: [
      s(
        "rt",
        "Ray tracing / path tracing",
        {
          default: "Off",
          gpu: "Off",
          laptop: "Reflections or lighting at Medium, only with DLSS",
        },
        "high",
        "RT and path tracing are the main cost. Skip them if frame rate matters more.",
        U.cyberpunk,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "dlss",
        "DLSS / upscaling",
        "Quality",
        "high",
        "The big gain in this game: render at a lower resolution and upscale.",
        U.cyberpunk,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "preset",
        "Preset",
        { default: "High", laptop: "High without RT at 1080p" },
        "medium",
        "High without RT is the sweet spot on RTX 4050/4060 laptops.",
        U.cyberpunk,
        ["laptop"],
      ),
      s(
        "textures",
        "Texture Quality",
        { default: "High", vram: "Medium" },
        "high",
        "Phantom Liberty uses more VRAM; 6 GB cards run out.",
        U.cyberpunk,
        ["vram", "laptop"],
      ),
      s(
        "view",
        "Crowd density and view distance",
        { default: "High", cpu: "Medium" },
        "medium",
        "The CPU-side costs. Lower resolution does not help here.",
        U.cyberpunk,
        ["cpu"],
      ),
    ],
    notes: [
      "Frame generation can help a single-player game. It needs a base of about 60 FPS and Windows hardware-accelerated GPU scheduling.",
    ],
    lastVerified: "2026-10-14",
  },
  {
    id: "outlast-trials",
    name: "The Outlast Trials",
    exes: ["theoutlasttrials-win64-shipping.exe"],
    steamAppId: "1304930",
    pathHints: ["the outlast trials"],
    engine: "Unreal Engine 4",
    api: "DirectX 11",
    goal: "quality",
    boundBy: ["gpu", "vram"],
    antiCheat: "EAC",
    configPolicy: "guide-only",
    reflex: {
      nvidiaReflex: false,
      amdAntiLag: true,
      note: "No Reflex support.",
    },
    upscalers: ["DLSS", "FSR"],
    frameGen: "unavailable",
    frameLimiter: "Settings > Graphics > Frame Rate Limit",
    settings: [
      s(
        "res",
        "Resolution",
        {
          default: "1080p",
          gpu: "1080p rather than 1440p",
          laptop: "1080p rather than 1440p",
        },
        "high",
        "A lower resolution is the simplest GPU saving.",
        U.outlast,
        ["gpu", "vram", "laptop"],
      ),
      s(
        "limit",
        "In-game FPS limit",
        "60-100",
        "low",
        "Helped some users with stutter and heat. Guide quality is low, so no numbers are promised.",
        U.outlast2,
      ),
      s(
        "verify",
        "Verify game files and update the driver",
        "Do both",
        "medium",
        "A common fix for crashes and stutter in this game.",
        U.outlast2,
      ),
    ],
    notes: [
      "Expect shader stutter on the first run. Only low-quality guides exist for this game, so treat this as a starting point.",
    ],
    lastVerified: "2026-10-14",
  },
];

// ---- Matching ----
export interface GameRef {
  name: string;
  path: string;
  executablePath?: string | null;
}
const base = (p: string) =>
  p.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
/** Match by executable name first, then Steam app id, then install-path hint. Unknown games return null. */
export function matchGame(
  game: GameRef,
  steamAppId?: string,
): GameEntry | null {
  const exe = base(game.executablePath ?? "");
  const path = `${game.path} ${game.executablePath ?? ""}`
    .replace(/\\/g, "/")
    .toLowerCase();
  return (
    gameDatabase.find((e) => exe && e.exes.includes(exe)) ??
    (steamAppId
      ? gameDatabase.find((e) => e.steamAppId === steamAppId)
      : undefined) ??
    gameDatabase.find((e) =>
      e.pathHints.some((h) => path.includes(h.replace(/\\/g, "/"))),
    ) ??
    null
  );
}

// ---- Bottleneck interface (Smart mode plugs in here) ----
export type BottleneckProvider = (gameId: string) => Bottleneck | null;
let provider: BottleneckProvider = () => null;
/** Smart mode registers its classifier here. Until then getBottleneck returns null. */
export function setBottleneckProvider(next: BottleneckProvider | null) {
  provider = next ?? (() => null);
}
export function getBottleneck(gameId: string): Bottleneck | null {
  try {
    return provider(gameId);
  } catch {
    return null;
  }
}

// ---- Hardware profile ----
export interface HardwareProfile {
  gpuName: string;
  vendor: "nvidia" | "amd" | "intel" | "unknown";
  /** Estimated from the GPU model; null when unknown. */
  vramGb: number | null;
  lowVram: boolean;
  cpuThreads: number;
  ramGb: number;
  /** Not readable without elevation, so unknown; we always show the dual-channel check. */
  ramChannels: null;
  laptop: boolean;
  refreshHz: number | null;
  /** G-SYNC / FreeSync named by the display, or null when we cannot tell. */
  vrr: boolean | null;
}
// ponytail: name-based VRAM estimate; add a helper VRAM reading when the Windows helper exposes it.
const vramTable: [RegExp, number][] = [
  [/rtx (?:3050|4050)/i, 6],
  [/rtx (?:2060|3060 ti|3070|4060|5060|5050)/i, 8],
  [/rtx (?:3060)\b/i, 12],
  [/gtx (?:1650|1050)/i, 4],
  [/gtx (?:1660|1060)/i, 6],
  [/rtx 4070/i, 12],
  [/rtx (?:4080|5080|4090|5090|3090|3080 ti)/i, 16],
  [/rx (?:6600|7600)/i, 8],
  [/rx 7800/i, 16],
];
export function profileHardware(hw: Hardware): HardwareProfile {
  const gpuName =
    hw.gpu.find((g) => /nvidia|geforce|radeon|rtx|gtx|arc/i.test(g)) ??
    hw.gpu[0] ??
    "";
  const vendor = /nvidia|geforce|rtx|gtx/i.test(gpuName)
    ? "nvidia"
    : /amd|radeon|\brx\b/i.test(gpuName)
      ? "amd"
      : /intel|arc/i.test(gpuName)
        ? "intel"
        : "unknown";
  const vramGb = vramTable.find(([re]) => re.test(gpuName))?.[1] ?? null;
  const hz = hw.displays.flatMap((d) =>
    [...d.matchAll(/@\s*(\d{2,3})\s*Hz/gi)].map((m) => Number(m[1])),
  );
  const vrr = hw.displays.some((d) => /g-?sync|free-?sync|adaptive/i.test(d))
    ? true
    : null;
  return {
    gpuName,
    vendor,
    vramGb,
    lowVram: vramGb !== null && vramGb <= 6,
    cpuThreads: hw.cores,
    ramGb: Math.round(hw.memoryBytes / 1024 ** 3),
    ramChannels: null,
    laptop:
      /laptop|max-q|mobile/i.test(gpuName) ||
      /\d{4,5}(?:H|HX|HS|HK|U|P)\b/.test(hw.cpu),
    refreshHz: hz.length ? Math.max(...hz) : null,
    vrr,
  };
}

// ---- Tailoring ----
/** The tiers that apply, most specific first. */
export function activeTiers(
  profile: HardwareProfile,
  bottleneck: Bottleneck | null,
  entry?: GameEntry | null,
): Tier[] {
  const out: Tier[] = [];
  if (profile.laptop) out.push("laptop");
  if (profile.lowVram || bottleneck === "vram") out.push("vram");
  const primary: Tier =
    bottleneck === "cpu" || bottleneck === "gpu"
      ? bottleneck
      : entry
        ? entry.boundBy[0] === "vram"
          ? "gpu"
          : entry.boundBy[0]
        : profile.cpuThreads <= 6
          ? "cpu"
          : "gpu";
  if (!out.includes(primary)) out.push(primary);
  return out;
}
export interface TailoredSetting {
  key: string;
  label: string;
  value: string;
  impact: Impact;
  why: string;
  source: string;
}
const impactRank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };
export function tailorSettings(
  settings: GameSetting[],
  tier: Tier[],
): TailoredSetting[] {
  return settings
    .filter((x) => !x.appliesTo || x.appliesTo.some((t) => tier.includes(t)))
    .map((x) => ({
      key: x.key,
      label: x.label,
      impact: x.impact,
      why: x.why,
      source: x.source,
      value: tier.map((t) => x.value[t]).find(Boolean) ?? x.value.default,
    }))
    .sort((a, b) => impactRank[a.impact] - impactRank[b.impact]);
}

// ---- Generic fallback for unknown games ----
const G =
  "https://www.blurbusters.com/gsync/gsync101-input-lag-tests-and-settings/7/";
const genericByTier: Record<Tier, GameSetting[]> = {
  cpu: [
    s(
      "view",
      "View distance, crowd and object density",
      "Lower",
      "high",
      "Your CPU is the limit. Lowering resolution will not help.",
      U.ram,
    ),
    s(
      "mt",
      "Multithreaded rendering",
      "On, if offered",
      "medium",
      "Spreads work over more cores.",
      U.ram,
    ),
    s(
      "ram",
      "RAM in dual channel",
      "Two matched sticks",
      "high",
      "The best-evidenced fix for CPU-bound games.",
      U.ram,
    ),
  ],
  gpu: [
    s(
      "res",
      "Resolution scale or upscaler",
      "Upscaler on Quality",
      "high",
      "Fewer pixels to render when the GPU is the limit.",
      U.cyberpunk,
    ),
    s(
      "shadows",
      "Shadows, volumetrics and fog",
      "Lower",
      "high",
      "The most expensive GPU settings after resolution and ray tracing.",
      U.cyberpunk,
    ),
    s(
      "aa",
      "Anti-aliasing",
      "Lower MSAA or use TAA",
      "medium",
      "MSAA is costly.",
      U.cyberpunk,
    ),
  ],
  vram: [
    s(
      "tex",
      "Texture quality / streaming pool",
      "Lower one step",
      "high",
      "VRAM is nearly full, which causes stutter.",
      U.cyberpunk,
    ),
    s(
      "bg",
      "Close other VRAM users",
      "Close browsers and overlays",
      "medium",
      "Other apps take VRAM from the game.",
      U.cyberpunk,
    ),
  ],
  laptop: [
    s(
      "plug",
      "Plug in and use the performance mode",
      "Plugged in",
      "high",
      "Batteries throttle gaming laptops hard.",
      U.cyberpunk,
    ),
    s(
      "cap",
      "Cap FPS lower for steady frame times",
      "A steady cap",
      "medium",
      "Heat and power limits make a high cap unstable.",
      G,
    ),
  ],
};
export function genericSettings(tier: Tier[]): TailoredSetting[] {
  const merged = tier.flatMap((t) => genericByTier[t]);
  return tailorSettings(
    merged.filter((x, i) => merged.findIndex((y) => y.key === x.key) === i),
    tier,
  );
}

// ---- Frame cap ----
export interface FrameCapAdvice {
  cap: number | null;
  where: string;
  text: string;
  source: string;
}
/** Cap about 3 below refresh with VRR + V-Sync (Blur Busters), or let Reflex set it. */
export function frameCapAdvice(
  profile: HardwareProfile,
  entry: GameEntry | null,
): FrameCapAdvice {
  const hz = profile.refreshHz;
  const reflex = entry?.reflex.nvidiaReflex && profile.vendor === "nvidia";
  const where = entry?.frameLimiter
    ? `In-game: ${entry.frameLimiter} (preferred, lowest latency).`
    : profile.vendor === "nvidia"
      ? "NVIDIA Control Panel > Manage 3D settings > Max Frame Rate (this game has no in-game limiter)."
      : "RTSS or your GPU driver's frame limiter (this game has no in-game limiter).";
  if (!hz)
    return {
      cap: null,
      where,
      text: "Frameforge could not read your refresh rate. Cap about 3 FPS below it.",
      source: G,
    };
  const cap = hz - 3;
  const sync =
    profile.vrr === false
      ? ""
      : " With G-SYNC or FreeSync, also turn on V-Sync in the NVIDIA Control Panel (or driver) and turn it off in the game.";
  if (reflex)
    return {
      cap,
      where: "Turn on NVIDIA Reflex; it caps the frame rate for you.",
      text: `Reflex keeps frames just under ${hz} Hz on its own. If you set a cap yourself, use ${cap}.`,
      source: U.reflex,
    };
  return {
    cap,
    where,
    text: `Cap at ${cap} FPS for your ${hz} Hz display.${sync}`,
    source: G,
  };
}

export interface Advice {
  entry: GameEntry | null;
  tiers: Tier[];
  bottleneck: Bottleneck | null;
  settings: TailoredSetting[];
  frameCap: FrameCapAdvice;
  reflex: string;
  frameGen: string;
  upscalers: string[];
  notes: string[];
  /** Always true; shown so users know Frameforge never edits the game. */
  readOnly: true;
}
export function adviseGame(
  game: GameRef & { id: string },
  hw: Hardware,
  steamAppId?: string,
): Advice {
  const entry = matchGame(game, steamAppId);
  const profile = profileHardware(hw);
  const bottleneck = getBottleneck(game.id);
  const tiers = activeTiers(profile, bottleneck, entry);
  const settings = entry
    ? tailorSettings(entry.settings, tiers)
    : genericSettings(tiers);
  const reflex = !entry
    ? "If the game offers NVIDIA Reflex or AMD Anti-Lag, turn it on. It reduces input delay."
    : profile.vendor === "amd" && entry.reflex.amdAntiLag
      ? "Turn on Radeon Anti-Lag in the AMD driver for this game."
      : profile.vendor === "nvidia" && entry.reflex.nvidiaReflex
        ? entry.reflex.note
        : entry.reflex.nvidiaReflex || entry.reflex.amdAntiLag
          ? entry.reflex.note
          : "This game has no Reflex or Anti-Lag support.";
  const frameGen = !entry
    ? "Skip frame generation in competitive shooters. It adds latency."
    : entry.frameGen === "avoid"
      ? noFrameGen(entry.name)
      : entry.frameGen === "optional"
        ? "Frame generation can help here, but start from a base of about 60 FPS. It adds latency."
        : "This game has no frame generation.";
  return {
    entry,
    tiers,
    bottleneck,
    settings,
    frameCap: frameCapAdvice(profile, entry),
    reflex,
    frameGen,
    upscalers: entry?.upscalers ?? [],
    notes: entry?.notes ?? [
      "Frameforge has no entry for this game yet, so this is general advice.",
    ],
    readOnly: true,
  };
}
export function toChecklist(name: string, a: Advice): string {
  const lines = [
    `${name}: recommended settings`,
    ...a.settings.map((x) => `[ ] ${x.label}: ${x.value} (${x.impact} impact)`),
  ];
  lines.push(
    `[ ] Frame cap: ${a.frameCap.cap ?? "about 3 below refresh"} FPS. ${a.frameCap.where}`,
    `[ ] ${a.reflex}`,
    `[ ] ${a.frameGen}`,
  );
  return lines.join("\n");
}
