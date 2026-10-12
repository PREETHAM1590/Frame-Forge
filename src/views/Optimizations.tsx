import { useState } from "react";
import {
  Search,
  ArrowUpRight,
  SlidersHorizontal,
  ShieldAlert,
  Check,
  Plus,
  Trash2,
} from "lucide-react";
import { catalogue, presets, type Optimization } from "../../shared/catalogue";
import type { OperationId } from "../../shared/contracts";
import { PageTitle, Badge, Button, Modal, Empty } from "../components/ui";
import type { ViewProps } from "../types";
export function Optimizations({ data, preview }: ViewProps) {
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("All");
  const [availability, setAvailability] = useState("All");
  const [detail, setDetail] = useState<Optimization | null>(null);
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
                    ? "Desktop helper required"
                    : "Unsupported"}
              </Badge>
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
              {detail.supported
                ? "Windows operations require the desktop app and its published helper."
                : "This operation is unsupported. No changes will be made."}
            </div>
          )}
          <div className="dialog-actions">
            <Button onClick={() => setDetail(null)}>Close</Button>
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
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [ids, setIds] = useState<OperationId[]>([]);
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
          <Button onClick={() => setCreating(true)}>
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
                <button
                  className="icon-button"
                  title="Remove preset"
                  aria-label={`Remove ${p.name}`}
                  disabled={pending}
                  onClick={() =>
                    void run("removePreset", { id: p.id }, "Preset removed.")
                  }
                >
                  <Trash2 size={17} />
                </button>
              )}
              <Button disabled={pending} onClick={() => preview(p.ids)}>
                Review preset
                <ArrowUpRight size={17} />
              </Button>
            </div>
          </article>
        ))}
      </div>
      {creating && (
        <Modal
          title="Custom preset"
          description="Save a selection. Creating a preset does not change Windows."
          onClose={() => setCreating(false)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const result = await run(
                "savePreset",
                { name, ids },
                "Preset saved.",
              );
              if (result) {
                setCreating(false);
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
                onChange={(e) => setName(e.target.value)}
              />
            </label>
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
              <Button type="button" onClick={() => setCreating(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={pending || !ids.length || !name.trim()}
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
