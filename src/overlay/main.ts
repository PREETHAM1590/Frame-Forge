// Overlay page: plain DOM and one canvas, no framework. It only draws the model the main process sends.
import type { OverlayModel } from "../../shared/overlay";

declare global {
  interface Window {
    overlay: { onModel(callback: (model: OverlayModel) => void): void };
  }
}
const $ = (id: string) => document.getElementById(id)!;
const graph = $("graph") as HTMLCanvasElement;
const ctx = graph.getContext("2d")!;

function draw(times: number[] | null) {
  ctx.clearRect(0, 0, graph.width, graph.height);
  graph.hidden = !times || times.length < 2;
  if (!times || times.length < 2) return;
  // 0..50 ms, newest on the right; a taller line is a slower frame.
  const step = graph.width / (times.length - 1);
  ctx.strokeStyle = "#ff5500";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  times.forEach((t, i) => {
    const y = graph.height - Math.min(t, 50) * (graph.height / 50);
    if (i === 0) ctx.moveTo(0, y);
    else ctx.lineTo(i * step, y);
  });
  ctx.stroke();
}

window.overlay.onModel((m) => {
  const box = $("box");
  box.className = `${m.corner.startsWith("bottom") ? "bottom" : ""} ${m.corner.endsWith("right") ? "right" : ""}`;
  box.style.opacity = String(m.opacity);
  const fps = $("fps");
  fps.hidden = !m.show.fps || m.fps === null;
  fps.innerHTML = "";
  fps.append(
    String(m.fps ?? ""),
    Object.assign(document.createElement("small"), { textContent: " FPS" }),
  );
  const low = $("low");
  low.hidden = !m.show.low1 || m.low1 === null;
  low.textContent = `1% low ${m.low1} FPS`;
  draw(m.graph);
  const sys = $("sys");
  sys.replaceChildren();
  const metrics: Array<[string, boolean, number | null]> = [
    ["CPU", m.show.cpu, m.cpu],
    ["GPU", m.show.gpu, m.gpu],
    ["RAM", m.show.ram, m.ram],
  ];
  for (const [name, on, value] of metrics)
    if (on)
      sys.append(
        Object.assign(document.createElement("span"), {
          textContent: `${name} ${value === null ? "--" : `${value}%`}`,
        }),
      );
  sys.hidden = sys.childElementCount === 0;
  const hint = $("hint");
  hint.hidden = !m.hint;
  hint.textContent = m.hint ?? "";
  const clock = $("clock");
  clock.hidden = m.clock === null;
  clock.textContent = m.clock ?? "";
});
