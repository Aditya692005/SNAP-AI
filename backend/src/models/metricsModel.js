// src/models/metricsModel.js
//
// Persistence for dashboard metrics extracted from uploaded documents, and the
// per-document status/include flag. All reads/writes are scoped to a user.

const supabase = require("../../supabase/supabase");

// Replace all stored metrics for one document with a freshly extracted set, and
// record the extraction status ('done' / 'empty').
async function replaceDocumentMetrics(userId, source, metrics) {
  const { error: delErr } = await supabase
    .from("document_metrics")
    .delete()
    .eq("user_id", userId)
    .eq("source_document", source);
  if (delErr) throw delErr;

  if (metrics.length > 0) {
    const rows = metrics.map((m) => ({
      user_id: userId,
      source_document: source,
      metric: m.metric,
      department: m.department ?? null,
      period: m.period ?? null,
      value: m.value,
      currency: m.currency ?? null,
      category: m.category ?? null,
      confidence: m.confidence ?? null,
    }));
    const { error: insErr } = await supabase.from("document_metrics").insert(rows);
    if (insErr) throw insErr;
  }

  await upsertStatus(userId, source, {
    status: metrics.length > 0 ? "done" : "empty",
  });
}

// Upsert the status row for a document (keeps `included` unless overridden).
async function upsertStatus(userId, source, fields) {
  const { error } = await supabase
    .from("document_status")
    .upsert(
      {
        user_id: userId,
        source_document: source,
        updated_at: new Date().toISOString(),
        ...fields,
      },
      { onConflict: "user_id,source_document" }
    );
  if (error) throw error;
}

async function setIncluded(userId, source, included) {
  await upsertStatus(userId, source, { included });
}

async function listStatuses(userId) {
  const { data, error } = await supabase
    .from("document_status")
    .select("source_document, included, status, updated_at")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

// Metrics belonging only to documents the user has left included in the dashboard.
async function getIncludedMetrics(userId) {
  const statuses = await listStatuses(userId);
  const excluded = new Set(
    statuses.filter((s) => s.included === false).map((s) => s.source_document)
  );

  const { data, error } = await supabase
    .from("document_metrics")
    .select("source_document, metric, department, period, value, currency, category, confidence")
    .eq("user_id", userId);
  if (error) throw error;

  return (data || []).filter((m) => !excluded.has(m.source_document));
}

// ── Metric display preferences (which metrics show on the dashboard) ──────────
// Visibility is independent of extraction: hidden metrics are still extracted
// and kept up to date from uploads, just not rendered until the user enables them.
async function listMetricPrefs(userId) {
  const { data, error } = await supabase
    .from("metric_prefs")
    .select("metric, visible")
    .eq("user_id", userId);
  if (error) throw error;
  return data || [];
}

async function setMetricVisible(userId, metric, visible) {
  const { error } = await supabase
    .from("metric_prefs")
    .upsert(
      { user_id: userId, metric, visible, updated_at: new Date().toISOString() },
      { onConflict: "user_id,metric" }
    );
  if (error) throw error;
}

async function deleteDocument(userId, source) {
  await supabase.from("document_metrics").delete().eq("user_id", userId).eq("source_document", source);
  await supabase.from("document_status").delete().eq("user_id", userId).eq("source_document", source);
}

// ── Pinned charts (AI-generated charts the user displays on the dashboard) ────
async function listCharts(userId) {
  const { data, error } = await supabase
    .from("dashboard_charts")
    .select("id, title, spec, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

async function addChart(userId, title, spec) {
  const { data, error } = await supabase
    .from("dashboard_charts")
    .insert({ user_id: userId, title: title ?? null, spec })
    .select("id, title, spec, created_at")
    .single();
  if (error) throw error;
  return data;
}

async function deleteChart(userId, id) {
  const { error } = await supabase
    .from("dashboard_charts")
    .delete()
    .eq("user_id", userId)
    .eq("id", id);
  if (error) throw error;
}

// Wipe every stored metric/status for a user so the dashboard resets to "no data
// yet". Display preferences (metric_prefs) are intentionally kept.
async function clearAllForUser(userId) {
  const { error: mErr } = await supabase
    .from("document_metrics")
    .delete()
    .eq("user_id", userId);
  if (mErr) throw mErr;
  const { error: sErr } = await supabase
    .from("document_status")
    .delete()
    .eq("user_id", userId);
  if (sErr) throw sErr;
}

module.exports = {
  replaceDocumentMetrics,
  upsertStatus,
  setIncluded,
  listStatuses,
  getIncludedMetrics,
  listMetricPrefs,
  setMetricVisible,
  listCharts,
  addChart,
  deleteChart,
  deleteDocument,
  clearAllForUser,
};
