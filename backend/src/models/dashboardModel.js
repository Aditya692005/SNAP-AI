// src/models/dashboardModel.js
//
// Personal dashboard + widgets. A widget is a pinned AI chart:
// {widget_type: "ai_chart", config: {spec}} rendered from the stored chart spec.
// `ai_message_id` links the widget back to the AI message that generated it, so
// the chart can be regenerated against updated data (see the re-upload refresh).
// Replaces the old flat metric_prefs/dashboard_charts tables.

const supabase = require("../../supabase/supabase");

const DASHBOARD_FIELDS = "id, user_id, organization_id, name, is_default, created_at, updated_at";
const WIDGET_FIELDS =
  "id, personal_dashboard_id, widget_type, title, config, position_x, position_y, width, height, ai_message_id, archived_at, created_at, updated_at";

// Fetch the user's default personal dashboard, creating one on first use.
// Relies on the partial unique index on (user_id) WHERE is_default to stay
// race-safe: if two requests insert concurrently, the loser's insert fails
// with a unique violation and we just re-select the winner's row.
async function getOrCreateDefaultDashboard(userId, organizationId) {
  const { data: existing, error: selErr } = await supabase
    .from("personal_dashboards")
    .select(DASHBOARD_FIELDS)
    .eq("user_id", userId)
    .eq("is_default", true)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from("personal_dashboards")
    .insert({ user_id: userId, organization_id: organizationId, name: "My Dashboard", is_default: true })
    .select(DASHBOARD_FIELDS)
    .single();
  if (!insErr) return created;
  if (insErr.code !== "23505") throw insErr;

  const { data: won, error: refetchErr } = await supabase
    .from("personal_dashboards")
    .select(DASHBOARD_FIELDS)
    .eq("user_id", userId)
    .eq("is_default", true)
    .single();
  if (refetchErr) throw refetchErr;
  return won;
}

