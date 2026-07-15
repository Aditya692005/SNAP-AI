import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import Sidebar from "../../components/Sidebar";
import ChartBlock from "../ai/ChartBlock";
import { organizationService, authService } from "../../services/authService";
import "./Dashboard.css";

const API_BASE = import.meta.env.VITE_API_BASE_URL || "http://localhost:5000";

function authHeaders() {
  return { Authorization: `Bearer ${localStorage.getItem("token")}` };
}

// Format a KPI value by its kind (currency/percent/count/number).
function formatMetricValue(value, kind, currency) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  const n = Number(value);
  if (kind === "percent") return `${(Math.round(n * 100) / 100).toLocaleString()}%`;
  if (kind === "currency") {
    try {
      return n.toLocaleString(undefined, {
        style: "currency",
        currency: currency || "USD",
        maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
      });
    } catch {
      return n.toLocaleString();
    }
  }
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

// A metric key ("total_revenue") → a human label ("Total Revenue"), mirroring the
// backend's prettyLabel so a KPI card added to a department board reads the same
// as the auto-added personal ones.
function prettyMetricLabel(key) {
  return String(key || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Human-friendly period label for the granularity dropdown. Handles quarterly
// ("2024-Q1" → "Q1 2024"), monthly ("2024-03" → "Mar 2024") and plain years,
// falling back to the raw string for anything else.
function formatPeriod(period) {
  if (!period) return "";
  const p = String(period);
  const q = /^(\d{4})[-\s]?Q([1-4])$/i.exec(p);
  if (q) return `Q${q[2]} ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) {
    const mi = Number(m[2]) - 1;
    if (mi >= 0 && mi < 12) return `${MONTHS[mi]} ${m[1]}`;
  }
  return p;
}

// A KPI card widget. Reads its live value from the metrics payload by the
// widget's config.metric_key; renders "—" until data exists (a metric can be
// created before any document contains it).
//
// Time-bound metrics (e.g. royalties reported per quarter) carry a `series` of
// {period, value} points. By default the card shows the LATEST period (the
// KPI), but when more than one period exists the user can pick any quarter/year
// from a dropdown to see that period's value and its change vs the one before.
function MetricCard({ widget, metrics, onArchive }) {
  const key = widget.config?.metric_key;
  const label = widget.config?.label || widget.title || key;
  const kpi = (metrics?.kpis || []).find((k) => k.metric === key);
  const kind = kpi?.kind || widget.config?.kind;
  const series = metrics?.series?.[key] || []; // [{period, value}] chronological

  // null = "Latest" (the KPI). Otherwise a specific period string from `series`.
  const [period, setPeriod] = useState(null);

  // Resolve which point to display. For a chosen period, show its value and the
  // delta vs the preceding period; otherwise fall back to the KPI (latest).
  let value = kpi ? kpi.value : null;
  let shownPeriod = kpi?.period || null;
  let delta = kpi?.delta_pct ?? null;
  if (period != null && series.length) {
    const idx = series.findIndex((p) => p.period === period);
    const point = idx >= 0 ? series[idx] : null;
    const prev = idx > 0 ? series[idx - 1] : null;
    value = point ? point.value : null;
    shownPeriod = point ? point.period : period;
    delta =
      point && prev && prev.value !== 0
        ? ((point.value - prev.value) / Math.abs(prev.value)) * 100
        : null;
  }

  return (
    <div className="kpi-card-wrap">
      {onArchive && (
        <button
          type="button"
          className="kpi-remove"
          title="Remove this metric (moves it to Trash)"
          aria-label={`Remove ${label}`}
          onClick={() => onArchive(widget.id)}
        >
          ×
        </button>
      )}
      <div className="kpi-card">
        <div className="kpi-top">
          <span className="kpi-label">{label}</span>
          {series.length > 1 && (
            <select
              className="kpi-period-select"
              value={period ?? ""}
              onChange={(e) => setPeriod(e.target.value || null)}
              // Keep clicks on the dropdown from reaching the card / × button.
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              title="View a specific period"
            >
              <option value="">
                Latest{kpi?.period ? ` · ${formatPeriod(kpi.period)}` : ""}
              </option>
              {[...series].reverse().map((p) => (
                <option key={p.period} value={p.period}>
                  {formatPeriod(p.period)}
                </option>
              ))}
            </select>
          )}
        </div>
        <span className="kpi-value">
          {value != null ? formatMetricValue(value, kind, metrics?.currency) : "—"}
        </span>
        <div className="kpi-bottom">
          {delta != null ? (
            <span className={`kpi-delta ${delta >= 0 ? "up" : "down"}`}>
              {delta >= 0 ? "▲" : "▼"} {Math.abs(delta).toFixed(1)}%
              {shownPeriod ? <span className="kpi-period-tag"> · {formatPeriod(shownPeriod)}</span> : null}
            </span>
          ) : (
            <span className="kpi-delta muted">{formatPeriod(shownPeriod) || "no data yet"}</span>
          )}
        </div>
      </div>
    </div>
  );
}

// The personal dashboard is a board of charts the user pinned from the AI
// Assistant (widget_type "ai_chart"). Nothing is auto-added; a widget only
// appears when the user explicitly pins a chart. When a document is re-uploaded
// with new data, charts built from it are flagged stale (config.stale) and the
// user can refresh them on demand.
//
// A user can keep several dashboards to organise their pins. The one they last
// had open is remembered in localStorage so pinning from the AI Assistant lands
// on the same board.
const ACTIVE_KEY = "activeDashboardId";

function Dashboard() {
  const [dashboards, setDashboards] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [widgets, setWidgets] = useState([]);
  const [documents, setDocuments] = useState([]);
  const [org, setOrg] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshingId, setRefreshingId] = useState(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [creating, setCreating] = useState(false); // inline "new dashboard" input
  const [renaming, setRenaming] = useState(false); // inline rename of active board
  const [draftName, setDraftName] = useState("");
  const [addingMetric, setAddingMetric] = useState(false); // inline "add metric" input
  const [metricDraft, setMetricDraft] = useState("");
  const [metricError, setMetricError] = useState(null); // shown under the input on failure
  const [metrics, setMetrics] = useState(null); // personal live KPI numbers
  const [deptMetrics, setDeptMetrics] = useState(null); // department live KPI numbers
  const [deptAddingMetric, setDeptAddingMetric] = useState(false); // inline dept "add metric"
  const [deptMetricChoice, setDeptMetricChoice] = useState(""); // selected metric key to add
  const [deptMetricBusy, setDeptMetricBusy] = useState(false);
  const [deptMetricError, setDeptMetricError] = useState(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState([]); // archived widgets
  const [toast, setToast] = useState(null); // { widgets:[...], } auto-added notice

  // Department dashboards: shared boards scoped to a department. The server
  // decides which the user can see and whether they can edit (can_edit).
  const [scope, setScope] = useState("personal"); // "personal" | "department" | "organization"
  const [deptBoards, setDeptBoards] = useState([]);
  const [activeDeptId, setActiveDeptId] = useState(null);
  const [deptWidgets, setDeptWidgets] = useState([]);
  const [deptCanEdit, setDeptCanEdit] = useState(false);
  const [deptLoading, setDeptLoading] = useState(false);
  const [deptRefreshingId, setDeptRefreshingId] = useState(null);
  const [deptRenaming, setDeptRenaming] = useState(false);

  const deptActive = deptBoards.find((b) => b.id === activeDeptId) || null;

  // Organization dashboard: a single org-wide shared board (view-gated; editable
  // by org admins / MANAGE_ORGANIZATION_DASHBOARD holders).
  const canViewOrg = authService.canViewOrganizationDashboard();
  const [orgBoard, setOrgBoard] = useState(null); // { id, name, version, can_edit, updated_at }
  const [orgWidgets, setOrgWidgets] = useState([]);
  const [orgMetrics, setOrgMetrics] = useState(null);
  const [orgCanEdit, setOrgCanEdit] = useState(false);
  const [orgLoading, setOrgLoading] = useState(false);
  const [orgRefreshingId, setOrgRefreshingId] = useState(null);
  const [orgRenaming, setOrgRenaming] = useState(false);
  const [orgAddingMetric, setOrgAddingMetric] = useState(false);
  const [orgMetricChoice, setOrgMetricChoice] = useState("");
  const [orgMetricBusy, setOrgMetricBusy] = useState(false);
  const [orgMetricError, setOrgMetricError] = useState(null);

  useEffect(() => {
    loadDashboards();
    loadDepartmentBoards();
    if (canViewOrg) loadOrgBoard();
    refreshDocuments();
    organizationService.get().then(setOrg).catch(() => {});
  }, []);

  // Fetch this dashboard's widgets whenever the active board changes, and
  // remember the choice so the AI Assistant pins to the same board.
  useEffect(() => {
    if (!activeId) return;
    localStorage.setItem(ACTIVE_KEY, activeId);
    refreshWidgets(activeId);
  }, [activeId]);

  // Load the active department board's widgets whenever it changes.
  useEffect(() => {
    if (activeDeptId) refreshDeptWidgets(activeDeptId);
  }, [activeDeptId]);

  // Since there's no realtime, re-pull the active department board when the tab
  // regains focus — shrinks the window in which another editor's change (or the
  // re-upload stale flag) goes unseen before you act on it.
  useEffect(() => {
    if (scope !== "department" || !activeDeptId) return;
    const onFocus = () => refreshDeptWidgets(activeDeptId);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scope, activeDeptId]);

  // Load the org board's widgets/metrics once we know the board id.
  useEffect(() => {
    if (orgBoard?.id) refreshOrgWidgets();
  }, [orgBoard?.id]);

  // Re-pull the org board on focus (same reason as the department one above).
  useEffect(() => {
    if (scope !== "organization" || !orgBoard?.id) return;
    const onFocus = () => refreshOrgWidgets();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [scope, orgBoard?.id]);

  const active = dashboards.find((d) => d.id === activeId) || null;

  async function loadDashboards() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards`, { headers: authHeaders() });
      if (!res.ok) return;
      const list = (await res.json()).dashboards || [];
      setDashboards(list);
      const stored = localStorage.getItem(ACTIVE_KEY);
      const pick =
        list.find((d) => d.id === stored) || list.find((d) => d.is_default) || list[0];
      setActiveId(pick ? pick.id : null);
    } catch {
      // leave empty state
    }
  }

  async function refreshWidgets(id) {
    setLoading(true);
    try {
      const [wRes, mRes] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/widgets?dashboard_id=${id}`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/metrics`, { headers: authHeaders() }),
      ]);
      if (wRes.ok) setWidgets((await wRes.json()).widgets || []);
      if (mRes.ok) setMetrics(await mRes.json());
    } catch {
      // leave empty state
    } finally {
      setLoading(false);
    }
    loadTrash();
    checkRecentWidgets();
  }

  async function loadTrash() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets/trash`, { headers: authHeaders() });
      if (res.ok) setTrash((await res.json()).widgets || []);
    } catch {
      /* leave as-is */
    }
  }

  // Show a one-click-undo toast for metric widgets auto-added since we last looked
  // (e.g. after an upload discovered new metrics). `since` is remembered locally.
  async function checkRecentWidgets() {
    const key = "dashboardRecentSeen";
    const since = localStorage.getItem(key);
    try {
      const url = `${API_BASE}/api/dashboard/recent-widgets${since ? `?since=${encodeURIComponent(since)}` : ""}`;
      const res = await fetch(url, { headers: authHeaders() });
      if (!res.ok) return;
      const added = (await res.json()).widgets || [];
      localStorage.setItem(key, new Date().toISOString());
      if (added.length > 0 && since) setToast({ widgets: added });
    } catch {
      /* no toast on failure */
    }
  }

  async function refreshDocuments() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/documents`, { headers: authHeaders() });
      if (res.ok) setDocuments((await res.json()).documents || []);
    } catch {
      // leave empty state
    }
  }

  function refresh() {
    if (activeId) refreshWidgets(activeId);
    refreshDocuments();
  }

  async function createDashboard(name) {
    const clean = (name || "").trim();
    if (!clean) return;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean }),
      });
      if (!res.ok) throw new Error();
      const created = await res.json();
      setDashboards((prev) => [...prev, created]);
      setActiveId(created.id); // jump to the new board
      setCreating(false);
      setDraftName("");
    } catch {
      window.alert("Could not create the dashboard.");
    }
  }

  async function renameDashboard(d, name) {
    const clean = (name || "").trim();
    if (!clean || clean === d.name) {
      setRenaming(false);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards/${d.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean }),
      });
      if (!res.ok) throw new Error();
      const updated = await res.json();
      setDashboards((prev) => prev.map((x) => (x.id === d.id ? updated : x)));
      setRenaming(false);
    } catch {
      window.alert("Could not rename the dashboard.");
    }
  }

  async function deleteDashboard(d) {
    if (d.is_default) return;
    if (
      !window.confirm(`Delete "${d.name}"? Every chart pinned to it will be removed.`)
    ) {
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/dashboards/${d.id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      if (!res.ok) throw new Error();
      const remaining = dashboards.filter((x) => x.id !== d.id);
      setDashboards(remaining);
      if (activeId === d.id) {
        const fallback = remaining.find((x) => x.is_default) || remaining[0];
        setActiveId(fallback ? fallback.id : null);
      }
    } catch {
      window.alert("Could not delete the dashboard.");
    }
  }

  // The × on a widget sends it to the trash (soft delete), not gone for good.
  async function archiveWidget(id) {
    const prev = widgets;
    setWidgets((w) => w.filter((x) => x.id !== id));
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets/${id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ archived: true }),
      });
      if (!res.ok) throw new Error();
      loadTrash();
    } catch {
      setWidgets(prev); // restore on failure
    }
  }

  async function restoreWidget(id) {
    try {
      await fetch(`${API_BASE}/api/dashboard/widgets/${id}/archive`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ archived: false }),
      });
      setTrash((t) => t.filter((x) => x.id !== id));
      if (activeId) refreshWidgets(activeId);
    } catch {
      /* resync on next load */
    }
  }

  async function purgeWidget(id, label) {
    if (!window.confirm(`Permanently delete "${label}"? This can't be undone.`)) return;
    try {
      await fetch(`${API_BASE}/api/dashboard/widgets/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      setTrash((t) => t.filter((x) => x.id !== id));
    } catch {
      /* resync on next load */
    }
  }

  // Undo an auto-add notice: trash every widget it added.
  async function undoRecent(added) {
    setToast(null);
    await Promise.all(
      added.map((w) =>
        fetch(`${API_BASE}/api/dashboard/widgets/${w.id}/archive`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ archived: true }),
        }).catch(() => {})
      )
    );
    if (activeId) refreshWidgets(activeId);
  }

  // Create a metric from the inline input. Kept off window.prompt() on purpose —
  // browsers silently suppress prompt() in many contexts, which made the button
  // look dead. The inline <input> below drives this instead.
  async function submitMetric() {
    const label = metricDraft.trim();
    if (!label) {
      setAddingMetric(false);
      setMetricError(null);
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/metric-definitions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        // Pin the metric card to the board the user is looking at, not the
        // default board (otherwise it lands out of sight on non-default boards).
        body: JSON.stringify({ label, dashboard_id: activeId }),
      });
      if (!res.ok) throw new Error();
      setMetricDraft("");
      setAddingMetric(false);
      setMetricError(null);
      if (activeId) refreshWidgets(activeId);
    } catch {
      setMetricError("Could not create the metric. Please try again.");
    }
  }

  // Regenerate one stale chart against the latest data (reruns the LLM server-side).
  async function refreshWidget(id) {
    setRefreshingId(id);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/widgets/${id}/refresh`, {
        method: "POST",
        headers: authHeaders(),
      });
      if (res.ok) {
        const updated = await res.json();
        setWidgets((w) => w.map((x) => (x.id === id ? updated : x)));
      }
    } catch {
      // leave the widget as-is (still marked stale) on failure
    } finally {
      setRefreshingId(null);
    }
  }

  // ── Department dashboards ────────────────────────────────────────────────────
  async function loadDepartmentBoards() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department`, { headers: authHeaders() });
      if (!res.ok) return;
      const list = (await res.json()).dashboards || [];
      setDeptBoards(list);
      // Default to the user's editable board if they have one, else the first.
      setActiveDeptId((cur) => cur || (list.find((b) => b.can_edit) || list[0])?.id || null);
    } catch {
      // no department boards visible — the switcher stays hidden
    }
  }

  async function refreshDeptWidgets(id) {
    setDeptLoading(true);
    try {
      const [res, mRes] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/department/${id}/widgets`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/department/${id}/metrics`, { headers: authHeaders() }),
      ]);
      if (mRes.ok) setDeptMetrics(await mRes.json());
      if (res.ok) {
        const data = await res.json();
        setDeptWidgets(data.widgets || []);
        setDeptCanEdit(!!data.can_edit);
        // Keep the board's version (for rename) in step with the server.
        setDeptBoards((prev) =>
          prev.map((b) => (b.id === id ? { ...b, version: data.version, can_edit: data.can_edit } : b))
        );
      }
    } catch {
      // leave as-is
    } finally {
      setDeptLoading(false);
    }
  }

  // A shared board changed underneath us (409). Tell the user and re-pull.
  function handleDeptConflict() {
    window.alert("This board was just changed by someone else — reloading the latest version.");
    if (activeDeptId) refreshDeptWidgets(activeDeptId);
  }

  async function removeDeptWidget(w) {
    if (!window.confirm("Remove this from the department dashboard?")) return;
    const prev = deptWidgets;
    setDeptWidgets((list) => list.filter((x) => x.id !== w.id));
    try {
      const res = await fetch(
        `${API_BASE}/api/dashboard/department/widgets/${w.id}?expected_version=${w.version}`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.status === 409) {
        setDeptWidgets(prev);
        handleDeptConflict();
      } else if (!res.ok) {
        setDeptWidgets(prev);
      }
    } catch {
      setDeptWidgets(prev);
    }
  }

  async function refreshDeptWidget(w) {
    setDeptRefreshingId(w.id);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/widgets/${w.id}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ expected_version: w.version }),
      });
      if (res.status === 409) {
        handleDeptConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setDeptWidgets((list) => list.map((x) => (x.id === w.id ? updated : x)));
      }
    } catch {
      // leave stale on failure
    } finally {
      setDeptRefreshingId(null);
    }
  }

  async function renameDeptBoard(board, name) {
    const clean = (name || "").trim();
    setDeptRenaming(false);
    if (!clean || clean === board.name) return;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/${board.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean, expected_version: board.version }),
      });
      if (res.status === 409) {
        handleDeptConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setDeptBoards((prev) => prev.map((b) => (b.id === board.id ? { ...b, ...updated } : b)));
      }
    } catch {
      // leave name as-is
    }
  }

  // Add a KPI card to the department board. Unlike the personal "add metric"
  // (free-text → definition + backfill), a shared board offers only metrics
  // already present in the department's shared documents, so the card is never
  // empty and no per-user definition/backfill is needed. Edit-gated server-side.
  async function addDeptMetric() {
    const key = deptMetricChoice;
    if (!key || !activeDeptId) return;
    const kpi = (deptMetrics?.kpis || []).find((k) => k.metric === key);
    if (!kpi) return;
    const label = prettyMetricLabel(key);
    setDeptMetricBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/department/${activeDeptId}/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          widget_type: "metric",
          title: label,
          config: { metric_key: key, kind: kpi.kind || "number", label },
        }),
      });
      if (!res.ok) throw new Error();
      setDeptAddingMetric(false);
      setDeptMetricChoice("");
      setDeptMetricError(null);
      refreshDeptWidgets(activeDeptId); // re-pull widgets + board version
    } catch {
      setDeptMetricError("Could not add the metric. Please try again.");
    } finally {
      setDeptMetricBusy(false);
    }
  }

  // ── Organization dashboard ───────────────────────────────────────────────────
  async function loadOrgBoard() {
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/organization`, { headers: authHeaders() });
      if (!res.ok) return; // 403 → not a viewer; the Organization tab stays hidden
      const data = await res.json();
      setOrgBoard(data.dashboard || null);
    } catch {
      // org board unavailable — tab stays hidden
    }
  }

  async function refreshOrgWidgets() {
    setOrgLoading(true);
    try {
      const [res, mRes] = await Promise.all([
        fetch(`${API_BASE}/api/dashboard/organization/widgets`, { headers: authHeaders() }),
        fetch(`${API_BASE}/api/dashboard/organization/metrics`, { headers: authHeaders() }),
      ]);
      if (mRes.ok) setOrgMetrics(await mRes.json());
      if (res.ok) {
        const data = await res.json();
        setOrgWidgets(data.widgets || []);
        setOrgCanEdit(!!data.can_edit);
        // Keep the board's version (for rename) in step with the server.
        setOrgBoard((prev) => (prev ? { ...prev, version: data.version, can_edit: data.can_edit } : prev));
      }
    } catch {
      // leave as-is
    } finally {
      setOrgLoading(false);
    }
  }

  function handleOrgConflict() {
    window.alert("This board was just changed by someone else — reloading the latest version.");
    refreshOrgWidgets();
  }

  async function removeOrgWidget(w) {
    if (!window.confirm("Remove this from the organization dashboard?")) return;
    const prev = orgWidgets;
    setOrgWidgets((list) => list.filter((x) => x.id !== w.id));
    try {
      const res = await fetch(
        `${API_BASE}/api/dashboard/organization/widgets/${w.id}?expected_version=${w.version}`,
        { method: "DELETE", headers: authHeaders() }
      );
      if (res.status === 409) {
        setOrgWidgets(prev);
        handleOrgConflict();
      } else if (!res.ok) {
        setOrgWidgets(prev);
      }
    } catch {
      setOrgWidgets(prev);
    }
  }

  async function refreshOrgWidget(w) {
    setOrgRefreshingId(w.id);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/organization/widgets/${w.id}/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ expected_version: w.version }),
      });
      if (res.status === 409) {
        handleOrgConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setOrgWidgets((list) => list.map((x) => (x.id === w.id ? updated : x)));
      }
    } catch {
      // leave stale on failure
    } finally {
      setOrgRefreshingId(null);
    }
  }

  async function renameOrgBoard(name) {
    const clean = (name || "").trim();
    setOrgRenaming(false);
    if (!orgBoard || !clean || clean === orgBoard.name) return;
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/organization`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ name: clean, expected_version: orgBoard.version }),
      });
      if (res.status === 409) {
        handleOrgConflict();
      } else if (res.ok) {
        const updated = await res.json();
        setOrgBoard((prev) => (prev ? { ...prev, ...updated } : prev));
      }
    } catch {
      // leave name as-is
    }
  }

  // Add a KPI card to the org board from a metric already present in the org's
  // data (same rationale as the department "add metric"). Edit-gated server-side.
  async function addOrgMetric() {
    const key = orgMetricChoice;
    if (!key || !orgBoard) return;
    const kpi = (orgMetrics?.kpis || []).find((k) => k.metric === key);
    if (!kpi) return;
    const label = prettyMetricLabel(key);
    setOrgMetricBusy(true);
    try {
      const res = await fetch(`${API_BASE}/api/dashboard/organization/widgets`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          widget_type: "metric",
          title: label,
          config: { metric_key: key, kind: kpi.kind || "number", label },
        }),
      });
      if (!res.ok) throw new Error();
      setOrgAddingMetric(false);
      setOrgMetricChoice("");
      setOrgMetricError(null);
      refreshOrgWidgets();
    } catch {
      setOrgMetricError("Could not add the metric. Please try again.");
    } finally {
      setOrgMetricBusy(false);
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
    } catch {
      setDocuments((prev) =>
        prev.map((d) => (d.source_document === source ? { ...d, included: !included } : d))
      );
    }
  }

  async function removeDocument(source) {
    if (
      !window.confirm(
        `Remove "${source}" from the dashboard? Its extracted data will be deleted.`
      )
    ) {
      return;
    }
    const prevDocs = documents;
    setDocuments((prev) => prev.filter((d) => d.source_document !== source));
    try {
      await fetch(`${API_BASE}/api/dashboard/documents/${encodeURIComponent(source)}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
    } catch {
      setDocuments(prevDocs); // restore on failure
    }
  }

  const includedCount = documents.filter((d) => d.included).length;

  // Metrics present in the department's shared data that aren't already a card on
  // the board — the choices offered by the department "Add metric" control.
  const deptMetricKeysOnBoard = new Set(
    deptWidgets.filter((w) => w.widget_type === "metric").map((w) => w.config?.metric_key)
  );
  const availableDeptMetrics = (deptMetrics?.kpis || []).filter(
    (k) => k.metric && !deptMetricKeysOnBoard.has(k.metric)
  );

  // Same, for the organization board.
  const orgMetricKeysOnBoard = new Set(
    orgWidgets.filter((w) => w.widget_type === "metric").map((w) => w.config?.metric_key)
  );
  const availableOrgMetrics = (orgMetrics?.kpis || []).filter(
    (k) => k.metric && !orgMetricKeysOnBoard.has(k.metric)
  );
  // The Organization scope is offered once the user can view the board and it loaded.
  const showOrgScope = canViewOrg && !!orgBoard;

  return (
    <div className="dashboard">
      {/* Full-width top bar. It sits ABOVE the sidebar so it spans the whole
          window and never shrinks when the sidebar expands. */}
      <div className="dashboard-topbar">
        <span className="topbar-company">{org?.name || "Company"}</span>
        <span className="topbar-brand">SNAP AI</span>
        <div className="topbar-actions">
          <button className="ghost-btn" onClick={refresh} disabled={loading}>
            ⟳ Refresh
          </button>
          <button className="sources-btn" onClick={() => setSourcesOpen(true)}>
            <span className="chip-dot" /> Sources
            <span className="sources-count">
              {includedCount}/{documents.length}
            </span>
          </button>
        </div>
      </div>

      <div className="dashboard-shell">
        <Sidebar />

        <main className="dashboard-content">

        {/* Create + scope switch. Clicking a scope reveals that scope's list of
            dashboard names in the row below. */}
        <div className="dashboard-controls">
          <button
            className="control-btn"
            onClick={() => {
              setScope("personal");
              setDraftName("");
              setCreating(true);
            }}
          >
            ＋ Create new dashboard
          </button>
          <div className="scope-group">
            {showOrgScope && (
              <button
                className={`scope-btn ${scope === "organization" ? "active" : ""}`}
                onClick={() => setScope("organization")}
              >
                Organization
              </button>
            )}
            {deptBoards.length > 0 && (
              <button
                className={`scope-btn ${scope === "department" ? "active" : ""}`}
                onClick={() => setScope("department")}
              >
                Department
              </button>
            )}
            <button
              className={`scope-btn ${scope === "personal" ? "active" : ""}`}
              onClick={() => setScope("personal")}
            >
              Personal
            </button>
          </div>
        </div>

        <div className="dashboard-body">
          <div className="dashboard-main-col">

        {scope === "personal" && (
          <>
        {/* Dashboard tabs — switch between the user's personal dashboards */}
        <div className="dashboard-tabs">
          {dashboards.map((d) => (
            <button
              key={d.id}
              className={`dash-tab ${d.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(d.id)}
            >
              <span className="dash-tab-name">{d.name}</span>
              {d.is_default && <span className="dash-tab-badge">default</span>}
            </button>
          ))}

          {creating && (
            <input
              className="dash-tab-input"
              autoFocus
              placeholder="Dashboard name…"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") createDashboard(draftName);
                if (e.key === "Escape") {
                  setCreating(false);
                  setDraftName("");
                }
              }}
              onBlur={() => {
                setCreating(false);
                setDraftName("");
              }}
            />
          )}
        </div>

        {active && (
          <div className="dashboard-board-actions">
            {renaming ? (
              <input
                className="dash-rename-input"
                autoFocus
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") renameDashboard(active, draftName);
                  if (e.key === "Escape") setRenaming(false);
                }}
                onBlur={() => renameDashboard(active, draftName)}
              />
            ) : (
              <button
                className="ghost-btn small"
                onClick={() => {
                  setDraftName(active.name);
                  setRenaming(true);
                }}
              >
                ✎ Rename
              </button>
            )}
            {!active.is_default && !renaming && (
              <button
                className="ghost-btn small danger"
                onClick={() => deleteDashboard(active)}
              >
                🗑 Delete
              </button>
            )}
            {addingMetric ? (
              <span className="add-metric-inline">
                <input
                  className="dash-rename-input"
                  autoFocus
                  placeholder="Metric name (e.g. Customer Churn)…"
                  value={metricDraft}
                  onChange={(e) => {
                    setMetricDraft(e.target.value);
                    if (metricError) setMetricError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitMetric();
                    if (e.key === "Escape") {
                      setAddingMetric(false);
                      setMetricDraft("");
                      setMetricError(null);
                    }
                  }}
                />
                <button className="ghost-btn small" onClick={submitMetric}>
                  Add
                </button>
                {metricError && <span className="add-metric-error">{metricError}</span>}
              </span>
            ) : (
              <button
                className="ghost-btn small"
                onClick={() => {
                  setMetricDraft("");
                  setMetricError(null);
                  setAddingMetric(true);
                }}
              >
                ＋ Add metric
              </button>
            )}
            {trash.length > 0 && (
              <button className="ghost-btn small" onClick={() => setTrashOpen(true)}>
                🗑 Trash <span className="sources-count">{trash.length}</span>
              </button>
            )}
          </div>
        )}

        {loading && <div className="dashboard-empty">Loading dashboard…</div>}

        {!loading && widgets.length === 0 && (
          <div className="welcome-card">
            <h2>Nothing on this dashboard yet</h2>
            <p>
              Upload documents (metric cards appear automatically), add a metric to
              track, or pin a chart from the AI Assistant.
            </p>
            <Link to="/ai" className="upload-btn">Open AI Assistant</Link>
          </div>
        )}

        {/* Metric KPI cards */}
        {!loading && widgets.some((w) => w.widget_type === "metric") && (
          <div className="kpi-row">
            {widgets
              .filter((w) => w.widget_type === "metric")
              .map((w) => (
                <MetricCard key={w.id} widget={w} metrics={metrics} onArchive={archiveWidget} />
              ))}
          </div>
        )}

        {/* Pinned charts */}
        {!loading && widgets.some((w) => w.widget_type === "ai_chart") && (
          <div className="dashboard-charts">
            {widgets
              .filter((w) => w.widget_type === "ai_chart")
              .map((w) => {
                const spec = w.config?.spec;
                const stale = !!w.config?.stale;
                if (!spec) return null;
                return (
                  <div className={`chart-panel ${stale ? "stale" : ""}`} key={w.id}>
                    {stale && (
                      <div className="widget-stale-bar">
                        <span>
                          ⚠ The source document changed — this chart may be out of date.
                        </span>
                        <button
                          className="ghost-btn small"
                          onClick={() => refreshWidget(w.id)}
                          disabled={refreshingId === w.id}
                        >
                          {refreshingId === w.id ? "Refreshing…" : "↻ Refresh"}
                        </button>
                      </div>
                    )}
                    <ChartBlock spec={spec} onRemove={() => archiveWidget(w.id)} />
                  </div>
                );
              })}
          </div>
        )}
          </>
        )}

        {/* Department dashboards — shared, read-only unless you can edit */}
        {scope === "department" && (
          <>
            <div className="dashboard-tabs">
              {deptBoards.map((b) => (
                <button
                  key={b.id}
                  className={`dash-tab ${b.id === activeDeptId ? "active" : ""}`}
                  onClick={() => setActiveDeptId(b.id)}
                >
                  <span className="dash-tab-name">{b.department_name}</span>
                  {!b.can_edit && <span className="dash-tab-badge">view</span>}
                </button>
              ))}
            </div>

            {deptActive && (
              <div className="dashboard-board-actions">
                {deptActive.can_edit && !deptRenaming && (
                  <button
                    className="ghost-btn small"
                    onClick={() => {
                      setDraftName(deptActive.name);
                      setDeptRenaming(true);
                    }}
                  >
                    ✎ Rename
                  </button>
                )}
                {deptActive.can_edit && deptRenaming && (
                  <input
                    className="dash-rename-input"
                    autoFocus
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") renameDeptBoard(deptActive, draftName);
                      if (e.key === "Escape") setDeptRenaming(false);
                    }}
                    onBlur={() => renameDeptBoard(deptActive, draftName)}
                  />
                )}
                {/* Add a KPI card — only metrics found in this department's shared
                    documents, so the card always resolves to a real number. */}
                {deptActive.can_edit &&
                  (deptAddingMetric ? (
                    <span className="add-metric-inline">
                      <select
                        className="dash-rename-input"
                        autoFocus
                        value={deptMetricChoice}
                        onChange={(e) => {
                          setDeptMetricChoice(e.target.value);
                          if (deptMetricError) setDeptMetricError(null);
                        }}
                      >
                        <option value="">Choose a metric…</option>
                        {availableDeptMetrics.map((k) => (
                          <option key={k.metric} value={k.metric}>
                            {prettyMetricLabel(k.metric)}
                          </option>
                        ))}
                      </select>
                      <button
                        className="ghost-btn small"
                        onClick={addDeptMetric}
                        disabled={!deptMetricChoice || deptMetricBusy}
                      >
                        {deptMetricBusy ? "Adding…" : "Add"}
                      </button>
                      <button
                        className="ghost-btn small"
                        onClick={() => {
                          setDeptAddingMetric(false);
                          setDeptMetricChoice("");
                          setDeptMetricError(null);
                        }}
                      >
                        Cancel
                      </button>
                      {deptMetricError && <span className="add-metric-error">{deptMetricError}</span>}
                    </span>
                  ) : (
                    <button
                      className="ghost-btn small"
                      onClick={() => {
                        setDeptMetricChoice("");
                        setDeptMetricError(null);
                        setDeptAddingMetric(true);
                      }}
                      disabled={availableDeptMetrics.length === 0}
                      title={
                        availableDeptMetrics.length === 0
                          ? "No metrics found in this department's shared documents yet"
                          : "Add a KPI card from this department's data"
                      }
                    >
                      ＋ Add metric
                    </button>
                  ))}
                {!deptActive.can_edit && (
                  <span className="dash-readonly-hint">
                    View only — managed by this department’s manager
                  </span>
                )}
                {deptActive.updated_at && (
                  <span className="dash-updated-hint">
                    Last updated {new Date(deptActive.updated_at).toLocaleDateString()}
                  </span>
                )}
              </div>
            )}

            {deptLoading && <div className="dashboard-empty">Loading dashboard…</div>}

            {!deptLoading && deptWidgets.length === 0 && (
              <div className="welcome-card">
                <h2>Nothing on this department dashboard yet</h2>
                <p>
                  {deptCanEdit
                    ? "Add a metric card from this department's data above, or ask the AI Assistant for a chart and pin it to this board."
                    : "Your department manager hasn’t added anything here yet."}
                </p>
                {deptCanEdit && (
                  <Link to="/ai" className="upload-btn">Open AI Assistant</Link>
                )}
              </div>
            )}

            {/* Department metric KPI cards (removal is manager-only, versioned) */}
            {!deptLoading && deptWidgets.some((w) => w.widget_type === "metric") && (
              <div className="kpi-row">
                {deptWidgets
                  .filter((w) => w.widget_type === "metric")
                  .map((w) => (
                    <MetricCard
                      key={w.id}
                      widget={w}
                      metrics={deptMetrics}
                      onArchive={deptCanEdit ? () => removeDeptWidget(w) : undefined}
                    />
                  ))}
              </div>
            )}

            {!deptLoading && deptWidgets.some((w) => w.widget_type === "ai_chart") && (
              <div className="dashboard-charts">
                {deptWidgets
                  .filter((w) => w.widget_type === "ai_chart")
                  .map((w) => {
                    const spec = w.config?.spec;
                    const stale = !!w.config?.stale;
                    if (!spec) return null;
                    return (
                      <div className={`chart-panel ${stale ? "stale" : ""}`} key={w.id}>
                        {stale && (
                          <div className="widget-stale-bar">
                            <span>
                              ⚠ The source document changed — this chart may be out of date.
                            </span>
                            {deptCanEdit && (
                              <button
                                className="ghost-btn small"
                                onClick={() => refreshDeptWidget(w)}
                                disabled={deptRefreshingId === w.id}
                              >
                                {deptRefreshingId === w.id ? "Refreshing…" : "↻ Refresh"}
                              </button>
                            )}
                          </div>
                        )}
                        <ChartBlock
                          spec={spec}
                          onRemove={deptCanEdit ? () => removeDeptWidget(w) : undefined}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}

        {/* Organization dashboard — one shared org-wide board, read-only unless
            you're an admin (or hold MANAGE_ORGANIZATION_DASHBOARD). */}
        {scope === "organization" && orgBoard && (
          <>
            <div className="dashboard-tabs">
              <button className="dash-tab active" type="button">
                <span className="dash-tab-name">{orgBoard.name}</span>
                {!orgBoard.can_edit && <span className="dash-tab-badge">view</span>}
              </button>
            </div>

            <div className="dashboard-board-actions">
              {orgBoard.can_edit && !orgRenaming && (
                <button
                  className="ghost-btn small"
                  onClick={() => {
                    setDraftName(orgBoard.name);
                    setOrgRenaming(true);
                  }}
                >
                  ✎ Rename
                </button>
              )}
              {orgBoard.can_edit && orgRenaming && (
                <input
                  className="dash-rename-input"
                  autoFocus
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") renameOrgBoard(draftName);
                    if (e.key === "Escape") setOrgRenaming(false);
                  }}
                  onBlur={() => renameOrgBoard(draftName)}
                />
              )}
              {/* Add a KPI card — only metrics found in the organization's data. */}
              {orgBoard.can_edit &&
                (orgAddingMetric ? (
                  <span className="add-metric-inline">
                    <select
                      className="dash-rename-input"
                      autoFocus
                      value={orgMetricChoice}
                      onChange={(e) => {
                        setOrgMetricChoice(e.target.value);
                        if (orgMetricError) setOrgMetricError(null);
                      }}
                    >
                      <option value="">Choose a metric…</option>
                      {availableOrgMetrics.map((k) => (
                        <option key={k.metric} value={k.metric}>
                          {prettyMetricLabel(k.metric)}
                        </option>
                      ))}
                    </select>
                    <button
                      className="ghost-btn small"
                      onClick={addOrgMetric}
                      disabled={!orgMetricChoice || orgMetricBusy}
                    >
                      {orgMetricBusy ? "Adding…" : "Add"}
                    </button>
                    <button
                      className="ghost-btn small"
                      onClick={() => {
                        setOrgAddingMetric(false);
                        setOrgMetricChoice("");
                        setOrgMetricError(null);
                      }}
                    >
                      Cancel
                    </button>
                    {orgMetricError && <span className="add-metric-error">{orgMetricError}</span>}
                  </span>
                ) : (
                  <button
                    className="ghost-btn small"
                    onClick={() => {
                      setOrgMetricChoice("");
                      setOrgMetricError(null);
                      setOrgAddingMetric(true);
                    }}
                    disabled={availableOrgMetrics.length === 0}
                    title={
                      availableOrgMetrics.length === 0
                        ? "No metrics found in your organization's documents yet"
                        : "Add a KPI card from your organization's data"
                    }
                  >
                    ＋ Add metric
                  </button>
                ))}
              {!orgBoard.can_edit && (
                <span className="dash-readonly-hint">
                  View only — managed by your organization admins
                </span>
              )}
              {orgBoard.updated_at && (
                <span className="dash-updated-hint">
                  Last updated {new Date(orgBoard.updated_at).toLocaleDateString()}
                </span>
              )}
            </div>

            {orgLoading && <div className="dashboard-empty">Loading dashboard…</div>}

            {!orgLoading && orgWidgets.length === 0 && (
              <div className="welcome-card">
                <h2>Nothing on the organization dashboard yet</h2>
                <p>
                  {orgCanEdit
                    ? "Add a metric card from your organization's data above, or ask the AI Assistant for a chart and pin it to this board."
                    : "Your organization admins haven’t added anything here yet."}
                </p>
                {orgCanEdit && (
                  <Link to="/ai" className="upload-btn">Open AI Assistant</Link>
                )}
              </div>
            )}

            {/* Organization metric KPI cards (removal is admin-only, versioned) */}
            {!orgLoading && orgWidgets.some((w) => w.widget_type === "metric") && (
              <div className="kpi-row">
                {orgWidgets
                  .filter((w) => w.widget_type === "metric")
                  .map((w) => (
                    <MetricCard
                      key={w.id}
                      widget={w}
                      metrics={orgMetrics}
                      onArchive={orgCanEdit ? () => removeOrgWidget(w) : undefined}
                    />
                  ))}
              </div>
            )}

            {!orgLoading && orgWidgets.some((w) => w.widget_type === "ai_chart") && (
              <div className="dashboard-charts">
                {orgWidgets
                  .filter((w) => w.widget_type === "ai_chart")
                  .map((w) => {
                    const spec = w.config?.spec;
                    const stale = !!w.config?.stale;
                    if (!spec) return null;
                    return (
                      <div className={`chart-panel ${stale ? "stale" : ""}`} key={w.id}>
                        {stale && (
                          <div className="widget-stale-bar">
                            <span>
                              ⚠ The source document changed — this chart may be out of date.
                            </span>
                            {orgCanEdit && (
                              <button
                                className="ghost-btn small"
                                onClick={() => refreshOrgWidget(w)}
                                disabled={orgRefreshingId === w.id}
                              >
                                {orgRefreshingId === w.id ? "Refreshing…" : "↻ Refresh"}
                              </button>
                            )}
                          </div>
                        )}
                        <ChartBlock
                          spec={spec}
                          onRemove={orgCanEdit ? () => removeOrgWidget(w) : undefined}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </>
        )}
          </div>

          {/* Updates: notifications about shared files and new dashboard
              widgets/metrics/charts. Wired up in a later pass. */}
          <aside className="updates-col">
            <p className="updates-title">Updates</p>
            <div className="updates-panel">
              <p className="updates-empty">
                Notifications about files shared with you and new widgets,
                metrics or charts added to your organization or department
                dashboards will show up here.
              </p>
            </div>
          </aside>
        </div>
      </main>
      </div>

      {/* Data sources drawer */}
      <div
        className={`sources-overlay ${sourcesOpen ? "open" : ""}`}
        onClick={() => setSourcesOpen(false)}
      />
      <aside className={`sources-drawer ${sourcesOpen ? "open" : ""}`} aria-hidden={!sourcesOpen}>
        <div className="drawer-header">
          <div>
            <h2>Data sources</h2>
            <span className="sources-hint">Documents available to the AI &amp; dashboard</span>
          </div>
          <button className="drawer-close" onClick={() => setSourcesOpen(false)} aria-label="Close sources">
            ✕
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
                <div className="source-actions">
                  <label className="source-toggle" title="Include this document's data">
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
                  <button
                    type="button"
                    className="source-remove"
                    title="Remove this document"
                    onClick={() => removeDocument(doc.source_document)}
                  >
                    🗑 Remove
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </aside>

      {/* Trash drawer — removed widgets: restore or delete permanently */}
      <div className={`sources-overlay ${trashOpen ? "open" : ""}`} onClick={() => setTrashOpen(false)} />
      <aside className={`sources-drawer ${trashOpen ? "open" : ""}`} aria-hidden={!trashOpen}>
        <div className="drawer-header">
          <div>
            <h2>Trash</h2>
            <span className="sources-hint">Restore a widget or delete it permanently</span>
          </div>
          <button className="drawer-close" onClick={() => setTrashOpen(false)} aria-label="Close trash">
            ✕
          </button>
        </div>
        {trash.length === 0 ? (
          <div className="dashboard-empty">Trash is empty.</div>
        ) : (
          <div className="sources-list">
            {trash.map((w) => {
              const label =
                w.widget_type === "metric"
                  ? w.config?.label || w.config?.metric_key
                  : w.title || w.config?.spec?.title || "Chart";
              return (
                <div className="source-row" key={w.id}>
                  <div className="source-info">
                    <span className="source-name">
                      {w.widget_type === "metric" ? "📊" : "📈"} {label}
                    </span>
                  </div>
                  <div className="source-actions">
                    <button type="button" className="ghost-btn small" onClick={() => restoreWidget(w.id)}>
                      ↩ Restore
                    </button>
                    <button
                      type="button"
                      className="ghost-btn small danger"
                      onClick={() => purgeWidget(w.id, label)}
                    >
                      🗑 Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </aside>

      {/* Auto-added metrics notice with one-click undo */}
      {toast && (
        <div className="dashboard-toast">
          <span>
            Added {toast.widgets.length} metric{toast.widgets.length > 1 ? "s" : ""} to your
            dashboard: {toast.widgets.map((w) => w.config?.label || w.config?.metric_key).join(", ")}
          </span>
          <button className="toast-undo" onClick={() => undoRecent(toast.widgets)}>
            Undo
          </button>
          <button className="toast-dismiss" onClick={() => setToast(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
