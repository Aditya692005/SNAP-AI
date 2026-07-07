// src/services/metricsService.js
//
// Bridges the RAG service's metric extraction with Supabase storage. Used both
// when a document is uploaded (auto-extract) and when the user clicks Recompute.

const fetch = require("node-fetch");
const { replaceDocumentMetrics, upsertStatus } = require("../models/metricsModel");
const { listMetricDefinitions } = require("../models/metricDefinitionsModel");

const RAG_URL = process.env.RAG_SERVICE_URL || "http://localhost:8000";

// Extract metrics for one document from the RAG service and store them, tagged
// with the document/org so they aggregate at any dashboard scope. The user's
// tracked metric definitions steer extraction (the LLM looks for them).
// Returns { ok, count, metrics } — never throws, so callers (e.g. upload)
// aren't broken by extraction/quota failures; the document is marked 'error'.
async function extractAndStore(userId, source, opts = {}) {
  const { documentId = null, organizationId = null } = opts;
  try {
    // Best-effort: before metric_definitions is deployed this stays [] and
    // extraction is purely open-ended.
    let customMetrics = [];
    try {
      customMetrics = (await listMetricDefinitions("PERSONAL", userId)).map((d) => ({
        key: d.metric_key,
        label: d.label,
        kind: d.kind,
        description: d.description,
      }));
    } catch {
      /* metric_definitions table not available */
    }

    const response = await fetch(`${RAG_URL}/extract-metrics`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, custom_metrics: customMetrics }),
    });

    if (!response.ok) {
      await upsertStatus(userId, source, { status: "error" });
      return { ok: false, count: 0, metrics: [] };
    }

    const data = await response.json();
    const metrics = data.metrics || [];
    await replaceDocumentMetrics(userId, source, metrics, { documentId, organizationId });
    return { ok: true, count: metrics.length, metrics };
  } catch {
    try {
      await upsertStatus(userId, source, { status: "error" });
    } catch {
      // ignore — best effort
    }
    return { ok: false, count: 0, metrics: [] };
  }
}

module.exports = { extractAndStore };
