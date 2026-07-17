// src/models/organizationDashboardModel.js
//
// Organization dashboard: ONE shared board per organization. Everyone with
// VIEW_ORGANIZATION_DASHBOARD (org admins + managers by default) views it; org
// admins / MANAGE_ORGANIZATION_DASHBOARD holders edit it. Aggregates metrics
// across every document in the organization.
//
// Reuses the shared `dashboard_widgets` table (organization_dashboard_id owner
// column) so pinned charts/metric cards render identically to personal and
// department ones. The generic, owner-agnostic widget writes
// (getWidgetOwner / updateWidgetVersioned / deleteWidgetVersioned /
// updateWidgetConfigUnversioned) live in departmentDashboardModel.js and are
// reused as-is — this module only adds the org-board-specific reads/writes.
//
// Concurrency: multiple admins can edit the one board, so board rename and
// per-widget edit/delete are optimistic (carry the row's `version`, 409 on a
// stale write). Widget ADDs are idempotent (by ai_message_id / metric_key) and
// not version-guarded, mirroring department dashboards.

const supabase = require("../../supabase/supabase");

const BOARD_FIELDS =
  "id, organization_id, name, is_default, created_by_user_id, updated_by_user_id, version, created_at, updated_at";
const WIDGET_FIELDS =
  "id, personal_dashboard_id, department_dashboard_id, organization_dashboard_id, widget_type, title, config, position_x, position_y, width, height, ai_message_id, archived_at, version, created_at, updated_at";

function conflictError(message = "This board was changed by someone else. Refresh and try again.") {
  const e = new Error(message);
  e.status = 409;
  return e;
}

// The organization's default board, creating one on first use. Race-safe via the
// partial unique index on (organization_id) WHERE is_default (see
// add-organization-dashboards.sql): a concurrent insert loses with a 23505 unique
// violation and we re-select the winner — mirrors the department/personal boards.
async function getOrCreateDefaultOrganizationDashboard(organizationId, userId) {
  const { data: existing, error: selErr } = await supabase
    .from("organization_dashboards")
    .select(BOARD_FIELDS)
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .maybeSingle();
  if (selErr) throw selErr;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from("organization_dashboards")
    .insert({
      organization_id: organizationId,
      name: "Organization Dashboard",
      is_default: true,
      created_by_user_id: userId,
    })
    .select(BOARD_FIELDS)
    .single();
  if (!insErr) return created;
  if (insErr.code !== "23505") throw insErr;

  const { data: won, error: refetchErr } = await supabase
    .from("organization_dashboards")
    .select(BOARD_FIELDS)
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .single();
  if (refetchErr) throw refetchErr;
  return won;
}

// One board by id (null if absent). Used to re-check org ownership before an edit.
async function getOrganizationDashboard(dashboardId) {
  const { data, error } = await supabase
    .from("organization_dashboards")
    .select(BOARD_FIELDS)
    .eq("id", dashboardId)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listOrganizationWidgets(dashboardId) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("organization_dashboard_id", dashboardId)
    .is("archived_at", null)
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
    .eq("organization_dashboard_id", dashboardId)
    .eq("ai_message_id", aiMessageId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

// A metric widget for `metricKey` on the org board (live or trashed), or null —
// keeps adding a metric card idempotent per board.
async function findMetricWidget(dashboardId, metricKey) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("organization_dashboard_id", dashboardId)
    .eq("widget_type", "metric")
    .eq("config->>metric_key", metricKey)
    .limit(1);
  if (error) throw error;
  return (data && data[0]) || null;
}

async function addOrganizationWidget(
  dashboardId,
  { widget_type, title, config, position_x, position_y, width, height, ai_message_id }
) {
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .insert({
      organization_dashboard_id: dashboardId,
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

// Version-guarded board rename; also records who last edited it. Throws 409 on a
// stale version.
async function renameOrganizationDashboardVersioned(dashboardId, expectedVersion, name, userId) {
  const { data, error } = await supabase
    .from("organization_dashboards")
    .update({
      name: (name || "Organization Dashboard").slice(0, 255),
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

// Widgets on the org's default board (all, incl. archived), for the re-upload
// stale sweep. Returns [] when the org has no board yet.
async function listWidgetsForOrganization(organizationId) {
  const { data: board, error: bErr } = await supabase
    .from("organization_dashboards")
    .select("id")
    .eq("organization_id", organizationId)
    .eq("is_default", true)
    .maybeSingle();
  if (bErr) throw bErr;
  if (!board) return [];
  const { data, error } = await supabase
    .from("dashboard_widgets")
    .select(WIDGET_FIELDS)
    .eq("organization_dashboard_id", board.id);
  if (error) throw error;
  return data || [];
}

// Record who last touched the board (widget add/remove/refresh), for the "Last
// edited by …" hint. Does NOT bump `version` (widget ops are independent, so they
// must not falsely conflict a concurrent board edit). Best-effort — never throws.
async function touchBoard(dashboardId, userId) {
  try {
    await supabase
      .from("organization_dashboards")
      .update({ updated_by_user_id: userId, updated_at: new Date().toISOString() })
      .eq("id", dashboardId);
  } catch {
    /* audit-only; ignore */
  }
}

module.exports = {
  getOrCreateDefaultOrganizationDashboard,
  getOrganizationDashboard,
  listOrganizationWidgets,
  findWidgetByMessage,
  findMetricWidget,
  addOrganizationWidget,
  renameOrganizationDashboardVersioned,
  listWidgetsForOrganization,
  touchBoard,
};
