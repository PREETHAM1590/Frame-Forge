import { useState } from "react";
import {
  Search,
  ArrowUpRight,
  SlidersHorizontal,
  ShieldAlert,
  Check,
  Plus,
  Trash2,
  Pencil,
} from "lucide-react";
import {
  catalogue,
  presetNameTaken,
  presets,
  type Optimization,
} from "../../shared/catalogue";
import type { OperationId } from "../../shared/contracts";
import { PageTitle, Badge, Button, Modal, Empty } from "../components/ui";
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
} as const;
export function Optimizations({
  data,
  preview,
  run,
  navigate,
  pending,
}: ViewProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [availability, setAvailability] = useState("All");
  const [detail, setDetail] = useState<Optimization | null>(null);
  const [planDialog, setPlanDialog] = useState(false);
  // The High performance plan is the one missing prerequisite the app can create safely, with consent, right here.
  const planMissing = (id: string) =>
    id === "power-plan" && missingHere(data) && !data.capabilities.includes(id);
  const list = catalogue.filter(
    (o) =>
      (category === "All" || o.category === category) &&
      (availability === "All" ||
        (availability === "Available"
          ? data.capabilities.includes(o.id)
          : !data.capabilities.includes(o.id))) &&
      `${o.name} ${o.description}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <>
      <PageTitle
        title="Optimizations"
        subtitle="Understand the setting before you change it."
      />
      <div className="toolbar">
        <div className="search">
          <Search size={18} />
          <input
            aria-label="Search optimizations"
            placeholder="Search optimizations"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label="Availability"
          value={availability}
          onChange={(e) => setAvailability(e.target.value)}
        >
          <option>All</option>
          <option>Available</option>
          <option>Unavailable</option>
        </select>
      </div>
      <div className="tabs" aria-label="Optimization categories">
        {["All", "Input", "Capture", "System", "Network"].map((c) => (
          <button
            key={c}
            aria-pressed={category === c}
            className={category === c ? "active" : ""}
            onClick={() => setCategory(c)}
          >
            {c}
          </button>
        ))}
      </div>
      <div className="catalogue-grid">
        {list.map((o) => (
          <article className="optimization" key={o.id}>
            <div className="card-top">
              <span
                className={`action-icon ${o.supported ? "lime" : "neutral"}`}
              >
                <SlidersHorizontal size={21} />
              </span>
              <Badge
                tone={
                  o.risk === "Low"
                    ? "lime"
                    : o.risk === "High"
                      ? "red"
                      : "amber"
                }
              >
                {o.risk} risk
              </Badge>
            </div>
            <span className="muted category">
              {o.category} / {o.impact}
            </span>
            <h2>{o.name}</h2>
            <p className="muted">{o.description}</p>
            <div className="card-bottom">
              <Badge
                tone={data.capabilities.includes(o.id) ? "cyan" : "neutral"}
              >
                {data.capabilities.includes(o.id)
                  ? "Available"
                  : o.supported
                    ? missingHere(data)
                      ? "Not available on this PC"
                      : "Desktop helper required"
                    : "Review only"}
              </Badge>
              {planMissing(o.id) && (
                <Button
                  disabled={pending}
                  onClick={() => setPlanDialog(true)}
                  title="Create a copy of Windows' High performance plan, with your consent."
                >
                  <Plus size={16} /> Create plan…
                </Button>
              )}
              <button
                className="icon-button"
                aria-label={`Details for ${o.name}`}
                title={`Details for ${o.name}`}
                onClick={() => setDetail(o)}
              >
                <ArrowUpRight size={21} />
              </button>
            </div>
          </article>
        ))}
      </div>
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
      {detail && (
        <Modal
          title={detail.name}
          description={detail.description}
          onClose={() => setDetail(null)}
        >
          <div className="dialog-section">
            <Badge tone={detail.risk === "Low" ? "lime" : "amber"}>
              {detail.risk} risk
            </Badge>
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
            {detail.id === "driver-review" && (
              <Button
                onClick={() => {
                  setDetail(null);
                  navigate("System");
                }}
              >
                View drivers in System
                <ArrowUpRight size={17} />
              </Button>
            )}
            <Button
              variant="primary"
              disabled={!data.capabilities.includes(detail.id)}
              onClick={() => {
                setDetail(null);
                preview([detail.id]);
              }}
            >
              Preview changes
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
      <div className="preset-list">
        {all.map((p) => (
          <article key={p.id}>
            <div className="preset-mark">
              <SlidersHorizontal size={26} />
            </div>
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
                .filter((o) => o.supported)
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
