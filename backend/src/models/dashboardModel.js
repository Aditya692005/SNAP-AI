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
  "id, personal_dashboard_id, widget_type, title, config, position_x, position_y, width, height, ai_message_id, created_at, updated_at";

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

async function listWidgets(dashboardId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("personal_dashboard_id", dashboardId)
    .order("position_y", { ascending: true })
    .order("position_x", { ascending: true });
  if (error) throw error;
  return data || [];
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
  listWidgets,
  addWidget,
  updateWidget,
  deleteWidget,
  listWidgetsForUser,
};