// All of a user's personal dashboards, default first then oldest-first. Ensures
// the default exists so the list is never empty.
async function listDashboards(userId, organizationId) {
  await getOrCreateDefaultDashboard(userId, organizationId);
  const { data, error } = await supabase
    .from("personal_dashboards")
    .select(DASHBOARD_FIELDS)
    .eq("user_id", userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Create an additional (non-default) personal dashboard.
async function createDashboard(userId, organizationId, name) {
  const { data, error } = await supabase
    .from("personal_dashboards")
    .insert({
      user_id: userId,
      organization_id: organizationId,
      name: (name || "Untitled dashboard").slice(0, 255),
      is_default: false,
    })
    .select(DASHBOARD_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

// One dashboard by id, scoped to its owner (null if not owned). Ownership check
// for every per-dashboard operation.
async function getDashboardForUser(userId, dashboardId) {
  const { data, error } = await supabase
    .from("personal_dashboards")
    .select(DASHBOARD_FIELDS)
    .eq("id", dashboardId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Rename a dashboard the user owns; returns the updated row (null if not owned).
async function renameDashboard(userId, dashboardId, name) {
  const { data, error } = await supabase
    .from("personal_dashboards")
    .update({ name: (name || "Untitled dashboard").slice(0, 255), updated_at: new Date().toISOString() })
    .eq("id", dashboardId)
    .eq("user_id", userId)
    .select(DASHBOARD_FIELDS)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Delete a non-default dashboard the user owns (its widgets cascade). The
// default dashboard can't be deleted — returns false if the row didn't match
// (not owned, or is_default).
async function deleteDashboard(userId, dashboardId) {
  const { data, error } = await supabase
    .from("personal_dashboards")
    .delete()
    .eq("id", dashboardId)
    .eq("user_id", userId)
    .eq("is_default", false)
    .select("id");
  if (error) throw error;
  return (data || []).length > 0;
}

// Live widgets on a dashboard (archived/trashed ones excluded).
async function listWidgets(dashboardId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("personal_dashboard_id", dashboardId)
    .is("archived_at", null)
    .order("position_y", { ascending: true })
    .order("position_x", { ascending: true });
  if (error) throw error;
  return data || [];
}

// All of the user's trashed widgets, across their dashboards (for the trash UI).
async function listArchivedWidgetsForUser(userId) {
  const { data: dashes, error: dErr } = await supabase
    .from("personal_dashboards")
    .select("id")
    .eq("user_id", userId);
  if (dErr) throw dErr;
  const ids = (dashes || []).map((d) => d.id);
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .in("personal_dashboard_id", ids)
    .not("archived_at", "is", null)
    .order("archived_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// Permanently delete EVERY trashed widget across the user's boards (empty trash).
// Returns the number removed.
async function deleteArchivedWidgetsForUser(userId) {
  const { data: dashes, error: dErr } = await supabase
    .from("personal_dashboards")
    .select("id")
    .eq("user_id", userId);
  if (dErr) throw dErr;
  const ids = (dashes || []).map((d) => d.id);
  if (ids.length === 0) return 0;
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .delete()
    .in("personal_dashboard_id", ids)
    .not("archived_at", "is", null)
    .select("id");
  if (error) throw error;
  return (data || []).length;
}

// Recently auto-added metric widgets across the user's boards, for the
// "added metrics — undo" toast. `sinceIso` bounds it to the last upload.
async function listRecentMetricWidgetsForUser(userId, sinceIso) {
  const { data: dashes, error: dErr } = await supabase
    .from("personal_dashboards")
    .select("id")
    .eq("user_id", userId);
  if (dErr) throw dErr;
  const ids = (dashes || []).map((d) => d.id);
  if (ids.length === 0) return [];
  let q = supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .in("personal_dashboard_id", ids)
    .eq("widget_type", "metric")
    .is("archived_at", null)
    .order("created_at", { ascending: false });
  if (sinceIso) q = q.gte("created_at", sinceIso);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// A metric widget for `metricKey` on this dashboard (live or trashed), or null.
// Keeps auto-add / manual-add idempotent — one card per metric per board.
async function findMetricWidget(dashboardId, metricKey) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("personal_dashboard_id", dashboardId)
    .eq("widget_type", "metric")
    .eq("config->>metric_key", metricKey)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// Metric keys that already have a widget on this dashboard (live OR trashed), so
// auto-add never re-creates a card the user removed.
async function metricKeysOnDashboard(dashboardId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select("config")
    .eq("personal_dashboard_id", dashboardId)
    .eq("widget_type", "metric");
  if (error) throw error;
  return new Set((data || []).map((w) => w.config?.metric_key).filter(Boolean));
}

// Archive (trash) or restore a widget the user owns.
async function setWidgetArchived(dashboardId, widgetId, archived) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .update({ archived_at: archived ? new Date().toISOString() : null, updated_at: new Date().toISOString() })
    .eq("id", widgetId)
    .eq("personal_dashboard_id", dashboardId)
    .select(WIDGET_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

// The earliest widget on this dashboard pinned from a given AI message, or null.
// Used to keep pinning idempotent: re-pinning the same chart returns the
// existing widget instead of creating a duplicate. Tolerant of pre-existing
// duplicates (returns the first) rather than erroring like .single() would.
async function findWidgetByMessage(dashboardId, aiMessageId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("personal_dashboard_id", dashboardId)
    .eq("ai_message_id", aiMessageId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function addWidget(
  dashboardId,
  { widget_type, title, config, position_x, position_y, width, height, ai_message_id }
) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .insert({
      personal_dashboard_id: dashboardId,
      widget_type,
      title: title ?? null,
      config: config ?? null,
      position_x: position_x ?? 0,
      position_y: position_y ?? 0,
      width: width ?? 1,
      height: height ?? 1,
      ai_message_id: ai_message_id ?? null,
    })
    .select(WIDGET_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

async function updateWidget(dashboardId, widgetId, fields) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", widgetId)
    .eq("personal_dashboard_id", dashboardId)
    .select(WIDGET_FIELDS)
    .single();
  if (error) throw error;
  return data;
}

async function deleteWidget(dashboardId, widgetId) {
  const { error } = await supabase
    .from("dashboard_widgets")
    .delete()
    .eq("id", widgetId)
    .eq("personal_dashboard_id", dashboardId);
  if (error) throw error;
}

// One widget by id, scoped to its owner across ALL their dashboards (null if
// not owned). Lets per-widget routes/refresh authorize by user without first
// knowing which dashboard the widget lives on. The returned row includes
// personal_dashboard_id (in WIDGET_FIELDS) so callers can scope the follow-up
// update/delete to the right dashboard.
async function getWidgetForUser(userId, widgetId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(`${WIDGET_FIELDS}, personal_dashboards!inner(user_id)`)
    .eq("id", widgetId)
    .eq("personal_dashboards.user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  delete data.personal_dashboards; // strip the join artifact
  return data;
}

// Widgets for a user (across their personal dashboard) whose source AI message
// referenced a given document filename. Used by the re-upload refresh to mark
// affected charts stale. Joins through ai_messages.metadata.sources.
async function listWidgetsForUser(userId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(`${WIDGET_FIELDS}, personal_dashboards!inner(user_id)`)
    .eq("personal_dashboards.user_id", userId);
  if (error) throw error;
  return data || [];
}

module.exports = {
  getOrCreateDefaultDashboard,
  listDashboards,
  createDashboard,
  getDashboardForUser,
  renameDashboard,
  deleteDashboard,
  listWidgets,
  listArchivedWidgetsForUser,
  deleteArchivedWidgetsForUser,
  listRecentMetricWidgetsForUser,
  findWidgetByMessage,
  findMetricWidget,
  metricKeysOnDashboard,
  setWidgetArchived,
  getWidgetForUser,
  addWidget,
  updateWidget,
  deleteWidget,
  listWidgetsForUser,
};
