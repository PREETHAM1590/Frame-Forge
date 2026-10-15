import { useState } from "react";
import {
  ArrowUpRight,
  ShieldAlert,
  Check,
  Plus,
  Trash2,
  Pencil,
  RotateCw,
} from "lucide-react";
import {
  catalogue,
  categories,
  presetNameTaken,
  presets,
  restartText,
  type Category,
  type Optimization,
} from "../../shared/catalogue";
import type { OperationId } from "../../shared/contracts";
import {
  PageTitle,
  Badge,
  Button,
  Modal,
  Empty,
  Panel,
  Chips,
  SearchField,
} from "../components/ui";
import { PowerPlanDialog } from "../components/PowerPlanDialog";
import type { ViewProps } from "../types";
// The helper runs but a per-PC prerequisite (e.g. the High performance plan) is missing.
const missingHere = (data: ViewProps["data"]) =>
  data.mode === "desktop" && data.capabilities.length > 0;
const settingsLabels = {
  graphics: "Graphics settings",
  startup: "Startup apps",
  network: "Network status",
  services: "Services",
  defender: "Windows Security (Tamper Protection)",
  power: "Power & battery",
  display: "Display",
  windowsUpdate: "Windows Update",
  storage: "Storage",
  gameMode: "Game Mode",
  coreIsolation: "Core isolation (Windows Security)",
} as const;
export function Optimizations({ data, preview, run, pending }: ViewProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState<"All" | Category>("All");
  const [availability, setAvailability] = useState("All");
  const [risk, setRisk] = useState("All");
  const [tier, setTier] = useState("All");
  const [detail, setDetail] = useState<Optimization | null>(null);
  const [planDialog, setPlanDialog] = useState(false);
  // The High performance plan is the one missing prerequisite the app can create safely, with consent, right here.
  const planMissing = (id: string) =>
    id === "power-plan" && missingHere(data) && !data.capabilities.includes(id);
  const [restarting, setRestarting] = useState(false);
  const needle = search.toLowerCase();
  const list = catalogue.filter(
    (o) =>
      (category === "All" || o.category === category) &&
      (risk === "All" || o.risk === risk) &&
      (tier === "All" || o.tier === tier) &&
      (availability === "All" ||
        (availability === "Available"
          ? data.capabilities.includes(o.id)
          : !data.capabilities.includes(o.id))) &&
      `${o.name} ${o.description} ${o.impact}`.toLowerCase().includes(needle),
  );
  const shown = categories.filter((c) => list.some((o) => o.category === c));
  const card = (o: Optimization) => (
    <article className="optimization opt-row" key={o.id}>
      <div className="opt-main">
        <h2>{o.name}</h2>
        <p className="muted">{o.description}</p>
        <span className="badge-row opt-tags">
          <Badge
            tone={
              o.risk === "Low" ? "lime" : o.risk === "High" ? "red" : "amber"
            }
          >
            {o.risk} risk
          </Badge>
          <Badge tone={data.capabilities.includes(o.id) ? "cyan" : "neutral"}>
            {data.capabilities.includes(o.id)
              ? "Available"
              : o.supported
                ? missingHere(data)
                  ? "Not available on this PC"
                  : "Desktop helper required"
                : "Review only"}
          </Badge>
          {o.restart !== "none" && <Badge tone="amber">Restart needed</Badge>}
          {o.tier === "advanced" && <Badge tone="amber">Advanced</Badge>}
          {o.tier === "security" && <Badge tone="red">Lowers security</Badge>}
          {o.admin && <Badge tone="neutral">Administrator</Badge>}
        </span>
      </div>
      <span className="opt-actions">
        {planMissing(o.id) && (
          <Button
            disabled={pending}
            onClick={() => setPlanDialog(true)}
            title="Create a copy of Windows' High performance plan, with your consent."
          >
            <Plus size={16} /> Create plan…
          </Button>
        )}
        <Button
          aria-label={`Details for ${o.name}`}
          onClick={() => setDetail(o)}
        >
          Details
          <ArrowUpRight size={16} />
        </Button>
      </span>
    </article>
  );
  return (
    <>
      <PageTitle
        title="Optimizations"
        subtitle="Small Windows tweaks for gaming. Open one to see what it changes and how to undo it."
      />
      <div className="lib-toolbar">
        <SearchField
          label="Search optimizations"
          placeholder="Search optimizations"
          value={search}
          onChange={setSearch}
        />
        <Chips
          label="Risk"
          value={risk}
          onChange={setRisk}
          options={[
            { id: "All", label: "All risks" },
            { id: "Low", label: "Low" },
            { id: "Moderate", label: "Moderate" },
            { id: "High", label: "High" },
          ]}
        />
        <select
          aria-label="Availability"
          value={availability}
          onChange={(e) => setAvailability(e.target.value)}
        >
          <option>All</option>
          <option>Available</option>
          <option>Unavailable</option>
        </select>
        <select
          aria-label="Level"
          value={tier}
          onChange={(e) => setTier(e.target.value)}
        >
          <option value="All">All levels</option>
          <option value="standard">Standard</option>
          <option value="advanced">Advanced</option>
          <option value="security">Security trade-offs</option>
        </select>
      </div>
      <div className="tabs" aria-label="Optimization categories">
        {["All", ...categories].map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            className={category === c ? "active" : ""}
            onClick={() => setCategory(c as "All" | Category)}
          >
            {c}
          </button>
        ))}
      </div>
      {shown.map((c) => {
        const body = (
          <>
            {category === "All" && <h2 className="group-title">{c}</h2>}
            {c === "Security trade-offs" && (
              <p className="notice">
                <ShieldAlert size={18} />
                These lower your PC&apos;s security. They are off by default,
                are never part of a preset, and each one needs a typed
                confirmation.
              </p>
            )}
            <div className="catalogue-grid">
              {list.filter((o) => o.category === c).map(card)}
            </div>
          </>
        );
        return c === "Security trade-offs" ? (
          <Panel tone="danger" key={c} aria-label={c} className="opt-security">
            {body}
          </Panel>
        ) : (
          <section key={c} aria-label={c}>
            {body}
          </section>
        );
      })}
      <p className="opt-foot muted">
        Some changes say "Restart Windows Explorer".
        <Button
          disabled={pending || data.mode === "demo"}
          title={
            data.mode === "demo"
              ? "Restarting Explorer requires the desktop app."
              : "Use after changes marked 'Restart Windows Explorer'."
          }
          onClick={() => setRestarting(true)}
        >
          <RotateCw size={17} />
          Restart Explorer
        </Button>
      </p>
      {!list.length && (
        <Empty
          title="No matching optimizations"
          description="Try another search or filter."
        />
      )}
      {planDialog && (
        <PowerPlanDialog
          run={run}
          pending={pending}
          onClose={() => setPlanDialog(false)}
        />
      )}
      {restarting && (
        <Modal
          title="Restart Windows Explorer?"
          description="The taskbar and open File Explorer windows close for a moment and Windows starts them again. Unsaved file operations in Explorer may be interrupted."
          onClose={() => setRestarting(false)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setRestarting(false)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={pending}
              onClick={async () => {
                if (
                  await run(
                    "restartExplorer",
                    { confirmed: true },
                    "Windows Explorer restarted.",
                  )
                )
                  setRestarting(false);
              }}
            >
              Restart Explorer
            </Button>
          </div>
        </Modal>
      )}
      {detail && (
        <Modal
          title={detail.name}
          description={detail.description}
          onClose={() => setDetail(null)}
          variant="drawer"
        >
          <div className="dialog-section">
            <Badge
              tone={
                detail.risk === "Low"
                  ? "lime"
                  : detail.risk === "High"
                    ? "red"
                    : "amber"
              }
            >
              {detail.risk} risk
            </Badge>
            {detail.tier === "advanced" && <Badge tone="amber">Advanced</Badge>}
            {detail.admin && (
              <p className="muted">
                Needs a Windows administrator prompt. Frameforge asks only for
                the machine settings listed below.
              </p>
            )}
            {detail.consequence && (
              <p className="notice" role="note">
                <ShieldAlert size={18} />
                {detail.consequence}
              </p>
            )}
            <h3>Why review this?</h3>
            <p>{detail.reason}</p>
            <h3>Affected settings</h3>
            {detail.settings.map((s) => (
              <code className="setting-path" key={s}>
                {s}
              </code>
            ))}
            <h3>Prerequisites</h3>
            <ul>
              {detail.prerequisites.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
            <h3>After applying</h3>
            <p>{restartText[detail.restart]}</p>
            <h3>Recovery</h3>
            <p>{detail.rollback}</p>
          </div>
          {!data.capabilities.includes(detail.id) && (
            <div className="notice">
              <ShieldAlert size={18} />
              <div>
                {!detail.supported
                  ? `This is a review-only entry: Frameforge never changes it, so there is nothing to apply. ${detail.settingsPage ? "Use the button below to look at it in Windows yourself." : "Windows or the vendor owns this setting."}`
                  : missingHere(data)
                    ? "A prerequisite is not met on this PC. See Prerequisites above."
                    : "Windows operations require the desktop app and its published helper."}
                {planMissing(detail.id) && (
                  <>
                    {" "}
                    <Button
                      disabled={pending}
                      onClick={() => setPlanDialog(true)}
                    >
                      <Plus size={16} /> Create High performance plan…
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setDetail(null)}>Close</Button>
            {detail.settingsPage && (
              <Button
                disabled={pending || data.mode === "demo"}
                title={
                  data.mode === "demo"
                    ? "Opening Windows Settings requires the desktop app."
                    : undefined
                }
                onClick={() =>
                  void run("openSettings", { page: detail.settingsPage! })
                }
              >
                Open {settingsLabels[detail.settingsPage]} in Windows
                <ArrowUpRight size={17} />
              </Button>
            )}
            <Button
              variant={detail.tier === "security" ? "danger" : "primary"}
              disabled={!data.capabilities.includes(detail.id)}
              onClick={() => {
                setDetail(null);
                preview([detail.id]);
              }}
            >
              {detail.tier === "security"
                ? "Review security trade-off"
                : "Preview changes"}
              <ArrowUpRight size={17} />
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}
export function Presets({ data, preview, run, pending }: ViewProps) {
  const [planDialog, setPlanDialog] = useState(false);
  // `editing` is the saved preset's id, or "new" for a fresh one; null when the builder is closed.
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [ids, setIds] = useState<OperationId[]>([]);
  const openBuilder = (preset?: {
    id: string;
    name: string;
    ids: OperationId[];
  }) => {
    setName(preset?.name ?? "");
    setIds(preset ? [...preset.ids] : []);
    setEditing(preset?.id ?? "new");
  };
  const clash =
    editing !== null &&
    !!name.trim() &&
    presetNameTaken(
      data.state.presets,
      name,
      editing === "new" ? undefined : editing,
    );
  const all = [
    ...presets.map((p) => ({
      id: p.name,
      name: p.name,
      description: p.description,
      ids: [...p.ids] as OperationId[],
      custom: false,
    })),
    ...data.state.presets.map((p) => ({
      ...p,
      description: "Your saved selection of preferences.",
      custom: true,
    })),
  ];
  return (
    <>
      <PageTitle
        title="Presets"
        subtitle="A starting point for your setup. Review every change before applying."
        action={
          <Button onClick={() => openBuilder()}>
            <Plus size={17} />
            Custom preset
          </Button>
        }
      />
      <div className="preset-list stagger">
        {all.map((p) => (
          <article key={p.id}>
            <div>
              <h2>{p.name}</h2>
              <p className="muted">{p.description}</p>
              <div className="preset-items">
                {p.ids.map((id) => (
                  <span key={id}>
                    <Check size={13} />
                    {catalogue.find((o) => o.id === id)?.name}
                  </span>
                ))}
              </div>
            </div>
            <div className="preset-controls">
              {p.custom && (
                <>
                  <button
                    className="icon-button"
                    title="Edit preset"
                    aria-label={`Edit ${p.name}`}
                    disabled={pending}
                    onClick={() => openBuilder(p)}
                  >
                    <Pencil size={17} />
                  </button>
                  <button
                    className="icon-button"
                    title="Remove preset"
                    aria-label={`Remove ${p.name}`}
                    disabled={pending}
                    onClick={() => setRemoving({ id: p.id, name: p.name })}
                  >
                    <Trash2 size={17} />
                  </button>
                </>
              )}
              {missingHere(data) &&
                p.ids.some((id) => !data.capabilities.includes(id)) && (
                  <span className="muted">
                    Skipped — not available on this PC:{" "}
                    {p.ids
                      .filter((id) => !data.capabilities.includes(id))
                      .map((id) => catalogue.find((o) => o.id === id)?.name)
                      .join(", ")}
                    .{" "}
                    {p.ids.includes("power-plan") &&
                      !data.capabilities.includes("power-plan") && (
                        <Button
                          disabled={pending}
                          onClick={() => setPlanDialog(true)}
                        >
                          <Plus size={16} /> Create High performance plan…
                        </Button>
                      )}
                  </span>
                )}
              <Button
                variant={p.name === "Recommended" ? "primary" : "secondary"}
                disabled={
                  pending ||
                  (missingHere(data) &&
                    p.ids.every((id) => !data.capabilities.includes(id)))
                }
                onClick={() => preview(p.ids)}
              >
                Review preset
                <ArrowUpRight size={17} />
              </Button>
            </div>
          </article>
        ))}
      </div>
      {planDialog && (
        <PowerPlanDialog
          run={run}
          pending={pending}
          onClose={() => setPlanDialog(false)}
        />
      )}
      {removing && (
        <Modal
          title={`Delete "${removing.name}"?`}
          description="This removes the saved preset from Frameforge. It does not change Windows."
          onClose={() => setRemoving(null)}
        >
          <div className="dialog-actions">
            <Button onClick={() => setRemoving(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={pending}
              onClick={async () => {
                if (
                  await run(
                    "removePreset",
                    { id: removing.id },
                    "Preset removed.",
                  )
                )
                  setRemoving(null);
              }}
            >
              Delete preset
            </Button>
          </div>
        </Modal>
      )}
      {editing !== null && (
        <Modal
          title={editing === "new" ? "Custom preset" : "Edit custom preset"}
          description={
            editing === "new"
              ? "Save a selection. Creating a preset does not change Windows."
              : "Change the name or items. Saving updates this preset and does not change Windows."
          }
          onClose={() => setEditing(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await run(
                "savePreset",
                editing === "new"
                  ? { name: name.trim(), ids }
                  : { id: editing, name: name.trim(), ids },
                "Preset saved.",
              );
              if (result) {
                setEditing(null);
                setName("");
                setIds([]);
              }
            }}
          >
            <label className="field">
              Preset name
              <input
                autoFocus
                value={name}
                maxLength={80}
                required
                aria-invalid={clash}
                aria-describedby={clash ? "preset-name-error" : undefined}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            {clash && (
              <p className="muted" id="preset-name-error" role="alert">
                A preset named &quot;{name.trim()}&quot; already exists. Choose
                a different name.
              </p>
            )}
            <div className="check-list">
              {catalogue
                .filter((o) => o.supported && o.tier !== "security")
                .map((o) => (
                  <label key={o.id}>
                    <input
                      type="checkbox"
                      checked={ids.includes(o.id)}
                      onChange={(e) =>
                        setIds(
                          e.target.checked
                            ? [...ids, o.id]
                            : ids.filter((id) => id !== o.id),
                        )
                      }
                    />
                    <span>{o.name}</span>
                    <Badge tone="neutral">{o.risk} risk</Badge>
                  </label>
                ))}
            </div>
            <div className="dialog-actions">
              <Button type="button" onClick={() => setEditing(null)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending || !ids.length || !name.trim() || clash}
                type="submit"
              >
                Save preset
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </>
  );
}
