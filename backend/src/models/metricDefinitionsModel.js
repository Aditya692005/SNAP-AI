// src/models/metricDefinitionsModel.js
//
// User-defined metric definitions — metrics a user (or department/org) chooses
// to TRACK, created from the AI chat or the dashboard, possibly BEFORE any
// document contains them. The definition persists and steers extraction (its
// description is fed to the LLM); a matching KPI widget renders it, filling in
// once data arrives. Scoped by (scope, owner_id): owner_id is a user id for
// PERSONAL, a department id for DEPARTMENT, an organization id for ORGANIZATION.

const supabase = require("../../supabase/supabase");

const FIELDS =
  "id, scope, owner_id, organization_id, metric_key, label, description, kind, created_at";

async function listMetricDefinitions(scope, ownerId) {
  const { data, error } = await supabase
    .from("metric_definitions")
    .select(FIELDS)
    .eq("scope", scope)
    .eq("owner_id", ownerId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Upsert on the (scope, owner_id, metric_key) unique key so asking for the same
// metric twice reflects the existing one instead of duplicating it.
async function createMetricDefinition(scope, ownerId, organizationId, { metric_key, label, description, kind }) {
  const { data, error } = await supabase
    .from("metric_definitions")
    .upsert(
      {
        scope,
        owner_id: ownerId,
        organization_id: organizationId,
        metric_key,
        label,
        description: description ?? null,
        kind: kind || "number",
      },
      { onConflict: "scope,owner_id,metric_key" }
    )
    .select(FIELDS)
    .single();
  if (error) throw error;
  return data;
}

async function deleteMetricDefinition(id, ownerId) {
  const { error } = await supabase
    .from("metric_definitions")
    .delete()
    .eq("id", id)
    .eq("owner_id", ownerId);
  if (error) throw error;
}

module.exports = {
  listMetricDefinitions,
  createMetricDefinition,
  deleteMetricDefinition,
};
