// PC Health Check: turns read-only facts (from the Windows helper) into checks with a status, a plain explanation, the expected
// impact and a fix. Pure, so every check is tested with fake facts. Numbers are quoted only where a source exists and are
// always called estimates; nothing here claims a gain on this PC.
import type {
  HealthCheck,
  HealthFacts,
  HealthFix,
  HealthReport,
  HealthStatus,
} from "./contracts.js";

export interface HealthContext {
  games: { id: string; name: string; executablePath: string | null }[];
  now?: number;
  /** A saved FPS capture with Game Mode on and one with it off exist for some game. */
  hasAbPair: boolean;
}

const GB = 1024 ** 3;
const gb = (bytes: number) => `${(bytes / GB).toFixed(1)} GB`;
const DAY = 86400000;
type Draft = Omit<HealthCheck, "fix" | "steps" | "top"> &
  Partial<Pick<HealthCheck, "steps" | "top">> & { fix?: HealthFix | null };
const finish = (d: Draft): HealthCheck => ({
  steps: [],
  top: false,
  fix: null,
  ...d,
});

export const isLaptop = (f: HealthFacts) => f.battery.present;

function power(f: HealthFacts): HealthCheck {
  const b = f.battery;
  const base = { id: "power-source", title: "Power source" };
  if (!b.present)
    return finish({
      ...base,
      status: "good",
      summary: "Desktop PC, no battery",
      explanation: "There is no battery, so power limits do not change.",
      impact: "Nothing to fix.",
    });
  if (!b.onAc)
    return finish({
      ...base,
      status: "bad",
      top: true,
      summary: `On battery${b.percent === null ? "" : ` (${b.percent}%)`}`,
      explanation:
        "Laptops lower CPU and GPU power limits on battery, and Windows may switch to a power-saving profile.",
      impact:
        "This is usually the largest single FPS factor on a gaming laptop: one published laptop test measured roughly 90-120 FPS plugged in against 55-70 on battery (Tom's Guide, Alienware 16, Cyberpunk). Your result will differ.",
      fix: { kind: "settings", page: "power", label: "Open power settings" },
      steps: ["Plug in the charger before you start the game."],
    });
  if (b.saver)
    return finish({
      ...base,
      status: "warn",
      top: true,
      summary: "Plugged in, Battery Saver is on",
      explanation:
        "Battery Saver limits background work and can lower performance even while plugged in.",
      impact: "Games can run slower than they need to.",
      fix: { kind: "settings", page: "power", label: "Open power settings" },
      steps: ["Turn Battery Saver off in Settings > System > Power & battery."],
    });
  return finish({
    ...base,
    status: "good",
    summary: "Plugged in",
    explanation: "The laptop is on mains power.",
    impact: "Full power limits are available.",
  });
}

function powerMode(f: HealthFacts): HealthCheck {
  const { overlay, planName } = f.powerMode;
  const base = { id: "power-mode", title: "Windows power mode" };
  const custom = planName !== null && !/^balanced$/i.test(planName.trim());
  if (custom)
    return finish({
      ...base,
      status: "good",
      summary: `Plan "${planName}" is active`,
      explanation:
        "Windows' Power mode slider only applies with the Balanced plan. A different plan is active, so the plan decides.",
      impact: "Nothing to change here; see the power plan check.",
    });
  if (overlay === "best-efficiency")
    return finish({
      ...base,
      status: "warn",
      summary: "Best power efficiency",
      explanation:
        "This mode favours battery life and low heat over speed, even on mains power.",
      impact: "Games may run slower than they could.",
      fix: { kind: "settings", page: "power", label: "Open power settings" },
      steps: [
        "Settings > System > Power & battery > Power mode: choose Best performance while gaming.",
      ],
    });
  if (overlay === "unknown")
    return finish({
      ...base,
      status: "unknown",
      summary: "Could not read the power mode",
      explanation: "Windows did not report the current power mode.",
      impact: "Unknown.",
      fix: { kind: "settings", page: "power", label: "Open power settings" },
    });
  return finish({
    ...base,
    status: overlay === "balanced" ? "good" : "good",
    summary:
      overlay === "balanced"
        ? "Balanced"
        : overlay === "gaming"
          ? "Gaming"
          : "Best performance",
    explanation:
      overlay === "balanced"
        ? "Balanced is fine for most games. Best performance can raise power limits a little on some laptops."
        : "The mode favours performance.",
    impact: "No action needed.",
  });
}

