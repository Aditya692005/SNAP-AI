// backend/src/routes/dashboardRoutes.js
//
// Dashboard metrics API. Reads metrics extracted from uploaded documents
// (stored in Supabase) and shapes them into KPIs / chart series for the UI.
// Mount in server.js:  app.use("/api/dashboard", dashboardRoutes);

const express = require("express");
const fetch = require("node-fetch");

const requireAuth = require("../middleware/requireAuth");
const {
  getIncludedMetrics,
  getMetricsForDocumentIds,
  listStatuses,
  setIncluded,
  deleteDocument,
} = require("../models/metricsModel");
const {
  getOrCreateDefaultDashboard,
  listDashboards,
  createDashboard,
  getDashboardForUser,
  renameDashboard,
  deleteDashboard,
  listWidgets,
  listArchivedWidgetsForUser,
  listRecentMetricWidgetsForUser,
  findWidgetByMessage,
  findMetricWidget,
  metricKeysOnDashboard,
  setWidgetArchived,
  getWidgetForUser,
  addWidget,
  updateWidget,
  deleteWidget,
} = require("../models/dashboardModel");
const {
  listMetricDefinitions,
  createMetricDefinition,
  deleteMetricDefinition,
} = require("../models/metricDefinitionsModel");
const { extractAndStore } = require("../services/metricsService");
const {
  findByFileName: findDocByName,
  deleteDocument: deleteDocumentRow,
  listUploadedFileNames,
  documentIdsForDepartment,
} = require("../models/documentModel");
const { listDepartments } = require("../models/departmentModel");
const {
  getOrCreateDefaultDepartmentDashboard,
  listDefaultDashboardsByDepartmentIds,
  getDepartmentDashboard,
  listDepartmentWidgets,
  findWidgetByMessage: findDeptWidgetByMessage,
  findMetricWidget: findDeptMetricWidget,
  addDepartmentWidget,
  getWidgetOwner,
  updateWidgetVersioned,
  deleteWidgetVersioned,
  renameDepartmentDashboardVersioned,
  touchBoard,
} = require("../models/departmentDashboardModel");
const {
  isAdmin,
  viewableDepartmentIds,
  canViewDepartmentBoard,
  canEditDepartmentBoard,
} = require("../services/departmentDashboardAccess");
const {
  refreshWidget,
  refreshDepartmentWidget,
} = require("../services/widgetRefreshService");

const router = express.Router();
const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// Turn a period label ("2024", "2024-03", "2024-Q2") into a sortable number.
function periodKey(period) {
  if (!period) return -1;
  const year = parseInt(String(period).slice(0, 4), 10) || 0;
  const q = /Q([1-4])/i.exec(period);
  if (q) return year * 100 + (Number(q[1]) - 1) * 3 + 1;
  const m = /^\d{4}-(\d{2})/.exec(period);
  if (m) return year * 100 + Number(m[1]);
  return year * 100;
}

// Aggregate a set of values for one metric by its `kind`: money and counts SUM;
// rates/levels/percentages AVERAGE (summing a percentage or a concentration is
// meaningless). Unknown kinds fall back to sum.
function aggregate(values, kind) {
  if (!values.length) return 0;
  const sum = values.reduce((s, v) => s + Number(v || 0), 0);
  return kind === "percent" || kind === "number" ? sum / values.length : sum;
}

// One aggregated value per period for a metric, sorted chronologically.
function seriesFor(metrics, metric, kind) {
  const byPeriod = new Map();
  for (const r of metrics) {
    if (r.metric !== metric || !r.period) continue;
    if (!byPeriod.has(r.period)) byPeriod.set(r.period, []);
    byPeriod.get(r.period).push(r.value);
  }
  return [...byPeriod.entries()]
    .map(([period, values]) => ({ period, value: aggregate(values, kind) }))
    .sort((a, b) => periodKey(a.period) - periodKey(b.period));
}

