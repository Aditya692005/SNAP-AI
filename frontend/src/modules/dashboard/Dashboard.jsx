import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import Sidebar from "../../components/Sidebar";
import ChartBlock from "../ai/ChartBlock";
import {
  DEPARTMENTS,
  DEPT_BY_ID,
  METRIC_CATALOG,
  METRIC_BY_KEY,
  isMetricVisible,
  metricColor,
  metricLabel,
} from "./metricsCatalog";
import "./Dashboard.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

// Display currencies the user can switch between. Rates are relative to USD and
// approximate — used to re-denominate currency-kind metrics for display only
// (the stored figures keep their original currency). Values shown with a "≈"
// when converted away from the source currency.
const CURRENCIES = [
  { code: "USD", symbol: "$" },
  { code: "INR", symbol: "₹" },
  { code: "GBP", symbol: "£" },
  { code: "EUR", symbol: "€" },
];
const FX_USD = { USD: 1, INR: 83.3, GBP: 0.79, EUR: 0.92 };
const SYMBOL = Object.fromEntries(CURRENCIES.map((c) => [c.code, c.symbol]));

function convertCurrency(value, from, to) {
  const f = FX_USD[from] || 1;
  const t = FX_USD[to] || 1;
  return (value / f) * t;
}

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

// Classify a period label into a single granularity so we never mix annual,
// quarterly, and monthly figures in the same view.
function granularityOf(period) {
  if (/^\d{4}$/.test(period)) return "annual";
  if (/^\d{4}-Q[1-4]$/i.test(period)) return "quarterly";
  if (/^\d{4}-\d{2}$/.test(period)) return "monthly";
  return null;
}