const performancePlan = /high performance|ultimate|frameforge/i;
function plan(f: HealthFacts): HealthCheck {
  const name = f.powerMode.planName;
  const base = { id: "power-plan", title: "Active power plan" };
  if (name === null)
    return finish({
      ...base,
      status: "unknown",
      summary: "Could not read the power plan",
      explanation: "Windows did not report the active plan.",
      impact: "Unknown.",
    });
  if (performancePlan.test(name))
    return finish({
      ...base,
      status: "good",
      summary: name,
      explanation:
        "A performance plan keeps the CPU from idling down mid-game.",
      impact: "No action needed.",
    });
  if (/power saver/i.test(name))
    return finish({
      ...base,
      status: "bad",
      summary: name,
      explanation: "Power saver caps CPU speed to save energy.",
      impact: "Expect lower and less steady FPS.",
      fix: {
        kind: "optimization",
        ids: ["power-plan"],
        label: "Switch to a performance plan",
      },
    });
  return finish({
    ...base,
    status: /balanced/i.test(name) ? "warn" : "unknown",
    summary: name,
    explanation: /balanced/i.test(name)
      ? "Balanced lets the CPU slow down between bursts of work, which can cause uneven frame times in CPU-limited games."
      : "A custom or vendor plan is active; Frameforge cannot tell what it does.",
    impact: /balanced/i.test(name)
      ? "Small and game-dependent. The change is reversible from Restore & backups."
      : "Unknown.",
    fix: {
      kind: "optimization",
      ids: ["power-plan"],
      label: "Use a performance plan",
    },
  });
}

const vendorAdvice = (app: string) =>
  `Open ${app} and set the performance mode (often called Performance, Turbo or Extreme) while gaming and plugged in.`;
function vendorMode(f: HealthFacts): HealthCheck {
  const base = { id: "vendor-mode", title: "Laptop performance mode" };
  if (!isLaptop(f))
    return finish({
      ...base,
      status: "good",
      summary: "Not a laptop",
      explanation: "Vendor performance modes only exist on laptops.",
      impact: "Nothing to fix.",
    });
  if (f.vendorApp)
    return finish({
      ...base,
      status: "warn",
      top: true,
      summary: `${f.vendorApp} is installed; its mode cannot be read`,
      explanation: `Laptop makers set power limits and fan speed in their own app. Quiet or Balanced modes can cut CPU and GPU power well below what the hardware allows, and Windows' settings cannot override them. Frameforge has no documented way to read or set ${f.vendorApp}'s mode.`,
      impact:
        "Can be a large factor on a laptop (the right mode can change sustained clocks a lot), but the size depends on your model and the current mode.",
      steps: [
        vendorAdvice(f.vendorApp),
        "Keep the laptop plugged in and the vents clear.",
      ],
    });
  return finish({
    ...base,
    status: "unknown",
    top: true,
    summary: "No vendor control app detected",
    explanation:
      "Many gaming laptops have a performance mode in the maker's app or with a keyboard shortcut. Frameforge could not find one running, so it cannot tell which mode is set.",
    impact: "Unknown; a low-power mode can hold a laptop back noticeably.",
    steps: [
      "Check your laptop maker's control app (or the performance-mode key) and choose its highest performance mode while gaming.",
    ],
  });
}

