// src/models/departmentDashboardModel.js
//
// Department dashboards: a shared board scoped to a department. Employees of the
// department view it; the department's manager(s) and org admins edit it.
// Reuses the shared `dashboard_widgets` table (department_dashboard_id owner
// column) so pinned charts render identically to personal ones.
//
// Concurrency: multiple managers/admins can edit one board, so writes are
// optimistic — board renames and per-widget edits/deletes carry the row's
// `version` and are rejected with a 409-tagged error if it moved underneath
// them. Widget ADDS are intentionally NOT version-guarded: they're idempotent
// by ai_message_id and independent, so two managers pinning different charts
// must both succeed. (Personal dashboards keep last-write-wins — see
// dashboardModel.js — this versioning applies only to shared boards.)

const supabase = require("../../supabase/supabase");

const BOARD_FIELDS =
  "id, department_id, organization_id, name, is_default, created_by_user_id, updated_by_user_id, version, created_at, updated_at";
const WIDGET_FIELDS =
  "id, personal_dashboard_id, department_dashboard_id, organization_dashboard_id, widget_type, title, config, position_x, position_y, width, height, ai_message_id, version, created_at, updated_at";

function conflictError(message = "This board was changed by someone else. Refresh and try again.") {
  const e = new Error(message);
  e.status = 409;
  return e;
}

// The department's default board, creating one on first use. Race-safe via the
// partial unique index on (department_id) WHERE is_default (see
// add-department-dashboards.sql): a concurrent insert loses with a 23505 unique
// violation and we re-select the winner — mirrors getOrCreateDefaultDashboard.
async function getOrCreateDefaultDepartmentDashboard(departmentId, organizationId, userId) {
  const { data: existing, error: selErr } = await supabase
    .from("department_dashboards")
    .select(BOARD_FIELDS)
    .eq("department_id", departmentId)
    .eq("is_default", true)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from("department_dashboards")
    .insert({
      department_id: departmentId,
      organization_id: organizationId,
      name: "Department Dashboard",
      is_default: true,
      created_by_user_id: userId,
    })
    .select(BOARD_FIELDS)
    .single();
  if (!insErr) return created;
  if (insErr.code !== "23505") throw insErr;

  const { data: won, error: refetchErr } = await supabase
    .from("department_dashboards")
    .select(BOARD_FIELDS)
    .eq("department_id", departmentId)
    .eq("is_default", true)
    .single();
  if (refetchErr) throw refetchErr;
  return won;
}

// Existing default boards for a set of department ids (no creation). Used to
// list the boards a viewer can see across their visible departments.
async function listDefaultDashboardsByDepartmentIds(departmentIds) {
  if (!departmentIds || departmentIds.length === 0) return [];
  const { data, error } = await supabase
    .from("department_dashboards")
    .select(BOARD_FIELDS)
    .in("department_id", departmentIds)
    .eq("is_default", true);
  if (error) throw error;
  return data || [];
}

// One board by id (null if absent).
async function getDepartmentDashboard(dashboardId) {
  const { data, error } = await supabase
    .from("department_dashboards")
    .select(BOARD_FIELDS)
    .eq("id", dashboardId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listDepartmentWidgets(dashboardId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("department_dashboard_id", dashboardId)
    .order("position_y", { ascending: true })
    .order("position_x", { ascending: true });
  if (error) throw error;
  return data || [];
}

// Earliest widget on this board pinned from a given AI message, or null — keeps
// pinning idempotent (re-pinning the same chart returns the existing widget).
async function findWidgetByMessage(dashboardId, aiMessageId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("department_dashboard_id", dashboardId)
    .eq("ai_message_id", aiMessageId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function addDepartmentWidget(
  dashboardId,
  { widget_type, title, config, position_x, position_y, width, height, ai_message_id }
) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .insert({
      department_dashboard_id: dashboardId,
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

// One widget by id with ALL owner columns, so a route can tell which kind of
// dashboard it belongs to before authorizing. Null if absent.
async function getWidgetOwner(widgetId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("id", widgetId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Version-guarded widget update. Throws a 409-tagged error if the row's version
// moved (another editor got there first). `expectedVersion` comes from the
// client's last-seen copy.
async function updateWidgetVersioned(widgetId, expectedVersion, fields) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .update({ ...fields, version: expectedVersion + 1, updated_at: new Date().toISOString() })
    .eq("id", widgetId)
    .eq("version", expectedVersion)
    .select(WIDGET_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError();
  return data;
}

// Version-guarded widget delete. Throws 409 on a stale version.
async function deleteWidgetVersioned(widgetId, expectedVersion) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .delete()
    .eq("id", widgetId)
    .eq("version", expectedVersion)
    .select("id");
  if (error) throw error;
  if (!data || data.length === 0) throw conflictError();
  return true;
}

// Version-guarded board rename; also records who last edited it. Throws 409 on
// a stale version.
async function renameDepartmentDashboardVersioned(dashboardId, expectedVersion, name, userId) {
  const { data, error } = await supabase
    .from("department_dashboards")
    .update({
      name: (name || "Department Dashboard").slice(0, 255),
      updated_by_user_id: userId,
      version: expectedVersion + 1,
      updated_at: new Date().toISOString(),
    })
    .eq("id", dashboardId)
    .eq("version", expectedVersion)
    .select(BOARD_FIELDS)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw conflictError();
  return data;
}

// All department ai_chart widgets in an organization (with ai_message_id), for
// the re-upload stale sweep. Joins through the board to scope by org.
async function listDepartmentWidgetsForOrganization(organizationId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(`${WIDGET_FIELDS}, department_dashboards!inner(organization_id)`)
    .not("department_dashboard_id", "is", null)
    .eq("department_dashboards.organization_id", organizationId);
  if (error) throw error;
  return (data || []).map((w) => {
    delete w.department_dashboards; // strip the join artifact
    return w;
  });
}

// Plain (un-versioned) config write. Used by the system stale-flag sweep only:
// it must not bump `version` (that would spuriously conflict a manager who is
// mid-edit) and must not itself 409.
async function updateWidgetConfigUnversioned(widgetId, config) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .update({ config, updated_at: new Date().toISOString() })
    .eq("id", widgetId)
    .select(WIDGET_FIELDS)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Record who last touched a board (widget add/remove/refresh), for the
// "Last edited by …" hint. Deliberately does NOT bump `version`: widget
// operations are independent, so they must not make a concurrent board edit
// (or another widget op) falsely conflict. Best-effort — never throws.
async function touchBoard(dashboardId, userId) {
  try {
    await supabase
      .from("department_dashboards")
      .update({ updated_by_user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", dashboardId);
  } catch {
    /* audit-only; ignore */
  }
}

module.exports = {
  getOrCreateDefaultDepartmentDashboard,
  listDefaultDashboardsByDepartmentIds,
  getDepartmentDashboard,
  listDepartmentWidgets,
  findWidgetByMessage,
  addDepartmentWidget,
  getWidgetOwner,
  updateWidgetVersioned,
  deleteWidgetVersioned,
  renameDepartmentDashboardVersioned,
  listDepartmentWidgetsForOrganization,
  updateWidgetConfigUnversioned,
  touchBoard,
};
