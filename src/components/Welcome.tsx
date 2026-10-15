import { useEffect, useRef, useState } from "react";
import { Flame } from "lucide-react";
import { Button, Toggle } from "./ui";
import { useUpdate } from "../useUpdate";

export interface WelcomeChoices {
  updateCheck: boolean;
  analytics: boolean;
  keepRunning: boolean;
}
const steps = ["Welcome", "Privacy and updates", "Background"] as const;
const shared: readonly string[] = [
  "App start: Frameforge version and Windows build number",
  "Game Mode: which mode you started (balanced, performance, competitive, custom)",
  "Optimizations and presets: the id or name of a built-in one you applied",
  "Updates: the new version after an update is installed",
  "Pages: which Frameforge page you opened",
];

/** First-run flow, shown once in place of the app: what it is, privacy and updates, running in the background. */
export function Welcome({
  keepRunning,
  busy,
  onFinish,
}: {
  keepRunning: boolean;
  busy: boolean;
  onFinish: (choices: WelcomeChoices) => void;
}) {
  const analyticsAvailable = useUpdate().status?.analyticsAvailable === true;
  const [step, setStep] = useState(0);
  const [updateCheck, setUpdateCheck] = useState(true);
  const [analytics, setAnalytics] = useState(false);
  const [background, setBackground] = useState(keepRunning);
  const heading = useRef<HTMLHeadingElement>(null);
  // Each step moves focus to its heading so keyboard and screen reader users start at the top of the new content.
  useEffect(() => heading.current?.focus(), [step]);
  const last = step === steps.length - 1;
  return (
    <main className="welcome" aria-labelledby="welcome-title">
      <div className="welcome-card">
        <div className="welcome-brand">
          <Flame size={22} aria-hidden="true" />
          <span>Frameforge</span>
          <span className="welcome-count">
            Step {step + 1} of {steps.length}: {steps[step]}
          </span>
        </div>
        <div className="welcome-step" key={step}>
          {step === 0 && (
            <>
              <h1 id="welcome-title" tabIndex={-1} ref={heading}>
                Welcome to Frameforge
              </h1>
              <p className="welcome-lead">
                Frameforge tunes Windows for gaming. Every change is previewed
                first and can be undone.
              </p>
              <p className="muted">Runs on this PC. No account.</p>
            </>
          )}
          {step === 1 && (
            <>
              <h1 id="welcome-title" tabIndex={-1} ref={heading}>
                Privacy and updates
              </h1>
              <p className="muted">
                Both are your choice and can be changed later in Settings.
              </p>
              <Toggle
                label="Check for updates automatically"
                description="Contacts github.com only, at start and every 6 hours. Nothing is downloaded or installed until you choose."
                checked={updateCheck}
                onChange={setUpdateCheck}
              />
              <Toggle
                label="Share anonymous usage statistics"
                description={
                  analyticsAvailable
                    ? "Off unless you turn it on. No game names, file paths, or user or PC names."
                    : "Not available in this build."
                }
                checked={analyticsAvailable && analytics}
                disabled={!analyticsAvailable}
                onChange={setAnalytics}
              />
              <details className="welcome-shared">
                <summary>What&apos;s shared</summary>
                <p className="muted">
                  Only if you turn statistics on, and only these:
                </p>
                <ul>
                  {shared.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
                <p className="muted">
                  Aptabase receives them without cookies, a device id, or your
                  IP address. The full policy is docs/PRIVACY.md in the
                  Frameforge repository.
                </p>
              </details>
            </>
          )}
          {step === 2 && (
            <>
              <h1 id="welcome-title" tabIndex={-1} ref={heading}>
                Run in the background?
              </h1>
              <p className="muted">
                Auto-boost can only start when you launch a game if Frameforge
                is running.
              </p>
              <Toggle
                label="Keep Frameforge in the tray when I close the window"
                description="Uses a few MB of memory. Quit any time from the tray icon."
                checked={background}
                onChange={setBackground}
              />
            </>
          )}
        </div>
        <div className="welcome-actions">
          {step > 0 && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
          )}
          <Button
            variant="primary"
            disabled={busy}
            onClick={() =>
              last
                ? onFinish({
                    updateCheck,
                    analytics: analyticsAvailable && analytics,
                    keepRunning: background,
                  })
                : setStep(step + 1)
            }
          >
            {last ? "Get started" : "Continue"}
          </Button>
        </div>
      </div>
    </main>
  );
}