// Sum values grouped by (period, category) for one metric (for breakdown charts).
// Period is kept so the client can scope a breakdown to the selected period
// instead of mixing every period/granularity together.
function breakdownFor(metrics, metric, kind) {
  const byKey = new Map();
  for (const r of metrics) {
    if (r.metric !== metric || !r.category) continue;
    const period = r.period || null;
    const key = `${period ?? ""}\u0000${r.category}`;
    const entry = byKey.get(key) || { label: r.category, values: [], period };
    entry.values.push(r.value);
    byKey.set(key, entry);
  }
  return [...byKey.values()]
    .map((e) => ({ label: e.label, period: e.period, value: aggregate(e.values, kind) }))
    .sort((a, b) => b.value - a.value);
}

function buildKpi(metrics, metric, currency, kind) {
  const series = seriesFor(metrics, metric, kind);
  if (series.length > 0) {
    const current = series[series.length - 1];
    const prev = series.length > 1 ? series[series.length - 2] : null;
    const deltaPct =
      prev && prev.value !== 0
        ? ((current.value - prev.value) / Math.abs(prev.value)) * 100
        : null;
    return {
      metric,
      value: current.value,
      period: current.period,
      delta_pct: deltaPct,
      currency,
    };
  }
  // No periodised data — fall back to the aggregate of all values (avg/sum by kind).
  const values = metrics.filter((r) => r.metric === metric).map((r) => r.value);
  return values.length
    ? { metric, value: aggregate(values, kind), period: null, delta_pct: null, currency }
    : null;
}

// Shape a flat list of document_metrics rows into the dashboard payload
// (kpis / series / breakdowns / kinds). Shared by the personal and department
// metrics endpoints — they differ only in WHICH rows they aggregate over.
function shapeMetrics(metrics) {
  const currencyCounts = {};
  for (const r of metrics) {
    if (r.currency) currencyCounts[r.currency] = (currencyCounts[r.currency] || 0) + 1;
  }
  const currency = Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

  const present = [...new Set(metrics.map((r) => r.metric))];
  const departments = {};
  const kinds = {};
  for (const r of metrics) {
    if (r.department && !departments[r.metric]) departments[r.metric] = r.department;
    if (r.kind && !kinds[r.metric]) kinds[r.metric] = r.kind;
  }

  const kpis = present
    .map((m) => {
      const kpi = buildKpi(metrics, m, currency, kinds[m]);
      return kpi ? { ...kpi, department: departments[m] || null, kind: kinds[m] || null } : null;
    })
    .filter(Boolean);

  const series = {};
  const breakdowns = {};
  for (const m of present) {
    const s = seriesFor(metrics, m, kinds[m]);
    if (s.length > 0) series[m] = s;
    const b = breakdownFor(metrics, m, kinds[m]);
    if (b.length > 0) breakdowns[m] = b;
  }

  const sources = [...new Set(metrics.map((r) => r.source_document))];
  return { kpis, series, breakdowns, departments, kinds, sources, currency, has_data: metrics.length > 0 };
}

// ── GET /api/dashboard/metrics ────────────────────────────────────────────────
// Returns computed KPIs / series / breakdowns for EVERY metric present in the
// user's included documents, each tagged with its department and value kind.
// Which of these actually renders is decided by the widgets on the dashboard;
// this endpoint just supplies the live numbers.
router.get("/metrics", requireAuth, async (req, res, next) => {
  try {
    return res.json(shapeMetrics(await getIncludedMetrics(req.user.id)));
  } catch (err) {
    return next(err);
  }
});

// ── Dashboards ──────────────────────────────────────────────────────────────
// A user can keep several personal dashboards to organise their pinned charts.
// One is the (undeletable) default; the rest are freely created/renamed/deleted.

// GET /api/dashboard/dashboards — list the user's personal dashboards.
router.get("/dashboards", requireAuth, async (req, res, next) => {
  try {
    const dashboards = await listDashboards(req.user.id, req.user.organization_id);
    return res.json({ dashboards });
  } catch (err) {
    return next(err);
  }
});

