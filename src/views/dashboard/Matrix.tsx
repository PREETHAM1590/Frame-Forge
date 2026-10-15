import {
  CellGrid,
  LinkButton,
  SectionHeader,
  StatCell,
  formatBytes,
} from "../../components/ui";
import type { Hardware } from "../../../shared/contracts";

/** Four real readings from the hardware snapshot; no invented sensors. */
export function Matrix({
  h,
  onDetails,
}: {
  h: Hardware;
  onDetails: () => void;
}) {
  const used = h.memoryBytes - h.freeMemoryBytes;
  const memoryPercent = h.memoryBytes
    ? Math.round((used / h.memoryBytes) * 100)
    : 0;
  const total = h.drives.reduce((s, d) => s + d.totalBytes, 0);
  const free = h.drives.reduce((s, d) => s + d.freeBytes, 0);
  const storagePercent = total ? Math.round(((total - free) / total) * 100) : 0;
  return (
    <section aria-label="System overview" className="dash-card">
      <SectionHeader
        title="This PC"
        aside={<LinkButton onClick={onDetails}>Details</LinkButton>}
      />
      <CellGrid columns="repeat(2, minmax(0, 1fr))" className="matrix">
        <StatCell
          label="Processor"
          value={<span className="stat-text">{h.cpu}</span>}
          hint={`${h.cores} logical processors`}
        />
        <StatCell
          label="Graphics"
          value={<span className="stat-text">{h.gpu[0] ?? "Unavailable"}</span>}
          hint={
            h.gpu.length
              ? "Display adapter detected"
              : "Windows helper required"
          }
        />
        <StatCell
          label="Memory in use"
          count={memoryPercent}
          unit="%"
          hint={`${formatBytes(used)} of ${formatBytes(h.memoryBytes)}; ${formatBytes(h.freeMemoryBytes)} available`}
          meter={{
            value: memoryPercent,
            label: "Memory in use",
            tone:
              memoryPercent > 90
                ? "error"
                : memoryPercent > 75
                  ? "caution"
                  : "primary",
          }}
        />
        <StatCell
          label="Storage"
          value={formatBytes(total)}
          hint={
            h.drives.length
              ? `${h.drives.length} local drive${h.drives.length === 1 ? "" : "s"}; ${formatBytes(free)} free`
              : "No drive readings"
          }
          meter={
            total
              ? {
                  value: storagePercent,
                  label: "Storage used",
                  tone: storagePercent > 92 ? "error" : "primary",
                }
              : undefined
          }
        />
      </CellGrid>
    </section>
  );
}
