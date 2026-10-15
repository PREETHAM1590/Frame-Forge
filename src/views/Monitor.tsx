import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Network,
  Thermometer,
} from "lucide-react";
import {
  Badge,
  ErrorState,
  Meter,
  PageTitle,
  Panel,
  SectionHeader,
} from "../components/ui";
import { useMonitorFeed } from "../useMonitor";
import { AreaChart } from "./monitor/Charts";
import { GameMonitor } from "./monitor/GameMonitor";
import { Benchmark } from "./monitor/Benchmark";
import { formatLink, formatRate, formatSize, percent } from "./monitor/format";
import type { MonitorSample } from "../../shared/contracts";
import type { ViewProps } from "../types";
const tone = (v: number) =>
  v >= 90 ? "error" : v >= 70 ? "caution" : "primary";
const usedPercent = (s: MonitorSample) =>
  s.memory.totalBytes
    ? (100 * (s.memory.totalBytes - s.memory.availableBytes)) /
      s.memory.totalBytes
    : 0;
/** The adapter that holds the dedicated memory is the discrete GPU; otherwise the first one. */
const mainGpu = (s: MonitorSample) =>
  [...s.gpu.adapters].sort((a, b) => b.dedicatedBytes - a.dedicatedBytes)[0];

function Cell({
  label,
  icon,
  value,
  hint,
  values,
  max,
  label2,
}: {
  label: string;
  icon: React.ReactNode;
  value: string;
  hint: string;
  values: number[];
  max?: number;
  label2: string;
}) {
  const last = values.at(-1) ?? 0;
  return (
    <div className="mon-cell">
      <div className="stat-head">
        <span className="label">
          {icon}
          {label}
        </span>
      </div>
      <div className="stat-value xl mon-value">{value}</div>
      <div className="stat-hint">{hint}</div>
      <AreaChart
        values={values}
        max={max}
        label={`${label2}, last minute`}
        tone={tone(max ? (100 * last) / max : last)}
      />
    </div>
  );
}

