import { Flame, Menu, X } from "lucide-react";
import type { ReactNode, ComponentType } from "react";
export interface RailItem<P extends string> {
  page: P;
  label: string;
  icon?: ComponentType<{ size?: number }>;
  badge?: ReactNode;
  /** Heading shown above this entry; entries after it share the group until the next heading. */
  group?: string;
}
export function NavRail<P extends string>({
  items,
  current,
  onNavigate,
  open,
  onClose,
  bottomItem,
  footer,
  version,
}: {
  items: readonly RailItem<P>[];
  current: P;
  onNavigate: (page: P) => void;
  open: boolean;
  onClose: () => void;
  bottomItem?: RailItem<P>;
  footer?: ReactNode;
  version?: string;
}) {
  const row = (n: RailItem<P>) => (
    <button
      key={n.page}
      className={`rail-item ${current === n.page ? "selected" : ""}`}
      aria-current={current === n.page ? "page" : undefined}
      onClick={() => onNavigate(n.page)}
    >
      {n.icon && <n.icon size={18} />}
      <span>{n.label}</span>
      {n.badge}
    </button>
  );
  // Consecutive entries after a heading share one labelled group.
  const groups: { name: string; items: RailItem<P>[] }[] = [];
  for (const n of items) {
    if (n.group || !groups.length)
      groups.push({ name: n.group ?? "", items: [] });
    groups.at(-1)!.items.push(n);
  }
  return (
    <aside className={`rail ${open ? "open" : ""}`}>
      <div className="rail-brand">
        <span className="rail-logo">
          <Flame size={18} />
        </span>
        <span>Frameforge</span>
        {version && <span className="tag">v{version}</span>}
        <button
          className="icon-button rail-close"
          aria-label="Close navigation"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </div>
      <nav aria-label="Main navigation">
        {groups.map((g) => (
          <div
            key={g.name}
            className="rail-group"
            role="group"
            aria-label={g.name || undefined}
          >
            {g.name && (
              <span className="rail-heading" aria-hidden="true">
                {g.name}
              </span>
            )}
            {g.items.map(row)}
          </div>
        ))}
      </nav>
      <div className="rail-bottom">
        {bottomItem && row(bottomItem)}
        {footer}
      </div>
    </aside>
  );
}
export function TopBar({
  onMenu,
  status,
  readouts = [],
  children,
}: {
  onMenu: () => void;
  status: { text: string; tone?: "ok" | "caution" | "error" };
  readouts?: { label: string; value: string }[];
  children?: ReactNode;
}) {
  return (
    <header className="topbar">
      <div className="topbar-left">
        <button
          className="icon-button mobile-menu"
          aria-label="Open navigation"
          onClick={onMenu}
        >
          <Menu size={20} />
        </button>
        <span
          className={`status-line ${status.tone && status.tone !== "ok" ? status.tone : ""}`}
        >
          {status.text}
        </span>
        {readouts.map((r) => (
          <span className="readout" key={r.label}>
            {r.label}
            <strong>{r.value}</strong>
          </span>
        ))}
      </div>
      <div className="topbar-right">{children}</div>
    </header>
  );
}
/** Re-keys on navigation so the new page slides and fades in. */
export function PageTransition({
  pageKey,
  children,
}: {
  pageKey: string;
  children: ReactNode;
}) {
  return (
    <div key={pageKey} className="page-transition">
      {children}
    </div>
  );
}
/** The page heading: the title carries the page; the optional line says what it is for, in one sentence. */
export function PageTitle({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <header className="page-title">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {action}
    </header>
  );
}