function gpuRouting(f: HealthFacts, ctx: HealthContext): HealthCheck {
  const base = { id: "gpu-routing", title: "Game graphics card" };
  const hybrid =
    f.gpus.some((g) => g.integrated) && f.gpus.some((g) => !g.integrated);
  if (!hybrid)
    return finish({
      ...base,
      status: "good",
      summary: f.gpus.length > 1 ? "Single usable GPU" : "One graphics card",
      explanation:
        "There is no integrated and dedicated pair that Windows has to choose between.",
      impact: "Nothing to fix.",
    });
  const withExe = ctx.games.filter((g) => g.executablePath);
  if (!withExe.length)
    return finish({
      ...base,
      status: "unknown",
      summary: "Hybrid graphics; no game with a known program to check",
      explanation:
        "This PC has an integrated and a dedicated GPU. Windows picks one per game, and a wrong pick can leave a game on the weaker one.",
      impact:
        "If a game runs on the integrated GPU the loss is typically large.",
      fix: {
        kind: "settings",
        page: "graphics",
        label: "Open graphics settings",
      },
    });
  const missing = withExe.filter((g) => {
    const p = f.gpuPreferences.find((x) => x.gameId === g.id)?.preference;
    return p !== "high-performance";
  });
  if (!missing.length)
    return finish({
      ...base,
      status: "good",
      summary: "Every library game is set to the high-performance GPU",
      explanation: "Windows is told to use the dedicated GPU for these games.",
      impact: "No action needed.",
    });
  const first = missing[0]!;
  return finish({
    ...base,
    status: "bad",
    summary: `${missing.map((g) => g.name).join(", ")}: not set to High performance (Windows decides)`,
    explanation:
      "On a laptop with an integrated and a dedicated GPU, Windows or the driver picks which one draws each game. Without an explicit choice, a game can end up on the weaker integrated GPU.",
    impact:
      "If the game lands on the integrated GPU the difference is large. If Windows already chooses the dedicated GPU, nothing changes. Frameforge sets only this one program's preference and can revert it.",
    fix: {
      kind: "launchSetting",
      gameId: first.id,
      setting: "gpuPreference",
      label: `Set ${first.name} to High performance`,
    },
    steps: missing
      .slice(1)
      .map(
        (g) => `Do the same for ${g.name} (Game library > Launch settings).`,
      ),
  });
}

const monthsOld = (iso: string | null, now: number) =>
  iso ? (now - Date.parse(iso)) / DAY / 30.4 : null;
function driver(f: HealthFacts, now: number): HealthCheck {
  const base = { id: "gpu-driver", title: "Graphics driver" };
  const dedicated = f.gpus.find((g) => !g.integrated) ?? f.gpus[0];
  if (!dedicated)
    return finish({
      ...base,
      status: "unknown",
      summary: "No graphics card reported",
      explanation: "Windows did not list a graphics adapter.",
      impact: "Unknown.",
    });
  const age = monthsOld(dedicated.driverDate, now);
  const version = f.nvidia?.driverVersion ?? dedicated.driverVersion ?? "";
  if (age === null || Number.isNaN(age))
    return finish({
      ...base,
      status: "unknown",
      summary: `${dedicated.name}${version ? `, driver ${version}` : ""}`,
      explanation: "The driver date could not be read.",
      impact: "Unknown.",
    });
  const old = age > 12;
  return finish({
    ...base,
    status: old ? "warn" : "good",
    summary: `${dedicated.name}, driver ${version} (${Math.round(age)} month${Math.round(age) === 1 ? "" : "s"} old)`,
    explanation: old
      ? "The driver is more than a year old. Newer drivers fix game-specific problems and add support for new releases."
      : "The driver is reasonably recent.",
    impact: old
      ? "Game-dependent; most older games are unaffected."
      : "No action needed.",
    steps: old
      ? [
          "Update from the graphics maker's app or site (NVIDIA App, AMD Software or Intel Driver & Support Assistant). Frameforge does not install drivers.",
        ]
      : [],
  });
}

function nvidiaProfile(f: HealthFacts): HealthCheck {
  const nv = f.gpus.some((g) => g.vendor === "nvidia");
  return finish({
    id: "nvidia-profile",
    title: "NVIDIA power and latency settings",
    status: "unknown",
    summary: nv
      ? "Not readable without the NVIDIA profile API"
      : "No NVIDIA GPU",
    explanation: nv
      ? "Power management mode and Low Latency mode live in NVIDIA's driver profile, which Frameforge does not read. Most modern games use their own in-game low-latency option instead."
      : "This check only applies to NVIDIA graphics cards.",
    impact:
      "Small. Power management 'Prefer maximum performance' mostly matters for steady clocks and costs heat and battery on laptops.",
    steps: nv
      ? [
          "NVIDIA Control Panel > Manage 3D settings > Program Settings: check Power management mode and Low Latency Mode for your game. Leave them on the default unless you have a reason.",
        ]
      : [],
  });
}

