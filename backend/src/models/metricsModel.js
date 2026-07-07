// src/models/metricsModel.js
//
// Persistence for dashboard metrics extracted from uploaded documents, and the
// per-document status/include flag. All reads/writes are scoped to a user.

const supabase = require("../../supabase/supabase");

// Replace all stored metrics for one document with a freshly extracted set, and
// record the extraction status ('done' / 'empty'). `opts.documentId` /
// `opts.organizationId` tag each row so metrics can be aggregated by document
// ACCESS at any scope (personal / department / organization), not just user_id.
async function replaceDocumentMetrics(userId, source, metrics, opts = {}) {
  const { documentId = null, organizationId = null } = opts;
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
      document_id: documentId,
      organization_id: organizationId,
      metric: m.metric,
      department: m.department ?? null,
      kind: m.kind ?? null,
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

// Metrics for a set of documents (by document_id), for department/organization
// dashboards that aggregate across every document accessible at that scope.
// Rows predating the document_id backfill (null) are simply not returned here.
async function getMetricsForDocumentIds(documentIds) {
  if (!documentIds || documentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("document_metrics")
    .select("source_document, metric, department, kind, period, value, currency, category, confidence, document_id")
    .in("document_id", documentIds);
  if (error) throw error;
  return data || [];
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
    .select("source_document, metric, department, kind, period, value, currency, category, confidence")
    .eq("user_id", userId);
  if (error) throw error;

  return (data || []).filter((m) => !excluded.has(m.source_document));
}

// The status row for one (user, document), or null if the document is new to
// this user. Used to detect a re-upload of a same-named file.
async function getStatus(userId, source) {
  const { data, error } = await supabase
    .from("document_status")
    .select("source_document, included, status, updated_at")
    .eq("user_id", userId)
    .eq("source_document", source)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function deleteDocument(userId, source) {
  await supabase.from("document_metrics").delete().eq("user_id", userId).eq("source_document", source);
  await supabase.from("document_status").delete().eq("user_id", userId).eq("source_document", source);
}

// Wipe every stored metric/status for a user so the dashboard fully resets to
// "no data yet". Dashboard widgets (the pinned charts a user chose to display)
// are a separate concern - see dashboardModel.js - and are left alone here
// since they aren't extracted data.
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
  getStatus,
  getIncludedMetrics,
  getMetricsForDocumentIds,
  deleteDocument,
  clearAllForUser,
};