const GRAN_LABELS = { annual: "Annual", quarterly: "Quarterly", monthly: "Monthly" };
const GRAN_ORDER = ["annual", "quarterly", "monthly"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Human-friendly label for a specific period ("2024", "Q3 2024", "Mar 2024").
function periodLabel(period) {
  if (!period) return "—";
  const q = /^(\d{4})-Q([1-4])$/i.exec(period);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(period);
  if (m) return `${MONTHS[Number(m[2]) - 1] || m[2]} ${m[1]}`;
  return period;
}

// Sortable key for period labels ("2024", "2024-03", "2024-Q2").
function periodKey(period) {
  if (!period) return -1;
  const year = parseInt(String(period).slice(0, 4), 10) || 0;
  const q = /Q([1-4])/i.exec(period);
  if (q) return year * 100 + (Number(q[1]) - 1) * 3 + 1;
  const m = /^\d{4}-(\d{2})/.exec(period);
  if (m) return year * 100 + Number(m[1]);
  return year * 100;
}

function formatValue(value, kind, symbol, approx) {
  if (value == null) return "—";
  if (kind === "percent") return `${value.toFixed(1)}%`;
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  let s;
  if (abs >= 1e9) s = `${(abs / 1e9).toFixed(1)}B`;
  else if (abs >= 1e6) s = `${(abs / 1e6).toFixed(1)}M`;
  else if (abs >= 1e3) s = `${(abs / 1e3).toFixed(1)}K`;
  else s = abs.toLocaleString();
  if (kind !== "currency") return `${sign}${s}`;
  const prefix = approx ? "≈" : "";
  return `${prefix}${symbol || ""}${sign}${s}`;
}

// Lightweight inline sparkline — no chart.js overhead per KPI card.
function Sparkline({ points, color }) {
  if (!points || points.length < 2) return <div className="spark-empty" />;
  const w = 130;
  const h = 38;
  const pad = 3;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const sx = (i) => pad + (i / (points.length - 1)) * (w - 2 * pad);
  const sy = (v) => h - pad - ((v - min) / range) * (h - 2 * pad);
  const line = points
    .map((v, i) => `${i ? "L" : "M"}${sx(i).toFixed(1)} ${sy(v).toFixed(1)}`)
    .join(" ");
  const area = `${line} L${sx(points.length - 1).toFixed(1)} ${h - pad} L${sx(0).toFixed(1)} ${h - pad} Z`;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={area} fill={color} opacity="0.14" />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// Single-metric spec for the focused main chart.
function mainSpec(series, metric, chartType) {
  const s = series[metric];
  if (!s?.length) return null;
  return {
    chart_type: chartType,
    title: `${metricLabel(metric)} over time`,
    labels: s.map((p) => p.period),
    datasets: [{ label: metricLabel(metric), data: s.map((p) => p.value) }],
    notes: `${metricLabel(metric)} aggregated by period from your included documents.`,
  };
}

// Multi-series line spec aligning periods across the given metrics.
function deptTrendSpec(series, metricKeys, deptLabel) {
  const wanted = metricKeys.filter((m) => series[m]?.length);
  if (wanted.length < 2) return null;
  const periods = [
    ...new Set(wanted.flatMap((m) => series[m].map((p) => p.period))),
  ].sort((a, b) => periodKey(a) - periodKey(b));
  return {
    chart_type: "line",
    title: `${deptLabel} trends`,
    labels: periods,
    datasets: wanted.map((m) => {
      const byPeriod = Object.fromEntries(series[m].map((p) => [p.period, p.value]));
      return { label: metricLabel(m), data: periods.map((p) => byPeriod[p] ?? null) };
    }),
    notes: "Periods aggregated from your included documents.",
  };
}

function breakdownSpec(breakdowns, metric, periodSuffix) {
  const b = breakdowns[metric];
  if (!b?.length) return null;
  return {
    chart_type: b.length <= 6 ? "pie" : "bar",
    title: `${metricLabel(metric)} by category${periodSuffix ? ` · ${periodSuffix}` : ""}`,
    labels: b.map((x) => x.label),
    datasets: [{ label: metricLabel(metric), data: b.map((x) => x.value) }],
  };
}

const CHART_TYPES = [
  { id: "line", label: "Line" },
  { id: "area", label: "Area" },
  { id: "bar", label: "Bar" },
];

function Dashboard() {
  const [data, setData] = useState(null);
  const [documents, setDocuments] = useState([]);
  const [prefs, setPrefs] = useState({});
  const [pinnedCharts, setPinnedCharts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [recomputing, setRecomputing] = useState(false);
  const [activeMetric, setActiveMetric] = useState("revenue");
  const [chartType, setChartType] = useState("area");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [metricsOpen, setMetricsOpen] = useState(false);
  const [currencyPref, setCurrencyPref] = useState(
    () => localStorage.getItem("dashboardCurrency") || null
  );
  const [currencyOpen, setCurrencyOpen] = useState(false);
  const [granularity, setGranularity] = useState("annual");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [periodOpen, setPeriodOpen] = useState(false);

  useEffect(() => {
    refresh();
  }, []);

  const series = data?.series || {};
  const breakdowns = data?.breakdowns || {};
  const kpis = data?.kpis || [];
  const hasData = data?.has_data;

  // The currency the stored figures are in (dominant across documents), and the
  // currency the user wants to see them in. Conversion is approximate, so values
  // are flagged with "≈" whenever the two differ.
  const sourceCurrency = data?.currency && FX_USD[data.currency] ? data.currency : "USD";
  const displayCurrency =
    currencyPref || (data?.currency && FX_USD[data.currency] ? data.currency : "USD");
  const symbol = SYMBOL[displayCurrency] || "";
  const converting = displayCurrency !== sourceCurrency;

  function chooseCurrency(code) {
    setCurrencyPref(code);
    localStorage.setItem("dashboardCurrency", code);
    setCurrencyOpen(false);
  }

  // Currency-kind metric values re-denominated into the display currency. Number
  // and percent metrics are left untouched (they aren't money).
  const displaySeries = useMemo(() => {
    const out = {};
    for (const [k, arr] of Object.entries(series)) {
      out[k] =
        METRIC_BY_KEY[k]?.kind === "currency"
          ? arr.map((p) => ({ ...p, value: convertCurrency(p.value, sourceCurrency, displayCurrency) }))
          : arr;
    }
    return out;
  }, [series, sourceCurrency, displayCurrency]);

  const displayBreakdowns = useMemo(() => {
    const out = {};
    for (const [k, arr] of Object.entries(breakdowns)) {
      out[k] =
        METRIC_BY_KEY[k]?.kind === "currency"
          ? arr.map((x) => ({ ...x, value: convertCurrency(x.value, sourceCurrency, displayCurrency) }))
          : arr;
    }
    return out;
  }, [breakdowns, sourceCurrency, displayCurrency]);

  // Available periods bucketed by granularity (from every metric's series and
  // breakdowns), each sorted chronologically.
  const periodsByGran = useMemo(() => {
    const buckets = { annual: new Set(), quarterly: new Set(), monthly: new Set() };
    const add = (p) => {
      const g = granularityOf(p);
      if (g) buckets[g].add(p);
    };
    for (const arr of Object.values(displaySeries)) for (const p of arr) add(p.period);
    for (const arr of Object.values(displayBreakdowns)) for (const e of arr) if (e.period) add(e.period);
    const sortAsc = (s) => [...s].sort((a, b) => periodKey(a) - periodKey(b));
    return {
      annual: sortAsc(buckets.annual),
      quarterly: sortAsc(buckets.quarterly),
      monthly: sortAsc(buckets.monthly),
    };
  }, [displaySeries, displayBreakdowns]);

  const availableGrans = useMemo(
    () => GRAN_ORDER.filter((g) => periodsByGran[g].length > 0),
    [periodsByGran]
  );

  // Default/validate the granularity and selected period whenever the data set
  // changes — never leave a granularity or period that has no data selected.
  useEffect(() => {
    if (availableGrans.length === 0) return;
    if (!availableGrans.includes(granularity)) {
      setGranularity(availableGrans[0]);
      return;
    }
    const periods = periodsByGran[granularity];
    if (periods.length && !periods.includes(selectedPeriod)) {
      setSelectedPeriod(periods[periods.length - 1]); // latest
    }
  }, [data, granularity, periodsByGran, availableGrans]); // eslint-disable-line react-hooks/exhaustive-deps

  // Series restricted to the chosen granularity (so trends never mix grains).
  const granSeries = useMemo(() => {
    const out = {};
    for (const [k, arr] of Object.entries(displaySeries)) {
      const f = arr.filter((p) => granularityOf(p.period) === granularity);
      if (f.length) out[k] = f;
    }
    return out;
  }, [displaySeries, granularity]);

  // Category breakdowns for exactly the selected period, aggregated by label.
  const periodBreakdowns = useMemo(() => {
    const out = {};
    for (const [k, arr] of Object.entries(displayBreakdowns)) {
      const agg = new Map();
      for (const e of arr) {
        if (e.period !== selectedPeriod) continue;
        agg.set(e.label, (agg.get(e.label) || 0) + e.value);
      }
      const list = [...agg.entries()]
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value);
      if (list.length) out[k] = list;
    }
    return out;
  }, [displayBreakdowns, selectedPeriod]);

  // KPI value/delta for one metric at the selected period (vs the previous data
  // point of the same granularity).
  function kpiFor(metricKey) {
    const arr = granSeries[metricKey];
    if (!arr?.length) return null;
    const idx = arr.findIndex((p) => p.period === selectedPeriod);
    if (idx === -1) return { value: null, delta: null };
    const cur = arr[idx].value;
    const prev = idx > 0 ? arr[idx - 1].value : null;
    const delta = prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    return { value: cur, delta };
  }

  // Catalog entries the user has chosen to display, in catalog order.
  const visibleMetrics = useMemo(
    () => METRIC_CATALOG.filter((m) => isMetricVisible(m.key, prefs)),
    [prefs]
  );

  // Group visible metrics by department (departments with none are skipped).
  const visibleByDept = useMemo(() => {
    const map = new Map();
    for (const m of visibleMetrics) {
      if (!map.has(m.department)) map.set(m.department, []);
      map.get(m.department).push(m);
    }
    return map;
  }, [visibleMetrics]);

  // Keep the focused metric valid: it must be visible and have data in the
  // chosen granularity.
  useEffect(() => {
    if (!data) return;
    const ok = isMetricVisible(activeMetric, prefs) && granSeries[activeMetric]?.length;
    if (!ok) {
      const first = visibleMetrics.find((m) => granSeries[m.key]?.length);
      if (first) setActiveMetric(first.key);
    }
  }, [data, prefs, granSeries]); // eslint-disable-line react-hooks/exhaustive-deps

  async function refresh() {
    setLoading(true);
    try {
      const [mRes, dRes, pRes, cRes] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/metrics`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/documents`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/metric-prefs`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/charts`, { headers: authHeaders() }),
      ]);
      if (mRes.ok) setData(await mRes.json());
      if (dRes.ok) setDocuments((await dRes.json()).documents || []);
      if (pRes.ok) setPrefs((await pRes.json()).prefs || {});
      if (cRes.ok) setPinnedCharts((await cRes.json()).charts || []);
    } catch {
      // leave empty states
    } finally {
      setLoading(false);
    }
  }

  async function toggleMetric(key, visible) {
    setPrefs((prev) => ({ ...prev, [key]: visible }));
    try {
      await fetch(`${API_BASE}/api/dashboard/metric-prefs/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ visible }),
      });
    } catch {
      setPrefs((prev) => ({ ...prev, [key]: !visible }));
    }
  }

  async function toggleDocument(source, included) {
    setDocuments((prev) =>
      prev.map((d) => (d.source_document === source ? { ...d, included } : d))
    );
    try {
      await fetch(`${API_BASE}/api/dashboard/documents/${encodeURIComponent(source)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ included }),
      });
      const mRes = await fetch(`${API_BASE}/api/dashboard/metrics`, { headers: authHeaders() });
      if (mRes.ok) setData(await mRes.json());
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.source_document === source ? { ...d, included: !included } : d))
      );
    }
  }

  async function recompute() {
    setRecomputing(true);
    try {
      await fetch(`${API_BASE}/api/dashboard/recompute`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({}),
      });
      await refresh();
    } catch {
      // ignore
    } finally {
      setRecomputing(false);
    }
  }

  async function removePinnedChart(id) {
    setPinnedCharts((prev) => prev.filter((c) => c.id !== id));
    try {
      await fetch(`${API_BASE}/api/dashboard/charts/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      refresh(); // restore on failure
    }
  }

  const activeColor = metricColor(activeMetric);
  const activeDept = METRIC_BY_KEY[activeMetric]?.department;

  const focusChart = useMemo(
    () => mainSpec(granSeries, activeMetric, chartType),
    [granSeries, activeMetric, chartType]
  );

  const secondaryCharts = useMemo(() => {
    const charts = [];
    if (activeDept) {
      const deptKeys = (visibleByDept.get(activeDept) || []).map((m) => m.key);
      const trend = deptTrendSpec(granSeries, deptKeys, DEPT_BY_ID[activeDept]?.label || "");
      if (trend) charts.push(trend);
    }
    for (const m of visibleMetrics) {
      if (charts.length >= 3) break;
      const spec = breakdownSpec(periodBreakdowns, m.key, periodLabel(selectedPeriod));
      if (spec) charts.push(spec);
    }
    return charts;
  }, [granSeries, periodBreakdowns, visibleMetrics, visibleByDept, activeDept, selectedPeriod]);

  const includedCount = documents.filter((d) => d.included).length;
  const visibleCount = visibleMetrics.length;

  return (
    <div className="dashboard">
      <Sidebar />

      <main className="dashboard-content">
        {/* Header */}
        <div className="dashboard-header">
          <div className="dashboard-title-wrap">
            <span className="dashboard-eyebrow">SNAP AI · Studio</span>
            <h1>Insights Dashboard</h1>
            <p>Department metrics, extracted automatically from your documents.</p>
          </div>

          <div className="dashboard-toolbar">
            <div className="currency-select">
              <button
                className="chip currency-btn"
                onClick={() => setCurrencyOpen((o) => !o)}
                title={
                  converting
                    ? `Approximate conversion from ${sourceCurrency}`
                    : "Display currency"
                }
              >
                {symbol} {displayCurrency} <span className="caret">▾</span>
              </button>
              {currencyOpen && (
                <>
                  <div className="currency-backdrop" onClick={() => setCurrencyOpen(false)} />
                  <div className="currency-menu">
                    {CURRENCIES.map((c) => (
                      <button
                        key={c.code}
                        className={c.code === displayCurrency ? "active" : ""}
                        onClick={() => chooseCurrency(c.code)}
                      >
                        <span className="cur-sym">{c.symbol}</span> {c.code}
                        {c.code === displayCurrency && <span className="cur-check">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
            {converting && (
              <span className="fx-note" title="Figures converted at approximate rates">
                ≈ from {sourceCurrency}
              </span>
            )}
            <button
              className="ghost-btn"
              onClick={recompute}
              disabled={recomputing || documents.length === 0}
            >
              {recomputing ? "Recomputing…" : "↻ Recompute"}
            </button>
            <button className="ghost-btn" onClick={refresh} disabled={loading}>
              ⟳ Refresh
            </button>
            <button className="sources-btn alt" onClick={() => setMetricsOpen(true)}>
              ▦ Metrics
              <span className="sources-count">{visibleCount}</span>
            </button>
            <button className="sources-btn" onClick={() => setSourcesOpen(true)}>
              <span className="chip-dot" /> Sources
              <span className="sources-count">
                {includedCount}/{documents.length}
              </span>
            </button>
          </div>
        </div>

        {loading && <div className="dashboard-empty">Loading metrics…</div>}

        {!loading && !hasData && (
          <div className="welcome-card">
            <h2>No metrics yet</h2>
            <p>
              Upload department documents (P&amp;L statements, sales reports, HR
              summaries, marketing dashboards, ops logs, CSV/Excel data) and SNAP
              AI will extract the relevant metrics automatically.
            </p>
            <Link to="/ai" className="upload-btn">Upload Documents</Link>
          </div>
        )}

        {!loading && hasData && visibleCount === 0 && (
          <div className="welcome-card">
            <h2>No metrics selected</h2>
            <p>You've hidden every metric. Open the Metrics panel to choose what to display.</p>
            <button className="upload-btn" onClick={() => setMetricsOpen(true)}>
              Choose metrics
            </button>
          </div>
        )}

        {/* Granularity + period selector — never mixes annual/quarterly/monthly */}
        {!loading && hasData && visibleCount > 0 && availableGrans.length > 0 && (
          <div className="period-bar">
            <div className="segmented gran-segmented">
              {availableGrans.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={granularity === g ? "active" : ""}
                  onClick={() => setGranularity(g)}
                >
                  {GRAN_LABELS[g]}
                </button>
              ))}
            </div>

            <div className="currency-select period-select">
              <button className="chip period-btn" onClick={() => setPeriodOpen((o) => !o)}>
                📅 {periodLabel(selectedPeriod)} <span className="caret">▾</span>
              </button>
              {periodOpen && (
                <>
                  <div className="currency-backdrop" onClick={() => setPeriodOpen(false)} />
                  <div className="currency-menu period-menu">
                    {[...periodsByGran[granularity]].reverse().map((p) => (
                      <button
                        key={p}
                        className={p === selectedPeriod ? "active" : ""}
                        onClick={() => {
                          setSelectedPeriod(p);
                          setPeriodOpen(false);
                        }}
                      >
                        {periodLabel(p)}
                        {p === selectedPeriod && <span className="cur-check">✓</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>

            <span className="period-hint">
              {GRAN_LABELS[granularity]} figures · KPIs for {periodLabel(selectedPeriod)}, trends across all{" "}
              {GRAN_LABELS[granularity].toLowerCase()} periods
            </span>
          </div>
        )}

        {/* KPI cards grouped by department */}
        {!loading &&
          DEPARTMENTS.filter((d) => visibleByDept.has(d.id)).map((dept) => (
            <section className="dept-section" key={dept.id}>
              <div className="dept-heading">
                <span className="dept-icon" style={{ color: dept.color }}>{dept.icon}</span>
                <h2>{dept.label}</h2>
                <span className="dept-rule" style={{ background: dept.color }} />
              </div>
              <div className="kpi-row">
                {visibleByDept.get(dept.id).map((m) => {
                  const kpi = kpiFor(m.key);
                  const delta = kpi?.delta;
                  const kpiValue = kpi?.value;
                  const points = (granSeries[m.key] || []).map((p) => p.value);
                  const isActive = m.key === activeMetric;
                  const hasSeries = points.length > 1;
                  return (
                    <button
                      key={m.key}
                      type="button"
                      className={`kpi-card ${isActive ? "active" : ""} ${hasSeries ? "" : "static"}`}
                      style={isActive ? { "--accent": dept.color } : undefined}
                      onClick={() => hasSeries && setActiveMetric(m.key)}
                      disabled={!hasSeries}
                    >
                      <div className="kpi-top">
                        <span className="kpi-icon" style={{ color: dept.color }}>{dept.icon}</span>
                        <span className="kpi-label">{m.label}</span>
                      </div>
                      <span className="kpi-value">
                        {kpiValue != null
                          ? formatValue(kpiValue, m.kind, symbol, converting && m.kind === "currency")
                          : "—"}
                      </span>
                      <div className="kpi-bottom">
                        {delta != null ? (
                          <span className={`kpi-delta ${delta >= 0 ? "up" : "down"}`}>
                            {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%
                          </span>
                        ) : (
                          <span className="kpi-delta muted">
                            {kpiValue != null ? periodLabel(selectedPeriod) : "no data"}
                          </span>
                        )}
                        <Sparkline points={points} color={dept.color} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          ))}

        {/* Focused main chart with chart-type switcher */}
        {!loading && hasData && visibleCount > 0 && (
          <div className="focus-panel" style={{ "--accent": activeColor }}>
            <div className="focus-header">
              <div>
                <span className="focus-eyebrow" style={{ color: activeColor }}>
                  Focused metric{activeDept ? ` · ${DEPT_BY_ID[activeDept]?.label}` : ""}
                </span>
                <h2>{metricLabel(activeMetric)}</h2>
              </div>
              <div className="segmented">
                {CHART_TYPES.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    className={chartType === t.id ? "active" : ""}
                    onClick={() => setChartType(t.id)}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="focus-chart">
              {focusChart ? (
                <ChartBlock spec={focusChart} />
              ) : (
                <div className="dashboard-empty">
                  No periodised data for {metricLabel(activeMetric)} yet. Select a
                  metric card above with a trend line.
                </div>
              )}
            </div>
          </div>
        )}

        {/* Secondary chart grid */}
        {!loading && secondaryCharts.length > 0 && (
          <div className="dashboard-charts">
            {secondaryCharts.map((spec, i) => (
              <div className="chart-panel" key={i}>
                <ChartBlock spec={spec} />
              </div>
            ))}
          </div>
        )}

        {/* Pinned charts — generated in the AI Assistant and pinned by the user */}
        {!loading && pinnedCharts.length > 0 && (
          <section className="dept-section">
            <div className="dept-heading">
              <span className="dept-icon" style={{ color: "#8b5cf6" }}>📌</span>
              <h2>Pinned charts</h2>
              <span className="dept-rule" style={{ background: "#8b5cf6" }} />
            </div>
            <div className="dashboard-charts">
              {pinnedCharts.map((c) => (
                <div className="chart-panel" key={c.id}>
                  <ChartBlock spec={c.spec} onRemove={() => removePinnedChart(c.id)} />
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Metrics drawer — choose which metrics to display, by department */}
      <div
        className={`sources-overlay ${metricsOpen ? "open" : ""}`}
        onClick={() => setMetricsOpen(false)}
      />
      <aside className={`sources-drawer ${metricsOpen ? "open" : ""}`} aria-hidden={!metricsOpen}>
        <div className="drawer-header">
          <div>
            <h2>Metrics</h2>
            <span className="sources-hint">Choose what to display, by department</span>
          </div>
          <button className="drawer-close" onClick={() => setMetricsOpen(false)} aria-label="Close metrics">
            ✕
          </button>
        </div>

        <div className="metrics-groups">
          {DEPARTMENTS.map((dept) => (
            <div className="metric-group" key={dept.id}>
              <div className="metric-group-head">
                <span style={{ color: dept.color }}>{dept.icon}</span>
                <span>{dept.label}</span>
              </div>
              {METRIC_CATALOG.filter((m) => m.department === dept.id).map((m) => {
                const visible = isMetricVisible(m.key, prefs);
                const hasData = (series[m.key]?.length || 0) > 0 || kpis.some((k) => k.metric === m.key);
                return (
                  <label className="metric-row" key={m.key}>
                    <span className="metric-row-name">
                      {m.label}
                      <span className={`data-dot ${hasData ? "live" : ""}`} title={hasData ? "Has data" : "No data yet"} />
                    </span>
                    <span className="source-toggle">
                      <input
                        type="checkbox"
                        checked={visible}
                        onChange={(e) => toggleMetric(m.key, e.target.checked)}
                      />
                      <span className="switch" />
                    </span>
                  </label>
                );
              })}
            </div>
          ))}
        </div>
      </aside>

      {/* Data sources drawer */}
      <div
        className={`sources-overlay ${sourcesOpen ? "open" : ""}`}
        onClick={() => setSourcesOpen(false)}
      />
      <aside className={`sources-drawer ${sourcesOpen ? "open" : ""}`} aria-hidden={!sourcesOpen}>
        <div className="drawer-header">
          <div>
            <h2>Data sources</h2>
            <span className="sources-hint">Toggle which documents feed the charts</span>
          </div>
          <button className="drawer-close" onClick={() => setSourcesOpen(false)} aria-label="Close sources">
            ✕
          </button>
        </div>

        <div className="drawer-actions">
          <button
            className="ghost-btn"
            onClick={recompute}
            disabled={recomputing || documents.length === 0}
          >
            {recomputing ? "Recomputing…" : "↻ Recompute metrics"}
          </button>
        </div>

        {documents.length === 0 ? (
          <div className="dashboard-empty">No documents uploaded yet.</div>
        ) : (
          <div className="sources-list">
            {documents.map((doc) => (
              <div
                className={`source-row ${doc.included ? "included" : ""}`}
                key={doc.source_document}
              >
                <div className="source-info">
                  <span className="source-name">📄 {doc.source_document}</span>
                  <span className={`source-status ${doc.status}`}>{doc.status}</span>
                </div>
                <label className="source-toggle" title="Include this document's data in the dashboard">
                  <input
                    type="checkbox"
                    checked={doc.included}
                    onChange={(e) => toggleDocument(doc.source_document, e.target.checked)}
                  />
                  <span className="switch" />
                  <span className="switch-label">
                    {doc.included ? "Included" : "Excluded"}
                  </span>
                </label>
              </div>
            ))}
          </div>
        )}
      </aside>
    </div>
  );
}

export default Dashboard;