function refresh(f: HealthFacts): HealthCheck {
  const base = { id: "refresh-rate", title: "Screen refresh rate" };
  const d = f.display;
  if (!d || d.currentHz === 0)
    return finish({
      ...base,
      status: "unknown",
      summary: "Could not read the display mode",
      explanation: "Windows did not report the display mode.",
      impact: "Unknown.",
    });
  // 239.76 Hz panels report 239 or 240; a one-Hz difference is the same mode.
  const below = d.maxHz - d.currentHz > 1;
  return finish({
    ...base,
    status: below ? "bad" : "good",
    summary: `${d.currentHz} Hz of ${d.maxHz} Hz available at ${d.width}x${d.height}`,
    explanation: below
      ? "The screen is set below the fastest rate it supports, so you see fewer frames than the PC could show."
      : "The screen runs at its highest supported rate.",
    impact: below
      ? "Motion looks less smooth and input feels slower than it needs to."
      : "No action needed.",
    fix: below
      ? { kind: "settings", page: "display", label: "Open display settings" }
      : null,
    steps: below
      ? [
          "Settings > System > Display > Advanced display: choose the highest refresh rate.",
        ]
      : [],
  });
}

function hdrVrr(): HealthCheck {
  return finish({
    id: "hdr-vrr",
    title: "HDR and variable refresh rate",
    status: "unknown",
    summary: "Not readable by Frameforge",
    explanation:
      "Windows has no simple read-only way to report HDR or variable refresh rate per screen. HDR can lower SDR brightness and cost a little performance; variable refresh rate (G-SYNC or FreeSync) smooths pacing when it is on.",
    impact: "Small and display-dependent.",
    fix: { kind: "settings", page: "display", label: "Open display settings" },
    steps: [
      "Settings > System > Display > HDR: turn HDR off if you do not play HDR games.",
      "Settings > System > Display > Graphics: leave 'Variable refresh rate' on if your screen supports it.",
    ],
  });
}

function channels(f: HealthFacts): HealthCheck {
  const base = { id: "ram-channels", title: "Memory channels" };
  const n = f.memory.sticks.length;
  const slots = f.memory.slots;
  if (n === 0 || slots === null)
    return finish({
      ...base,
      status: "unknown",
      summary: "Memory layout not reported",
      explanation: "Windows did not report how many memory modules are fitted.",
      impact: "Unknown.",
    });
  if (n === 1 && slots >= 2)
    return finish({
      ...base,
      status: "bad",
      summary: `1 module in ${slots} slots: single channel`,
      explanation:
        "Two matching modules run in dual channel, which doubles the width of the path between memory and CPU. One module leaves half of it unused.",
      impact:
        "Estimate from independent testing (TechSpot, 13 games at 1080p): one 16 GB stick averaged about 12% lower FPS and about 16% lower 1% lows than two 8 GB sticks, with the biggest gaps in fast, CPU-limited games. This is an estimate for similar hardware, not a measurement of your PC.",
      steps: [
        "Add a second module with the same type and speed (for laptops, a matching SODIMM; check your model's manual).",
        "Fitting identical modules in both slots is the most reliable way to get dual channel.",
      ],
    });
  return finish({
    ...base,
    status: "good",
    summary: `${n} modules in ${slots} slots`,
    explanation:
      n >= 2
        ? "More than one module is fitted, so memory can run in dual channel."
        : "The machine has a single memory slot.",
    impact: "No action needed.",
  });
}

