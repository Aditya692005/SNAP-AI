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
  listStatuses,
  setIncluded,
  deleteDocument,
} = require("../models/metricsModel");
const {
  getOrCreateDefaultDashboard,
  listWidgets,
  addWidget,
  updateWidget,
  deleteWidget,
} = require("../models/dashboardModel");
const {
  findByFileName: findDocByName,
  deleteDocument: deleteDocumentRow,
  listUploadedFileNames,
} = require("../models/documentModel");
const { refreshWidget } = require("../services/widgetRefreshService");

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

// Sum values per period for one metric, sorted chronologically.
function seriesFor(metrics, metric) {
  const byPeriod = new Map();
  for (const r of metrics) {
    if (r.metric !== metric || !r.period) continue;
    byPeriod.set(r.period, (byPeriod.get(r.period) || 0) + Number(r.value || 0));
  }
  return [...byPeriod.entries()]
    .map(([period, value]) => ({ period, value }))
    .sort((a, b) => periodKey(a.period) - periodKey(b.period));
}

// Sum values grouped by (period, category) for one metric (for breakdown charts).
// Period is kept so the client can scope a breakdown to the selected period
// instead of mixing every period/granularity together.
function breakdownFor(metrics, metric) {
  const byKey = new Map();
  for (const r of metrics) {
    if (r.metric !== metric || !r.category) continue;
    const period = r.period || null;
    const key = `${period ?? ""}\u0000${r.category}`;
    const entry = byKey.get(key) || { label: r.category, value: 0, period };
    entry.value += Number(r.value || 0);
    byKey.set(key, entry);
  }
  return [...byKey.values()].sort((a, b) => b.value - a.value);
}

function buildKpi(metrics, metric, currency) {
  const series = seriesFor(metrics, metric);
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
  // No periodised data — fall back to a plain total if any values exist.
  const total = metrics
    .filter((r) => r.metric === metric)
    .reduce((sum, r) => sum + Number(r.value || 0), 0);
  const has = metrics.some((r) => r.metric === metric);
  return has
    ? { metric, value: total, period: null, delta_pct: null, currency }
    : null;
}

// ── GET /api/dashboard/metrics ────────────────────────────────────────────────
// Returns computed KPIs / series / breakdowns for EVERY metric present in the
// user's included documents, each tagged with its department and value kind.
// Which of these actually renders is decided by the widgets on the dashboard;
// this endpoint just supplies the live numbers.
router.get("/metrics", requireAuth, async (req, res, next) => {
  try {
    const metrics = await getIncludedMetrics(req.user.id);

    // Most common currency wins for display.
    const currencyCounts = {};
    for (const r of metrics) {
      if (r.currency) currencyCounts[r.currency] = (currencyCounts[r.currency] || 0) + 1;
    }
    const currency =
      Object.entries(currencyCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    // Distinct metric keys actually present, plus the department/kind each maps to.
    const present = [...new Set(metrics.map((r) => r.metric))];
    const departments = {};
    const kinds = {};
    for (const r of metrics) {
      if (r.department && !departments[r.metric]) departments[r.metric] = r.department;
      if (r.kind && !kinds[r.metric]) kinds[r.metric] = r.kind;
    }

    const kpis = present
      .map((m) => {
        const kpi = buildKpi(metrics, m, currency);
        if (!kpi) return null;
        return { ...kpi, department: departments[m] || null, kind: kinds[m] || null };
      })
      .filter(Boolean);

    const series = {};
    const breakdowns = {};
    for (const m of present) {
      const s = seriesFor(metrics, m);
      if (s.length > 0) series[m] = s;
      const b = breakdownFor(metrics, m);
      if (b.length > 0) breakdowns[m] = b;
    }

    const sources = [...new Set(metrics.map((r) => r.source_document))];

    return res.json({
      kpis,
      series,
      breakdowns,
      departments,
      kinds,
      sources,
      currency,
      has_data: metrics.length > 0,
    });
  } catch (err) {
    return next(err);
  }
});

// ── Widgets ───────────────────────────────────────────────────────────────────
// A widget is a pinned AI chart (widget_type "ai_chart", config {spec}). All
// routes operate on the caller's default personal dashboard, created on demand.

// GET /api/dashboard/widgets — list the user's widgets.
router.get("/widgets", requireAuth, async (req, res, next) => {
  try {
    const dashboard = await getOrCreateDefaultDashboard(req.user.id, req.user.organization_id);
    return res.json({ widgets: await listWidgets(dashboard.id) });
  } catch (err) {
    return next(err);
  }
});

// POST /api/dashboard/widgets — pin a widget (from the AI Assistant).
router.post("/widgets", requireAuth, async (req, res, next) => {
  try {
    const { widget_type, title, config, position_x, position_y, width, height, ai_message_id } =
      req.body || {};
    if (widget_type !== "ai_chart") {
      return res.status(400).json({ message: 'widget_type must be "ai_chart"' });
    }
    if (!config || typeof config !== "object") {
      return res.status(400).json({ message: "config (object) is required" });
    }
    const dashboard = await getOrCreateDefaultDashboard(req.user.id, req.user.organization_id);
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
    return next(err);
  }
});

// PATCH /api/dashboard/widgets/:id — update a widget (title/config/position).
router.patch("/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const dashboard = await getOrCreateDefaultDashboard(req.user.id, req.user.organization_id);
    const allowed = {};
    for (const k of ["title", "config", "position_x", "position_y", "width", "height"]) {
      if (k in (req.body || {})) allowed[k] = req.body[k];
    }
    if (Object.keys(allowed).length === 0) {
      return res.status(400).json({ message: "no updatable fields provided" });
    }
    const widget = await updateWidget(dashboard.id, req.params.id, allowed);
    return res.json(widget);
  } catch (err) {
    return next(err);
  }
});

// DELETE /api/dashboard/widgets/:id — remove a widget.
router.delete("/widgets/:id", requireAuth, async (req, res, next) => {
  try {
    const dashboard = await getOrCreateDefaultDashboard(req.user.id, req.user.organization_id);
    await deleteWidget(dashboard.id, req.params.id);
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