export function Monitor({ data }: ViewProps) {
  const { samples, status, error, retry } = useMonitorFeed();
  const last = samples.at(-1);
  return (
    <>
      <PageTitle
        title="System monitor"
        subtitle="Windows performance counters, read once a second while this page is open. Nothing is saved or sent anywhere."
        action={
          <Badge
            tone={
              status === "live"
                ? "lime"
                : status === "starting"
                  ? "neutral"
                  : "amber"
            }
          >
            {status === "live"
              ? "Live"
              : status === "starting"
                ? "Starting"
                : status === "stalled"
                  ? "No data"
                  : "Unavailable"}
          </Badge>
        }
      />
      {status === "unavailable" && (
        <ErrorState
          title="The live monitor is not available"
          message={error}
          onRetry={retry}
        />
      )}
      {status === "stalled" && (
        <ErrorState
          title="No readings for a few seconds"
          message="The Windows helper stopped sending counters."
          onRetry={retry}
        />
      )}
      {!last && status !== "unavailable" && status !== "stalled" && (
        <p className="muted" role="status">
          Reading the first sample...
        </p>
      )}
      {last && (
        <div className="monitor">
          <section className="mon-overview" aria-label="Overview">
            <Cell
              label="CPU"
              icon={<Cpu size={14} />}
              value={percent(last.cpu.total)}
              hint={`${last.cpu.cores.length} logical cores`}
              values={samples.map((s) => s.cpu.total)}
              label2={`CPU ${percent(last.cpu.total)}`}
            />
            <Cell
              label="Memory"
              icon={<MemoryStick size={14} />}
              value={percent(usedPercent(last))}
              hint={`${formatSize(last.memory.totalBytes - last.memory.availableBytes)} used / ${formatSize(last.memory.availableBytes)} available`}
              values={samples.map(usedPercent)}
              label2={`Memory ${percent(usedPercent(last))}`}
            />
            {(() => {
              const gpu = mainGpu(last);
              return (
                <Cell
                  label="GPU 3D"
                  icon={<Activity size={14} />}
                  value={
                    last.gpu.available && gpu ? percent(gpu.engine3d) : "n/a"
                  }
                  hint={
                    gpu
                      ? `${formatSize(gpu.dedicatedBytes)} dedicated / ${formatSize(gpu.sharedBytes)} shared memory`
                      : (last.gpu.detail ?? "No GPU adapter reported")
                  }
                  values={samples.map((s) => mainGpu(s)?.engine3d ?? 0)}
                  label2={`GPU 3D ${gpu ? percent(gpu.engine3d) : "not available"}`}
                />
              );
            })()}
            <Cell
              label="Disk active"
              icon={<HardDrive size={14} />}
              value={percent(
                Math.max(0, ...last.disks.map((d) => d.activePercent)),
              )}
              hint={
                last.disks.length
                  ? `${last.disks.length} drive${last.disks.length === 1 ? "" : "s"}, busiest shown`
                  : "No drive counters"
              }
              values={samples.map((s) =>
                Math.max(0, ...s.disks.map((d) => d.activePercent)),
              )}
              label2="Busiest drive active time"
            />
          </section>

          <Panel>
            <SectionHeader
              title="CPU cores"
              icon={<Cpu size={18} />}
              level={3}
            />
            <ul className="core-grid">
              {last.cpu.cores.map((v, i) => (
                <li key={i}>
                  <span className="label">C{i}</span>
                  <Meter value={v} label={`Core ${i} load`} tone={tone(v)} />
                  <span className="mono">{percent(v)}</span>
                </li>
              ))}
            </ul>
          </Panel>

          <div className="mon-two">
            <Panel>
              <SectionHeader
                title="GPU"
                icon={<Activity size={18} />}
                level={3}
              />
              {!last.gpu.available && (
                <p className="muted">{last.gpu.detail}</p>
              )}
              {last.gpu.adapters.map((a, i) => (
                <div className="mon-block" key={a.id}>
                  <strong>
                    GPU {i}
                    <span className="muted">
                      {" "}
                      /{" "}
                      {a.dedicatedBytes > 0
                        ? "dedicated memory"
                        : "shared memory only"}
                    </span>
                  </strong>
                  {(
                    [
                      ["3D", a.engine3d],
                      ["Compute", a.compute],
                      ["Copy", a.copy],
                      ["Video", a.video],
                    ] as const
                  ).map(([name, v]) => (
                    <div className="mon-row" key={name}>
                      <span className="label">{name}</span>
                      <Meter
                        value={v}
                        label={`GPU ${i} ${name} engine`}
                        tone={tone(v)}
                      />
                      <span className="mono">{percent(v)}</span>
                    </div>
                  ))}
                  <p className="mon-note">
                    Memory in use: {formatSize(a.dedicatedBytes)} dedicated,{" "}
                    {formatSize(a.sharedBytes)} shared
                  </p>
                </div>
              ))}
            </Panel>
            <Panel>
              <SectionHeader
                title="Temperatures"
                icon={<Thermometer size={18} />}
                level={3}
              />
              {last.temperatures.gpu.map((g) => (
                <div className="mon-row simple" key={g.name}>
                  <span>{g.name}</span>
                  <span className="mono">{Math.round(g.celsius)} &deg;C</span>
                </div>
              ))}
              {last.temperatures.cpuCelsius !== null && (
                <div className="mon-row simple">
                  <span>ACPI thermal zone</span>
                  <span className="mono">
                    {Math.round(last.temperatures.cpuCelsius)} &deg;C
                  </span>
                </div>
              )}
              {last.temperatures.note && (
                <p className="mon-note">
                  CPU and board temperatures: {last.temperatures.note} GPU
                  temperature appears when the NVIDIA driver provides it.
                </p>
              )}
            </Panel>
          </div>

          <div className="mon-two">
            <Panel>
              <SectionHeader
                title="Drives"
                icon={<HardDrive size={18} />}
                level={3}
              />
              {last.disks.length === 0 && (
                <p className="muted">No drive counters on this PC.</p>
              )}
              {last.disks.map((d) => (
                <div className="mon-block" key={d.name}>
                  <div className="mon-row simple">
                    <strong>{d.name}</strong>
                    <span className="mono">
                      {percent(d.activePercent)} active
                    </span>
                  </div>
                  <Meter
                    value={d.activePercent}
                    label={`${d.name} active time`}
                    tone={tone(d.activePercent)}
                  />
                  <p className="mon-note">
                    Read {formatRate(d.readBytesPerSec)} / Write{" "}
                    {formatRate(d.writeBytesPerSec)}
                  </p>
                </div>
              ))}
            </Panel>
            <Panel>
              <SectionHeader
                title="Network"
                icon={<Network size={18} />}
                level={3}
              />
              {last.network.length === 0 && (
                <p className="muted">No active network adapter.</p>
              )}
              {last.network.map((n) => (
                <div className="mon-block" key={n.name}>
                  <strong>{n.name}</strong>
                  <div className="mon-row simple">
                    <span className="label">Down</span>
                    <span className="mono">
                      {formatRate(n.downBytesPerSec)}
                    </span>
                  </div>
                  <div className="mon-row simple">
                    <span className="label">Up</span>
                    <span className="mono">{formatRate(n.upBytesPerSec)}</span>
                  </div>
                  <p className="mon-note">
                    Link speed {formatLink(n.linkBitsPerSec)}
                  </p>
                </div>
              ))}
            </Panel>
          </div>

          <div className="mon-two">
            {(
              [
                ["Top programs by CPU", last.processes.byCpu, "cpu"],
                ["Top programs by memory", last.processes.byMemory, "memory"],
              ] as const
            ).map(([title, rows, by]) => (
              <Panel key={by}>
                <SectionHeader title={title} level={3} />
                <table className="mon-table">
                  <thead>
                    <tr>
                      <th scope="col">Program</th>
                      <th scope="col">CPU</th>
                      <th scope="col">Memory</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((p) => (
                      <tr key={p.name}>
                        <td>
                          {p.name}
                          {p.count > 1 && (
                            <span className="muted"> x{p.count}</span>
                          )}
                        </td>
                        <td className="mono">{percent(p.cpuPercent)}</td>
                        <td className="mono">
                          {formatSize(p.workingSetBytes)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Panel>
            ))}
          </div>
        </div>
      )}
      <GameMonitor data={data} />
      <Benchmark data={data} />
    </>
  );
}