function ramSpeed(f: HealthFacts): HealthCheck {
  const base = { id: "ram-speed", title: "Memory speed" };
  const s = f.memory.sticks.find((x) => x.speedMTs && x.configuredMTs);
  if (!s)
    return finish({
      ...base,
      status: "unknown",
      summary: "Speed not reported",
      explanation: "Windows did not report the memory speed.",
      impact: "Unknown.",
    });
  const rated = s.speedMTs!;
  const now = s.configuredMTs!;
  if (now >= rated * 0.95)
    return finish({
      ...base,
      status: "good",
      summary: `${now} MT/s (rated ${rated})`,
      explanation: "Memory runs at its rated speed.",
      impact: "No action needed.",
    });
  if (isLaptop(f))
    return finish({
      ...base,
      status: "good",
      summary: `Running at ${now} MT/s; the module is rated ${rated}`,
      explanation:
        "On laptops the CPU or BIOS often limits memory to a lower speed than the module can reach, and the setting is normally locked. This is not something to fix.",
      impact: "Nothing you can change from Windows.",
    });
  return finish({
    ...base,
    status: "warn",
    summary: `Running at ${now} MT/s; rated ${rated}`,
    explanation:
      "Memory runs slower than the module is rated for, which usually means XMP (Intel) or EXPO (AMD) is off in the BIOS.",
    impact:
      "Vendor and press tests report modest gains, mostly in 1% lows; the size depends on the game.",
    steps: [
      "Restart into the BIOS/UEFI setup and enable XMP or EXPO. Save and exit. Revert it there if the PC becomes unstable.",
    ],
  });
}

function thermals(f: HealthFacts): HealthCheck {
  const base = { id: "thermals", title: "GPU heat and power limits" };
  const nv = f.nvidia;
  if (!nv)
    return finish({
      ...base,
      status: "unknown",
      summary: "No NVIDIA readings",
      explanation:
        "Frameforge reads GPU clocks, temperature and limits through nvidia-smi, which is not available here. CPU throttling shows up in Smart mode's game sampling instead.",
      impact: "Unknown.",
    });
  const thermal = nv.throttleReasons.filter((r) => /thermal/.test(r));
  const hot = (nv.temperatureC ?? 0) >= 85;
  const parts = [
    nv.temperatureC !== null ? `${Math.round(nv.temperatureC)} C` : null,
    nv.clockMHz !== null && nv.maxClockMHz !== null
      ? `${Math.round(nv.clockMHz)} of ${Math.round(nv.maxClockMHz)} MHz`
      : null,
    nv.throttleReasons.length
      ? `limited by ${nv.throttleReasons.join(" and ")}`
      : null,
  ].filter(Boolean);
  const status: HealthStatus =
    hot || thermal.length
      ? "warn"
      : nv.throttleReasons.length
        ? "warn"
        : "good";
  return finish({
    ...base,
    status,
    summary: parts.join(", ") || "No limits reported",
    explanation: nv.throttleReasons.length
      ? "The GPU driver reports that it is holding clocks back right now (power cap and thermal flags can also appear briefly at idle or when the driver is boosting). Check again while a game is running for a reliable reading."
      : "The GPU reports no active power or thermal limits.",
    impact: nv.throttleReasons.length
      ? "Sustained limits lower clocks and make frame rates drift down over a session."
      : "No action needed.",
    steps: nv.throttleReasons.length
      ? [
          "Keep vents clear, raise the laptop for airflow and use the maker's higher fan or performance mode.",
        ]
      : [],
  });
}

function cpuClock(f: HealthFacts): HealthCheck {
  return finish({
    id: "cpu-clock",
    title: "CPU clock speed",
    status: "unknown",
    summary:
      f.cpuPerformancePercent === null
        ? "No reading"
        : `${Math.round(f.cpuPerformancePercent)}% of base clock right now`,
    explanation:
      "A CPU slowing down is only a problem under load, and a Health Check runs while you are not gaming. Smart mode records the CPU clock during the first minute of a game and reports throttling there.",
    impact: "Judged during a real game session.",
  });
}

