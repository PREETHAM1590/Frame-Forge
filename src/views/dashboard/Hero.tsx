import { ShieldCheck, SlidersHorizontal } from "lucide-react";
import { Badge, CellGrid } from "../../components/ui";
import type { Tone } from "../../components/ui";

export type DashboardState = "nominal" | "boost" | "attention";
const headline: Record<DashboardState, string> = {
  nominal: "System equilibrium: nominal",
  boost: "Boost engaged",
  attention: "Review advised",
};
const lead: Record<DashboardState, string> = {
  nominal:
    "Nothing needs your attention. Every change Frameforge makes is previewed, saved and reversible.",
  boost:
    "A game is running with Game Mode applied. Everything it changed is restored when the game closes.",
  attention:
    "Something on this PC differs from what Frameforge expects. Review the notes below.",
};

export function Hero({
  state,
  modeLabel,
  autoBoost,
  source,
  sourceTone,
}: {
  state: DashboardState;
  modeLabel: string;
  autoBoost: boolean;
  source: string;
  sourceTone: Tone;
}) {
  return (
    <CellGrid columns="minmax(0, 1fr) auto" className="hero" stagger>
      <div className="hero-copy">
        <div className="eyebrow">Your setup, in focus.</div>
        <h1>{headline[state]}</h1>
        <p>{lead[state]}</p>
      </div>
      <div className="hero-chips alt">
        <div className="chip">
          <SlidersHorizontal size={18} />
          <div>
            <span className="label">Game Mode</span>
            <strong>
              {modeLabel}
              {autoBoost ? " / auto-boost" : ""}
            </strong>
          </div>
        </div>
        <div className="chip">
          <ShieldCheck size={18} />
          <div>
            <span className="label">Readings</span>
            <Badge tone={sourceTone}>{source}</Badge>
          </div>
        </div>
      </div>
    </CellGrid>
  );
}