// POST /api/dashboard/dashboards — create a new (non-default) dashboard.
router.post("/dashboards", requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const dashboard = await createDashboard(req.user.id, req.user.organization_id, name);
    return res.status(201).json(dashboard);
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/dashboard/dashboards/:id — rename a dashboard.
router.patch("/dashboards/:id", requireAuth, async (req, res, next) => {
  try {
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const dashboard = await renameDashboard(req.user.id, req.params.id, name);
    if (!dashboard) return res.status(404).json({ message: "Dashboard not found" });
    return res.json(dashboard);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/dashboard/dashboards/:id — delete a non-default dashboard (its
// widgets cascade). The default dashboard can't be removed.
router.delete("/dashboards/:id", requireAuth, async (req, res, next) => {
  try {
    const deleted = await deleteDashboard(req.user.id, req.params.id);
    if (!deleted) {
      return res
        .status(400)
        .json({ message: "Can't delete this dashboard (default dashboards are permanent)." });
    }
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// ── Widgets ───────────────────────────────────────────────────────────────────
// A widget is a pinned AI chart (widget_type "ai_chart", config {spec}). Widget
// routes target a specific dashboard: list/add take a dashboard_id (defaulting
// to the user's default dashboard); per-widget routes authorize by owner across
// all the user's dashboards.

// Resolve the dashboard a request targets, enforcing ownership. `dashboard_id`
// may be absent (→ default dashboard). Throws a 404-tagged error if the given
// id isn't one of the user's dashboards.
async function resolveDashboard(req, dashboardId) {
  if (!dashboardId) {
    return getOrCreateDefaultDashboard(req.user.id, req.user.organization_id);
  }
  const dashboard = await getDashboardForUser(req.user.id, dashboardId);
  if (!dashboard) {
    const e = new Error("Dashboard not found");
    e.status = 404;
    throw e;
  }
  return dashboard;
}

// GET /api/dashboard/widgets?dashboard_id= — list one dashboard's widgets.
router.get("/widgets", requireAuth, async (req, res, next) => {
  try {
    const dashboard = await resolveDashboard(req, req.query.dashboard_id);
    return res.json({ dashboard_id: dashboard.id, widgets: await listWidgets(dashboard.id) });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// POST /api/dashboard/widgets — pin a widget (from the AI Assistant). Optional
// dashboard_id in the body chooses which dashboard to pin to.
router.post("/widgets", requireAuth, async (req, res, next) => {
  try {
    const {
      widget_type,
      title,
      config,
      position_x,
      position_y,
      width,
      height,
      ai_message_id,
      dashboard_id,
    } = req.body || {};
    if (widget_type !== "ai_chart" && widget_type !== "metric") {
      return res.status(400).json({ message: 'widget_type must be "ai_chart" or "metric"' });
    }
    if (!config || typeof config !== "object") {
      return res.status(400).json({ message: "config (object) is required" });
    }
    if (widget_type === "metric" && !config.metric_key) {
      return res.status(400).json({ message: "config.metric_key is required for a metric widget" });
    }
    const dashboard = await resolveDashboard(req, dashboard_id);

    // Idempotent add: charts key off the AI message; metric cards key off the
    // metric_key — one card per metric per board (restore a trashed one instead
    // of adding a second).
    if (widget_type === "ai_chart" && ai_message_id) {
      const existing = await findWidgetByMessage(dashboard.id, ai_message_id);
      if (existing) return res.status(200).json(existing);
    }
    if (widget_type === "metric") {
      const existing = await findMetricWidget(dashboard.id, config.metric_key);
      if (existing) {
        if (existing.archived_at) {
          return res.status(200).json(await setWidgetArchived(dashboard.id, existing.id, false));
        }
        return res.status(200).json(existing);
      }
    }

    const widget = await addWidget(dashboard.id, {
      widget_type,
      title: title ?? null,
      config,
      position_x,
      position_y,
      width,
      height,
      ai_message_id: ai_message_id ?? null,
    });
    return res.status(201).json(widget);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// PATCH /api/dashboard/widgets/:id — update a widget (title/config/position, or
// move it to another dashboard via dashboard_id). Authorized by owner.
router.patch("/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const widget = await getWidgetForUser(req.user.id, req.params.id);
    if (!widget) return res.status(404).json({ message: "Widget not found" });

    const allowed = {};
    for (const k of ["title", "config", "position_x", "position_y", "width", "height"]) {
      if (k in (req.body || {})) allowed[k] = req.body[k];
    }
    // Move to another of the user's dashboards.
    if (req.body?.dashboard_id && req.body.dashboard_id !== widget.personal_dashboard_id) {
      const target = await getDashboardForUser(req.user.id, req.body.dashboard_id);
      if (!target) return res.status(404).json({ message: "Target dashboard not found" });
      allowed.personal_dashboard_id = target.id;
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: "no updatable fields provided" });
    }
    const updated = await updateWidget(widget.personal_dashboard_id, req.params.id, allowed);
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/dashboard/widgets/:id — remove a widget (any of the user's dashboards).
router.delete("/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const widget = await getWidgetForUser(req.user.id, req.params.id);
    if (!widget) return res.status(404).json({ message: "Widget not found" });
    await deleteWidget(widget.personal_dashboard_id, req.params.id);
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// POST /api/dashboard/widgets/:id/refresh — regenerate a stale chart against the
// latest data (reruns the LLM via /visualize). Manual, so cost is user-triggered.
router.post("/widgets/:id/refresh", requireAuth, async (req, res, next) => {
  try {
    const widget = await refreshWidget(req.user.id, req.user.organization_id, req.params.id);
    return res.json(widget);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// ── Widget trash (recycle bin) ────────────────────────────────────────────────
// GET /api/dashboard/widgets/trash — the user's trashed widgets (metric + chart).
router.get("/widgets/trash", requireAuth, async (req, res, next) => {
  try {
    return res.json({ widgets: await listArchivedWidgetsForUser(req.user.id) });
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/recent-widgets?since=<iso> — metric widgets auto-added
// since a timestamp, so the client can toast "Added N metrics — Undo".
router.get("/recent-widgets", requireAuth, async (req, res, next) => {
  try {
    const since = req.query.since ? String(req.query.since) : null;
    return res.json({ widgets: await listRecentMetricWidgetsForUser(req.user.id, since) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/dashboard/widgets/:id/archive {archived} — trash or restore a widget.
router.patch("/widgets/:id/archive", requireAuth, async (req, res, next) => {
  try {
    const { archived } = req.body || {};
    if (typeof archived !== "boolean") {
      return res.status(400).json({ message: "archived (boolean) is required" });
    }
    const widget = await getWidgetForUser(req.user.id, req.params.id);
    if (!widget) return res.status(404).json({ message: "Widget not found" });
    const updated = await setWidgetArchived(widget.personal_dashboard_id, req.params.id, archived);
    return res.json(updated);
  } catch (err) {
    return next(err);
  }
});

// ── Metric definitions (create a metric, possibly before any data exists) ─────
// GET — the user's tracked metric definitions.
router.get("/metric-definitions", requireAuth, async (req, res, next) => {
  try {
    return res.json({ metric_definitions: await listMetricDefinitions("PERSONAL", req.user.id) });
  } catch (err) {
    return next(err);
  }
});

// POST — define a metric, place a (possibly empty) KPI widget for it on the
// default board, and backfill from already-uploaded docs in the background so
// existing data shows without a manual recompute.
router.post("/metric-definitions", requireAuth, async (req, res, next) => {
  try {
    const { label, description, kind } = req.body || {};
    if (!label || !String(label).trim()) {
      return res.status(400).json({ message: "label is required" });
    }
    const metricKey = String(req.body.metric_key || label)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 40);
    if (!metricKey) return res.status(400).json({ message: "could not derive a metric key from label" });

    const def = await createMetricDefinition("PERSONAL", req.user.id, req.user.organization_id, {
      metric_key: metricKey,
      label: String(label).trim(),
      description: description ?? null,
      kind: kind || "number",
    });

    // Put a metric widget on the requested board (defaulting to the user's
    // default board), idempotent / un-trashing an existing one.
    const board = await resolveDashboard(req, req.body.dashboard_id);
    const existing = await findMetricWidget(board.id, metricKey);
    if (existing) {
      if (existing.archived_at) await setWidgetArchived(board.id, existing.id, false);
    } else {
      await addWidget(board.id, {
        widget_type: "metric",
        title: def.label,
        config: { metric_key: metricKey, kind: def.kind, label: def.label },
      });
    }

    // Backfill: re-extract the user's existing docs so a just-defined metric
    // pulls values from files uploaded earlier. Background + best effort.
    listUploadedFileNames(req.user.id, req.user.organization_id)
      .then((sources) =>
        sources.reduce(
          (chain, s) =>
            chain.then(() =>
              extractAndStore(req.user.id, s, { organizationId: req.user.organization_id }).catch(() => {})
            ),
          Promise.resolve()
        )
      )
      .catch(() => {});

    return res.status(201).json(def);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// DELETE — remove a definition (its widget/data are managed via the trash).
router.delete("/metric-definitions/:id", requireAuth, async (req, res, next) => {
  try {
    await deleteMetricDefinition(req.params.id, req.user.id);
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

// ── Department dashboards ─────────────────────────────────────────────────────
// Shared boards scoped to a department. Employees VIEW their own department's
// board; managers EDIT only their OWN department's board (exact match, NOT the
// subtree — each team's manager owns their board), while org admins edit any.
// Managers also VIEW descendant boards for oversight. See
// departmentDashboardAccess.js for the exact rules. Board renames and per-widget
// edits/deletes are optimistic: the client passes the last-seen `version` and a
// stale write returns 409.

// Resolve a department widget and authorize the caller to EDIT it. Throws a
// status-tagged error (404 not-a-dept-widget / 403 no edit rights).
async function loadEditableDepartmentWidget(req) {
  const widget = await getWidgetOwner(req.params.id);
  if (!widget || !widget.department_dashboard_id) {
    const e = new Error("Widget not found");
    e.status = 404;
    throw e;
  }
  const board = await getDepartmentDashboard(widget.department_dashboard_id);
  if (!board) {
    const e = new Error("Widget not found");
    e.status = 404;
    throw e;
  }
  if (!canEditDepartmentBoard(req.user, board)) {
    const e = new Error("You don't have permission to edit this dashboard.");
    e.status = 403;
    throw e;
  }
  return { widget, board };
}

// GET /api/dashboard/department — the boards the caller can see, each tagged
// with can_edit so the UI knows whether to show edit controls.
router.get("/department", requireAuth, async (req, res, next) => {
  try {
    const user = req.user;
    const orgId = user.organization_id;
    const allDepts = await listDepartments(orgId);
    const deptNames = new Map(allDepts.map((d) => [d.id, d.name]));
    const visible = await viewableDepartmentIds(user, orgId, allDepts.map((d) => d.id));

    // Make sure the caller's own department has a board so they never hit an
    // empty state on their own team's dashboard.
    if (user.department_id && visible.has(user.department_id)) {
      await getOrCreateDefaultDepartmentDashboard(user.department_id, orgId, user.id);
    }

    const boards = await listDefaultDashboardsByDepartmentIds([...visible]);
    const shaped = boards
      .map((b) => ({
        id: b.id,
        name: b.name,
        department_id: b.department_id,
        department_name: deptNames.get(b.department_id) || "Department",
        version: b.version,
        updated_by_user_id: b.updated_by_user_id,
        updated_at: b.updated_at,
        can_edit: canEditDepartmentBoard(user, b),
      }))
      .sort((a, b) => a.department_name.localeCompare(b.department_name));
    return res.json({ dashboards: shaped });
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/department/:id/metrics — live KPI numbers for a department
// board, aggregated over every document shared to that department (view-gated).
router.get("/department/:id/metrics", requireAuth, async (req, res, next) => {
  try {
    const board = await getDepartmentDashboard(req.params.id);
    if (!board) return res.status(404).json({ message: "Dashboard not found" });
    if (!(await canViewDepartmentBoard(req.user, board))) {
      return res.status(403).json({ message: "You don't have access to this dashboard." });
    }
    const docIds = await documentIdsForDepartment(board.department_id);
    return res.json(shapeMetrics(await getMetricsForDocumentIds(docIds)));
  } catch (err) {
    return next(err);
  }
});

// GET /api/dashboard/department/:id/widgets — one board's widgets (view-gated).
router.get("/department/:id/widgets", requireAuth, async (req, res, next) => {
  try {
    const board = await getDepartmentDashboard(req.params.id);
    if (!board) return res.status(404).json({ message: "Dashboard not found" });
    if (!(await canViewDepartmentBoard(req.user, board))) {
      return res.status(403).json({ message: "You don't have access to this dashboard." });
    }
    return res.json({
      dashboard_id: board.id,
      version: board.version,
      can_edit: canEditDepartmentBoard(req.user, board),
      widgets: await listDepartmentWidgets(board.id),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/dashboard/department/:id/widgets — pin a chart (edit-gated).
// Idempotent by ai_message_id (concurrent pins of different charts both win).
router.post("/department/:id/widgets", requireAuth, async (req, res, next) => {
  try {
    const board = await getDepartmentDashboard(req.params.id);
    if (!board) return res.status(404).json({ message: "Dashboard not found" });
    if (!canEditDepartmentBoard(req.user, board)) {
      return res.status(403).json({ message: "You don't have permission to edit this dashboard." });
    }
    const { widget_type, title, config, ai_message_id } = req.body || {};
    if (widget_type !== "ai_chart" && widget_type !== "metric") {
      return res.status(400).json({ message: 'widget_type must be "ai_chart" or "metric"' });
    }
    if (!config || typeof config !== "object") {
      return res.status(400).json({ message: "config (object) is required" });
    }
    if (widget_type === "metric" && !config.metric_key) {
      return res.status(400).json({ message: "config.metric_key is required for a metric widget" });
    }
    if (widget_type === "ai_chart" && ai_message_id) {
      const existing = await findDeptWidgetByMessage(board.id, ai_message_id);
      if (existing) return res.status(200).json(existing);
    }
    if (widget_type === "metric") {
      const existing = await findDeptMetricWidget(board.id, config.metric_key);
      if (existing) return res.status(200).json(existing);
    }
    const widget = await addDepartmentWidget(board.id, {
      widget_type,
      title: title ?? null,
      config,
      ai_message_id: ai_message_id ?? null,
    });
    touchBoard(board.id, req.user.id);
    return res.status(201).json(widget);
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/dashboard/department/widgets/:id — edit a widget (edit-gated,
// version-guarded). Body must include expected_version.
router.patch("/department/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const { widget } = await loadEditableDepartmentWidget(req);
    const expectedVersion = req.body?.expected_version;
    if (!Number.isInteger(expectedVersion)) {
      return res.status(400).json({ message: "expected_version (integer) is required" });
    }
    const allowed = {};
    for (const k of ["title", "config", "position_x", "position_y", "width", "height"]) {
      if (k in (req.body || {})) allowed[k] = req.body[k];
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: "no updatable fields provided" });
    }
    const updated = await updateWidgetVersioned(widget.id, expectedVersion, allowed);
    touchBoard(widget.department_dashboard_id, req.user.id);
    return res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// DELETE /api/dashboard/department/widgets/:id?expected_version= — remove a
// widget (edit-gated, version-guarded).
router.delete("/department/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const { widget } = await loadEditableDepartmentWidget(req);
    const expectedVersion = Number(req.query.expected_version);
    if (!Number.isInteger(expectedVersion)) {
      return res.status(400).json({ message: "expected_version (integer) is required" });
    }
    await deleteWidgetVersioned(widget.id, expectedVersion);
    touchBoard(widget.department_dashboard_id, req.user.id);
    return res.json({ deleted: true });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// POST /api/dashboard/department/widgets/:id/refresh — regenerate a stale chart
// against the latest data (edit-gated, version-guarded). Body: expected_version.
router.post("/department/widgets/:id/refresh", requireAuth, async (req, res, next) => {
  try {
    const { widget } = await loadEditableDepartmentWidget(req);
    const expectedVersion = req.body?.expected_version;
    if (!Number.isInteger(expectedVersion)) {
      return res.status(400).json({ message: "expected_version (integer) is required" });
    }
    const updated = await refreshDepartmentWidget(widget, expectedVersion, req.user.id);
    return res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// PATCH /api/dashboard/department/:id — rename a board (edit-gated,
// version-guarded). Body: name, expected_version.
router.patch("/department/:id", requireAuth, async (req, res, next) => {
  try {
    const board = await getDepartmentDashboard(req.params.id);
    if (!board) return res.status(404).json({ message: "Dashboard not found" });
    if (!canEditDepartmentBoard(req.user, board)) {
      return res.status(403).json({ message: "You don't have permission to edit this dashboard." });
    }
    const name = (req.body?.name || "").trim();
    if (!name) return res.status(400).json({ message: "name is required" });
    const expectedVersion = req.body?.expected_version;
    if (!Number.isInteger(expectedVersion)) {
      return res.status(400).json({ message: "expected_version (integer) is required" });
    }
    const updated = await renameDepartmentDashboardVersioned(board.id, expectedVersion, name, req.user.id);
    return res.json(updated);
  } catch (err) {
    if (err.status) return res.status(err.status).json({ message: err.message });
    return next(err);
  }
});

// ── GET /api/dashboard/documents ──────────────────────────────────────────────
// Every indexed document plus its dashboard status (included flag + extraction
// state), so the UI can offer per-document include/exclude toggles.
router.get("/documents", requireAuth, async (req, res, next) => {
  try {
    const statuses = await listStatuses(req.user.id);
    const byName = new Map(statuses.map((s) => [s.source_document, s]));

    // Uploaded documents come from Supabase now (not the RAG service's Chroma index).
    const uploaded = await listUploadedFileNames(req.user.id, req.user.organization_id);

    const names = [...new Set([...uploaded, ...byName.keys()])];
    const documents = names.map((name) => {
      const s = byName.get(name);
      return {
        source_document: name,
        included: s ? s.included : true,
        status: s ? s.status : "unprocessed",
      };
    });

    return res.json({ documents });
  } catch (err) {
    return next(err);
  }
});

// ── PATCH /api/dashboard/documents/:source ────────────────────────────────────
// Toggle whether a document's data feeds the dashboard.
router.patch("/documents/:source", requireAuth, async (req, res, next) => {
  try {
    const { included } = req.body;
    if (typeof included !== "boolean") {
      return res.status(400).json({ message: "included (boolean) is required" });
    }
    await setIncluded(req.user.id, req.params.source, included);
    return res.json({ source_document: req.params.source, included });
  } catch (err) {
    return next(err);
  }
});

// ── DELETE /api/dashboard/documents/:source ───────────────────────────────────
// Remove ONE document everywhere: its extracted metrics + status (so it stops
// contributing to the dashboard) AND its file + vectors in the RAG service.
router.delete("/documents/:source", requireAuth, async (req, res, next) => {
  try {
    await deleteDocument(req.user.id, req.params.source);

    // Also remove the documents row (cascades document_chunks/tables in Supabase).
    try {
      const doc = await findDocByName(req.user.organization_id, req.params.source);
      if (doc) await deleteDocumentRow(doc.id, req.user.organization_id);
    } catch {
      /* document registry cleanup best-effort */
    }

    // Best-effort: also drop the file + vectors from the RAG service. If RAG is
    // down the metrics are still gone; the file can be cleared later.
    try {
      await fetch(`${RAG_URL}/documents/${encodeURIComponent(req.params.source)}`, {
        method: "DELETE",
      });
    } catch {
      /* RAG unavailable — dashboard data already removed */
    }
    return res.json({ deleted: true });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