const driveOf = (p: string | null) => (p ? p.slice(0, 2).toUpperCase() : null);
function storage(f: HealthFacts, ctx: HealthContext): HealthCheck {
  const base = { id: "storage", title: "Disk space and type" };
  const pct = (d: HealthFacts["drives"][number]) =>
    d.totalBytes ? (d.freeBytes / d.totalBytes) * 100 : 100;
  const system = f.drives.find((d) => d.system);
  const gameDrives = new Set(
    ctx.games.map((g) => driveOf(g.executablePath)).filter(Boolean),
  );
  const tight = f.drives.filter(
    (d) => pct(d) < 15 && (d.system || gameDrives.has(d.name.toUpperCase())),
  );
  const hdd = f.drives.filter(
    (d) => d.mediaType === "hdd" && gameDrives.has(d.name.toUpperCase()),
  );
  if (!system && !tight.length)
    return finish({
      ...base,
      status: "unknown",
      summary: "Drives not reported",
      explanation: "Windows did not report drive space.",
      impact: "Unknown.",
    });
  const worst = tight.reduce((m, d) => Math.min(m, pct(d)), 100);
  const status: HealthStatus =
    worst < 10 ? "bad" : tight.length || hdd.length ? "warn" : "good";
  const lines = [
    ...tight.map(
      (d) => `${d.name} has ${gb(d.freeBytes)} free (${Math.round(pct(d))}%)`,
    ),
    ...hdd.map((d) => `${d.name} is a hard disk drive`),
  ];
  return finish({
    ...base,
    status,
    summary: lines.length
      ? lines.join("; ")
      : `${system ? `${system.name} has ${gb(system.freeBytes)} free` : "Enough free space"}`,
    explanation: tight.length
      ? "Windows needs free space on the system drive for the page file, updates and temporary files. A nearly full drive slows loading and makes stutter more likely."
      : hdd.length
        ? "Games installed on a hard disk drive load slowly and can stutter when they stream data."
        : "Free space is healthy.",
    impact: tight.length
      ? "Loading time and stutter, not average FPS. Free about 15% or more."
      : hdd.length
        ? "Mostly load times and streaming hitches."
        : "No action needed.",
    fix: tight.length
      ? { kind: "settings", page: "storage", label: "Open storage settings" }
      : null,
    steps: tight.length
      ? [
          "Move or uninstall things you do not use; Storage Sense in Settings > System > Storage can clear temporary files.",
        ]
      : hdd.length
        ? ["Move the game to an SSD if you have space on one."]
        : [],
  });
}

const stripName = (n: string) => n.replace(/\.exe$/i, "");
function ramPressure(f: HealthFacts): HealthCheck {
  const used = f.memory.usedPercent;
  const tops = f.topRam
    .filter((p) => !/^frameforge/i.test(p.name))
    .slice(0, 4)
    .map((p) => `${stripName(p.name)} ${gb(p.workingSetBytes)}`);
  const status: HealthStatus =
    used >= 90 ? "bad" : used >= 80 ? "warn" : "good";
  return finish({
    id: "ram-pressure",
    title: "Memory use right now",
    status,
    summary: `${used}% in use, ${gb(f.memory.availableBytes)} free of ${gb(f.memory.totalBytes)}${tops.length ? `. Biggest: ${tops.join(", ")}` : ""}`,
    explanation:
      status === "good"
        ? "There is room for a game."
        : "Memory is already crowded before a game starts. When it runs out Windows moves data to disk, which causes stutter and long hitches.",
    impact:
      status === "good"
        ? "No action needed."
        : "Mostly 1% lows and hitches. Closing the biggest apps before playing is a real, reversible gain.",
    fix:
      status === "good"
        ? null
        : {
            kind: "navigate",
            page: "Game Mode",
            label: "Choose apps to close while gaming",
          },
    steps:
      status === "good"
        ? []
        : ["Close browsers and chat apps you do not need while you play."],
    top: status === "bad",
  });
}

function backgroundCpu(f: HealthFacts): HealthCheck {
  const hogs = f.topCpu.filter(
    (p) => p.cpuPercent >= 8 && !/^frameforge/i.test(p.name),
  );
  const total = hogs.reduce((s, p) => s + p.cpuPercent, 0);
  const status: HealthStatus = total >= 25 ? "warn" : "good";
  return finish({
    id: "background-cpu",
    title: "Background CPU use",
    status,
    summary: hogs.length
      ? `${hogs.map((p) => `${stripName(p.name)} ${Math.round(p.cpuPercent)}%`).join(", ")} while idle`
      : "Nothing using noticeable CPU",
    explanation:
      status === "good"
        ? "The PC is quiet in the background."
        : "Programs are using a share of the CPU while you are not gaming. A CPU-limited game competes with them.",
    impact:
      status === "good"
        ? "No action needed."
        : "Matters most in CPU-limited games. Smart mode lowers these during a session and restores them afterwards.",
    fix:
      status === "good"
        ? null
        : {
            kind: "navigate",
            page: "Game Mode",
            label: "Choose apps to pause while gaming",
          },
  });
}

