import { Panel } from "../../components/ui";

const steps = [
  "Frameforge saves the current Windows values first.",
  "The chosen mode changes only the game and the apps you picked.",
  "When the game exits, everything reversible is put back.",
];

export function HowItWorks() {
  return (
    <Panel tone="accent" aria-label="How it works">
      <h2 className="gm-how-title">How it works</h2>
      <p className="muted">
        Game Mode adjusts system resources while a game runs. Pick the mode that
        fits how you play.
      </p>
      <ol className="gm-steps-list">
        {steps.map((s, i) => (
          <li key={s}>
            <span className="num" aria-hidden="true">
              {String(i + 1).padStart(2, "0")}
            </span>
            {s}
          </li>
        ))}
      </ol>
    </Panel>
  );
}
