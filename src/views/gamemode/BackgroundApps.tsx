import { useState } from "react";
import { ListRestart, Plus, Trash2 } from "lucide-react";
import { Badge, Button } from "../../components/ui";
import type {
  BoostMode,
  BoosterConfig,
  CustomMechanisms,
  RunningProcess,
} from "../../../shared/contracts";
import type { ViewProps } from "../../types";
import { neverSuggest, suggestions } from "./model";

export function BackgroundApps({
  config,
  mechanisms,
  modeName,
  save,
  run,
  pending,
  unavailable,
}: {
  config: BoosterConfig;
  mechanisms: CustomMechanisms;
  modeName: (id: BoostMode) => string;
  save: (next: Partial<BoosterConfig>) => Promise<unknown>;
  run: ViewProps["run"];
  pending: boolean;
  unavailable: string;
}) {
  const [processes, setProcesses] = useState<RunningProcess[] | null>(null);
  const [pick, setPick] = useState("");
  const [pickAction, setPickAction] = useState<"lower" | "suspend" | "close">(
    "lower",
  );
  const suggested = processes
    ? [
        ...new Map(
          processes
            .filter(
              (p) =>
                !p.protected &&
                /^[\w .()-]{1,64}\.exe$/i.test(p.image) &&
                !neverSuggest.test(p.image) &&
                !config.background.some(
                  (b) => b.image.toLowerCase() === p.image.toLowerCase(),
                ),
            )
            .map((p) => [p.image.toLowerCase(), p.image]),
        ).values(),
      ]
        .flatMap((image) => {
          const match = suggestions.find(([pattern]) => pattern.test(image));
          return match ? [{ image, action: match[1], kind: match[2] }] : [];
        })
        .slice(0, 12)
    : [];
  return (
    <section className="gm-sub" aria-label="Background apps">
      <p className="muted">
        Apps in your own session only. System, security and anti-cheat processes
        are protected and cannot be selected.
      </p>
      <ul className="mechanism-list">
        {config.background.map((entry, index) => (
          <li key={entry.image}>
            <span>{entry.image}</span>
            {mechanisms[
              entry.action === "lower"
                ? "lowerBackground"
                : entry.action === "suspend"
                  ? "suspendBackground"
                  : "closeBackground"
            ] ? (
              <Badge tone="lime">applies in {modeName(config.mode)}</Badge>
            ) : (
              <Badge tone="amber">not part of {modeName(config.mode)}</Badge>
            )}
            <select
              aria-label={`Action for ${entry.image}`}
              value={entry.action}
              disabled={pending}
              onChange={(e) =>
                void save({
                  background: config.background.map((b, i) =>
                    i === index
                      ? { ...b, action: e.target.value as typeof b.action }
                      : b,
                  ),
                })
              }
            >
              <option value="lower">Lower priority</option>
              <option value="suspend">Suspend</option>
              <option value="close">Close (not reopened)</option>
            </select>
            <button
              className="icon-button"
              aria-label={`Remove ${entry.image}`}
              title={`Remove ${entry.image}`}
              disabled={pending}
              onClick={() =>
                void save({
                  background: config.background.filter((_, i) => i !== index),
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </li>
        ))}
      </ul>
      <div className="toolbar">
        <Button
          disabled={pending || !!unavailable}
          title={unavailable || "Read the apps running in your session."}
          onClick={async () => {
            const found = await run("runningProcesses", {});
            if (found) setProcesses(found);
          }}
        >
          <ListRestart size={17} /> Load running apps
        </Button>
        {processes && (
          <>
            {suggested.length > 0 && (
              <div className="booster-chips" aria-label="Suggested apps">
                {suggested.map(({ image, action, kind }) => (
                  <Button
                    key={image}
                    disabled={pending || config.background.length >= 50}
                    title={
                      config.background.length >= 50
                        ? "The list is full (50 apps). Remove one first."
                        : `Suggested ${kind}: ${action === "lower" ? "lower its priority" : "suspend it"} during a boost.`
                    }
                    onClick={() =>
                      void save({
                        background: [...config.background, { image, action }],
                      })
                    }
                  >
                    <Plus size={15} /> {image} ({kind})
                  </Button>
                ))}
              </div>
            )}
            <select
              aria-label="Running app"
              value={pick}
              onChange={(e) => setPick(e.target.value)}
            >
              <option value="">Choose an app</option>
              {[
                ...new Map(
                  processes.map((p) => [p.image.toLowerCase(), p]),
                ).values(),
              ]
                .filter(
                  (p) =>
                    /^[\w .()-]{1,64}\.exe$/i.test(p.image) &&
                    !config.background.some(
                      (b) => b.image.toLowerCase() === p.image.toLowerCase(),
                    ),
                )
                .map((p) => (
                  <option key={p.image} value={p.image} disabled={p.protected}>
                    {p.image}
                    {p.protected ? " (protected)" : ""}
                  </option>
                ))}
            </select>
            <select
              aria-label="Action"
              value={pickAction}
              onChange={(e) =>
                setPickAction(e.target.value as typeof pickAction)
              }
            >
              <option value="lower">Lower priority</option>
              <option value="suspend">Suspend</option>
              <option value="close">Close (not reopened)</option>
            </select>
            <Button
              disabled={pending || !pick || config.background.length >= 50}
              title={
                config.background.length >= 50
                  ? "The list is full (50 apps). Remove one first."
                  : !pick
                    ? "Choose an app first."
                    : undefined
              }
              onClick={async () => {
                if (
                  await save({
                    background: [
                      ...config.background,
                      { image: pick, action: pickAction },
                    ],
                  })
                )
                  setPick("");
              }}
            >
              <Plus size={17} /> Add
            </Button>
          </>
        )}
      </div>
    </section>
  );
}
