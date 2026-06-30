import { useRef } from "react";
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  BarController,
  LineController,
  PieController,
  DoughnutController,
  ScatterController,
  Title,
  Tooltip,
  Legend,
  Filler,
} from "chart.js";
import { Chart } from "react-chartjs-2";

// The generic <Chart type=...> component does not auto-register controllers
// (only the typed <Bar>/<Line>/… wrappers do), so register them explicitly.
ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  LineElement,
  PointElement,
  ArcElement,
  BarController,
  LineController,
  PieController,
  DoughnutController,
  ScatterController,
  Title,
  Tooltip,
  Legend,
  Filler
);

// A pleasant, repeatable palette for series / pie slices.
const PALETTE = [
  "#8b5cf6", "#ec4899", "#22d3ee", "#34d399", "#f59e0b",
  "#f87171", "#60a5fa", "#a78bfa", "#fb7185", "#4ade80",
];

function color(i, alpha = 1) {
  const hex = PALETTE[i % PALETTE.length];
  if (alpha === 1) return hex;
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function triggerDownload(href, filename) {
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function safeName(title, ext) {
  const base = (title || "chart").replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "");
  return `${base || "chart"}.${ext}`;
}

// Build CSV text from either a table spec or a chart spec.
function specToCsv(spec) {
  const escape = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  let rows;
  if (spec.chart_type === "table") {
    rows = [spec.table_columns || [], ...(spec.table_rows || [])];
  } else {
    const labels = spec.labels || [];
    const datasets = spec.datasets || [];
    const header = ["label", ...datasets.map((d) => d.label || "value")];
    rows = [header, ...labels.map((l, i) => [l, ...datasets.map((d) => d.data?.[i] ?? "")])];
  }
  return rows.map((r) => r.map(escape).join(",")).join("\n");
}

function downloadCsv(spec) {
  const blob = new Blob([specToCsv(spec)], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, safeName(spec.title, "csv"));
  URL.revokeObjectURL(url);
}

// Map our spec's chart_type to a Chart.js config.
function toChartConfig(spec) {
  const labels = spec.labels || [];
  const datasets = spec.datasets || [];
  const isPie = spec.chart_type === "pie" || spec.chart_type === "doughnut";
  const isArea = spec.chart_type === "area";
  const baseType =
    spec.chart_type === "doughnut" ? "doughnut"
    : spec.chart_type === "pie" ? "pie"
    : spec.chart_type === "area" ? "line"
    : spec.chart_type === "scatter" ? "scatter"
    : spec.chart_type; // bar | line

  const data = {
    labels,
    datasets: datasets.map((d, di) => {
      if (isPie) {
        return {
          label: d.label,
          data: d.data,
          backgroundColor: (d.data || []).map((_, i) => color(i, 0.85)),
          borderColor: "#0b1020",
          borderWidth: 2,
        };
      }
      if (baseType === "scatter") {
        return {
          label: d.label,
          data: (d.data || []).map((y, i) => ({ x: Number(labels[i]) || i, y })),
          backgroundColor: color(di, 0.85),
          borderColor: color(di),
        };
      }
      return {
        label: d.label,
        data: d.data,
        backgroundColor: baseType === "line" ? color(di, isArea ? 0.25 : 1) : color(di, 0.8),
        borderColor: color(di),
        borderWidth: 2,
        fill: isArea,
        tension: 0.3,
        pointRadius: baseType === "line" ? 3 : undefined,
      };
    }),
  };

  const options = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { labels: { color: "#cbd5e1" } },
      title: spec.title ? { display: true, text: spec.title, color: "#e2e8f0" } : { display: false },
    },
    scales: isPie
      ? {}
      : {
          x: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.06)" } },
          y: { ticks: { color: "#94a3b8" }, grid: { color: "rgba(255,255,255,0.06)" } },
        },
  };

  return { type: baseType, data, options };
}

function ChartBlock({ spec, onPin, onRemove }) {
  const chartRef = useRef(null);

  if (!spec) return null;

  // ── Table rendering ──────────────────────────────────────────────────────
  if (spec.chart_type === "table") {
    const columns = spec.table_columns || [];
    const tableRows = spec.table_rows || [];
    return (
      <div className="chart-block">
        {spec.title && <div className="chart-title">{spec.title}</div>}
        <div className="chart-table-wrap">
          <table className="chart-table">
            <thead>
              <tr>{columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {tableRows.map((row, ri) => (
                <tr key={ri}>{row.map((cell, ci) => <td key={ci}>{cell}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
        {spec.notes && <div className="chart-notes">{spec.notes}</div>}
        <div className="chart-actions">
          <button type="button" onClick={() => downloadCsv(spec)}>⬇ Download CSV</button>
          {onPin && (
            <button type="button" onClick={() => onPin(spec)}>📌 Pin to dashboard</button>
          )}
          {onRemove && (
            <button type="button" className="danger" onClick={onRemove}>🗑 Remove</button>
          )}
        </div>
      </div>
    );
  }

  // ── Chart rendering ──────────────────────────────────────────────────────
  const { type, data, options } = toChartConfig(spec);

  function downloadPng() {
    const chart = chartRef.current;
    if (!chart) return;
    triggerDownload(chart.toBase64Image("image/png", 1), safeName(spec.title, "png"));
  }

  return (
    <div className="chart-block">
      <div className="chart-canvas-wrap">
        <Chart ref={chartRef} type={type} data={data} options={options} />
      </div>
      {spec.notes && <div className="chart-notes">{spec.notes}</div>}
      <div className="chart-actions">
        <button type="button" onClick={downloadPng}>⬇ Download PNG</button>
        <button type="button" onClick={() => downloadCsv(spec)}>⬇ Download CSV</button>
        {onPin && (
          <button type="button" onClick={() => onPin(spec)}>📌 Pin to dashboard</button>
        )}
        {onRemove && (
          <button type="button" className="danger" onClick={onRemove}>🗑 Remove</button>
        )}
      </div>
    </div>
  );
}

export default ChartBlock;