function gameMode(f: HealthFacts): HealthCheck {
  const base = { id: "game-mode", title: "Windows Game Mode" };
  return finish({
    ...base,
    status: f.gameMode === null ? "unknown" : "good",
    summary: f.gameMode === null ? "Not reported" : f.gameMode ? "On" : "Off",
    explanation:
      "Game Mode asks Windows to favour the game. Reported effects are small and differ between PCs, and can be negative on some. Frameforge's Smart mode never changes it.",
    impact: "Inform only.",
    fix: {
      kind: "settings",
      page: "gameMode",
      label: "Open Game Mode settings",
    },
  });
}

function hags(f: HealthFacts): HealthCheck {
  return finish({
    id: "hags",
    title: "Hardware-accelerated GPU scheduling",
    status: f.hags === null ? "unknown" : "good",
    summary:
      f.hags === 2 ? "On" : f.hags === 1 ? "Off" : "Not set / not supported",
    explanation:
      "HAGS moves some GPU scheduling onto the GPU. Measured effects are small (a few percent at best) and it is required for DLSS frame generation. Leave it as it is unless a game misbehaves.",
    impact: "Inform only.",
    fix: {
      kind: "settings",
      page: "graphics",
      label: "Open graphics settings",
    },
  });
}

function vbs(f: HealthFacts): HealthCheck {
  const on = f.vbs === true || f.hvci === true;
  return finish({
    id: "vbs",
    title: "Memory Integrity / VBS",
    status:
      f.vbs === null && f.hvci === null ? "unknown" : on ? "warn" : "good",
    summary:
      f.vbs === null && f.hvci === null
        ? "Not reported"
        : `${f.vbs ? "Virtualization-based security on" : "VBS off"}${f.hvci ? ", Memory Integrity on" : ""}`,
    explanation: on
      ? "Windows protects the kernel with virtualization. It is a security feature that can cost some CPU performance in CPU-limited games. Turning it off lowers protection, so it is your decision, not something Frameforge changes."
      : "These security features are off.",
    impact: on
      ? "One independent test (Tom's Hardware, 15 games) measured about 5-6% higher average FPS with VBS off; other tests found little difference. Treat it as a trade-off, not a free gain."
      : "No action needed.",
    fix: on
      ? {
          kind: "settings",
          page: "coreIsolation",
          label: "Open Core isolation",
        }
      : null,
    steps: on
      ? [
          "Windows Security > Device security > Core isolation details: Memory integrity. Frameforge only informs; it will not change this.",
        ]
      : [],
  });
}

function reboot(f: HealthFacts): HealthCheck {
  const real = f.pendingReboot.filter((r) => !/file replace/.test(r));
  return finish({
    id: "pending-reboot",
    title: "Restart pending",
    status: real.length ? "warn" : "good",
    summary: f.pendingReboot.length
      ? `Waiting for ${f.pendingReboot.join(" and ")}`
      : "No restart pending",
    explanation: real.length
      ? "Windows has changes that finish only after a restart. Until then installers or drivers may run in a half-updated state."
      : "Nothing is waiting for a restart.",
    impact: real.length
      ? "Can cause odd behaviour or background work."
      : "No action needed.",
    fix: real.length
      ? {
          kind: "settings",
          page: "windowsUpdate",
          label: "Open Windows Update",
        }
      : null,
    steps: real.length ? ["Save your work and restart the PC."] : [],
  });
}

