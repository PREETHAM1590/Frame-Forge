import { useState } from "react";
import { Copy, ExternalLink, ShieldCheck } from "lucide-react";
import { Badge, Button, Panel } from "../../components/ui";
import type { Game, Hardware } from "../../../shared/contracts";
import {
  adviseGame,
  gameSettingsVersion,
  profileHardware,
  toChecklist,
  type Impact,
} from "../../../shared/gameSettings";
import { useSmart } from "../../useSmart";

const impactTone = { high: "lime", medium: "cyan", low: "neutral" } as const;
const impactLabel: Record<Impact, string> = {
  high: "High impact",
  medium: "Medium impact",
  low: "Low impact",
};
const tierLabel = {
  cpu: "CPU-limited",
  gpu: "GPU-limited",
  vram: "low video memory",
  laptop: "laptop",
} as const;

export function RecommendedSettings({
  game,
  hardware,
}: {
  game: Game;
  hardware: Hardware;
}) {
  const [copied, setCopied] = useState(false);
  // Loads what Smart mode learned and re-renders when it changes; the guide reads it through getBottleneck.
  useSmart();
  const profile = profileHardware(hardware);
  const advice = adviseGame(game, hardware);
  const pc = [
    profile.gpuName || "Unknown GPU",
    profile.vramGb ? `${profile.vramGb} GB video memory` : null,
    `${profile.cpuThreads} CPU threads`,
    `${profile.ramGb} GB RAM`,
    profile.refreshHz ? `${profile.refreshHz} Hz display` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <div className="recommended">
      <p className="muted">
        Tailored to this PC: {pc}. Treated as{" "}
        {advice.tiers.map((t) => tierLabel[t]).join(", ")}
        {advice.bottleneck ? " (measured)" : " (estimated)"}.
      </p>
      <Panel tone="accent">
        <ShieldCheck size={18} />
        <p>
          Guidance only. Frameforge never edits {game.name}&apos;s files. Change
          these in the game&apos;s own menu.
          {advice.entry && advice.entry.antiCheat !== "none"
            ? ` ${advice.entry.antiCheat} anti-cheat is active for this game.`
            : ""}
        </p>
      </Panel>
      {!advice.entry && (
        <p className="notice">
          No curated entry for this game yet, so this is general advice.
        </p>
      )}
      {advice.entry && (
        <p className="muted">
          {advice.entry.engine} · {advice.entry.api} ·{" "}
          {advice.entry.goal === "competitive"
            ? "Competitive: favour low latency"
            : "Quality: favour visuals"}
        </p>
      )}
      <ul className="rec-list">
        {advice.settings.map((s) => (
          <li key={s.key}>
            <div>
              <strong>{s.label}</strong>: {s.value}{" "}
              <Badge tone={impactTone[s.impact]}>{impactLabel[s.impact]}</Badge>
              <p className="muted">Why: {s.why}</p>
            </div>
            <a href={s.source} target="_blank" rel="noreferrer">
              Source <ExternalLink size={12} />
            </a>
          </li>
        ))}
      </ul>
      <h3>Frame rate cap</h3>
      <p>{advice.frameCap.text}</p>
      <p className="muted">{advice.frameCap.where}</p>
      <h3>Latency</h3>
      <p>{advice.reflex}</p>
      <p>{advice.frameGen}</p>
      {advice.upscalers.length > 0 && (
        <p className="muted">
          Upscalers available: {advice.upscalers.join(", ")}
        </p>
      )}
      {advice.notes.map((n) => (
        <p key={n} className="muted">
          {n}
        </p>
      ))}
      <p className="muted">
        Guide-based (evidence grade C), so impact is qualitative. Database v
        {gameSettingsVersion}
        {advice.entry ? `, last verified ${advice.entry.lastVerified}` : ""}.
      </p>
      <Button
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(toChecklist(game.name, advice));
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        <Copy size={16} />
        Copy as checklist
      </Button>
      {copied && <span role="status"> Copied.</span>}
    </div>
  );
}