function startup(f: HealthFacts): HealthCheck {
  const n = f.startupApps;
  const status: HealthStatus = n > 15 ? "bad" : n > 10 ? "warn" : "good";
  return finish({
    id: "startup-apps",
    title: "Apps that start with Windows",
    status,
    summary: `${n} enabled`,
    explanation:
      status === "good"
        ? "A modest number of startup apps."
        : "Many programs start with Windows and keep running, using memory and CPU while you play.",
    impact:
      status === "good"
        ? "No action needed."
        : "Less free memory and more background work.",
    fix:
      status === "good"
        ? null
        : { kind: "settings", page: "startup", label: "Open Startup apps" },
  });
}

function overlays(f: HealthFacts): HealthCheck {
  const list = f.overlays;
  return finish({
    id: "overlays",
    title: "Overlays and launchers running",
    status: list.length ? "warn" : "good",
    summary: list.length ? list.join(", ") : "None found",
    explanation: list.length
      ? "Overlays hook into games to show chat, FPS or recording tools. They can add small frame-time spikes. Frameforge does not close them, because you may be using them."
      : "No common overlay programs are running.",
    impact: list.length
      ? "Usually small; worth knowing about if you see stutter."
      : "No action needed.",
    steps: list.length
      ? [
          "Turn off the overlay in its own settings if you do not use it (Discord: User settings > Game overlay; Steam: Settings > In Game; NVIDIA App: Settings > In-game overlay).",
        ]
      : [],
  });
}

function abBaseline(ctx: HealthContext): HealthCheck {
  return finish({
    id: "ab-baseline",
    title: "Before/after measurement",
    status: ctx.hasAbPair ? "good" : "warn",
    summary: ctx.hasAbPair
      ? "An FPS capture with and without Game Mode exists"
      : "No before/after FPS measurement yet",
    explanation: ctx.hasAbPair
      ? "You can compare the numbers on the Monitor page."
      : "Without a capture with Game Mode off and one with it on, nobody (including Frameforge) can say what helped on this PC.",
    impact:
      "Honesty check: gains are only real if they show up in your own numbers.",
    fix: ctx.hasAbPair
      ? null
      : {
          kind: "navigate",
          page: "Monitor",
          label: "Open the Game Monitor",
        },
    steps: ctx.hasAbPair
      ? []
      : [
          "Capture the same scene a few times with Game Mode off, then a few times on, and compare average and 1% low FPS.",
        ],
  });
}

const weight: Record<HealthStatus, number> = {
  bad: 12,
  warn: 5,
  unknown: 0,
  good: 0,
};
export function evaluateHealth(
  facts: HealthFacts,
  ctx: HealthContext,
): HealthReport {
  const now = ctx.now ?? Date.now();
  const checks = [
    power(facts),
    powerMode(facts),
    plan(facts),
    vendorMode(facts),
    gpuRouting(facts, ctx),
    driver(facts, now),
    nvidiaProfile(facts),
    refresh(facts),
    hdrVrr(),
    channels(facts),
    ramSpeed(facts),
    thermals(facts),
    cpuClock(facts),
    storage(facts, ctx),
    ramPressure(facts),
    backgroundCpu(facts),
    gameMode(facts),
    hags(facts),
    vbs(facts),
    reboot(facts),
    startup(facts),
    overlays(facts),
    abBaseline(ctx),
  ];
  const penalty = checks.reduce(
    (sum, c) => sum + weight[c.status] + (c.top && c.status === "bad" ? 6 : 0),
    0,
  );
  const score = Math.max(0, Math.min(100, 100 - penalty));
  const rank = (c: HealthCheck) =>
    (c.status === "bad" ? 2 : c.status === "warn" ? 1 : 0) * 10 +
    (c.top ? 5 : 0);
  const ranked = checks
    .filter((c) => c.status === "bad" || c.status === "warn")
    .sort((a, b) => rank(b) - rank(a));
  const topIssues = ranked.slice(0, 3).map((c) => c.id);
  const bad = checks.filter((c) => c.status === "bad").length;
  const warn = checks.filter((c) => c.status === "warn").length;
  return {
    at: new Date(now).toISOString(),
    score,
    headline:
      bad + warn === 0
        ? "Nothing needs attention."
        : `${bad} to fix, ${warn} to look at.`,
    checks,
    topIssues,
  };
}
