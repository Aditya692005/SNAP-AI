// src/models/updateModel.js
//
// The in-app "Updates" feed (user_updates). One row = one notification for one
// recipient. Events that fan out to many people (a department/org share, a
// metric added to a shared board) create one row per affected user.
//
// Requires add-updates.sql. Every write here is BEST-EFFORT for its caller: the
// hooks that emit updates wrap these in try/catch so a missing table (migration
// not run) or a transient error never breaks the underlying action (sharing a
// document, adding a metric, answering a chat).

const supabase = require("../../supabase/supabase");
const { departmentSubtreeIds } = require("./departmentModel");

const VALID_TYPES = new Set([
  "document_shared",
  "document_retracted",
  "metric_added",
  "ai_response",
]);

// Insert one update row per recipient. Skips silently when there are no
// recipients (e.g. a document shared org-wide in a one-person org excludes the
// sharer, leaving nobody to notify).
async function createUpdatesForUsers(userIds, { organizationId, type, title, body, documentId, metadata } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (ids.length === 0) return [];
  if (!VALID_TYPES.has(type)) throw new Error(`unknown update type: ${type}`);

  const rows = ids.map((userId) => ({
    user_id: userId,
    organization_id: organizationId,
    type,
    title,
    body: body ?? null,
    document_id: documentId ?? null,
    metadata: metadata ?? null,
  }));
  const { data, error } = await supabase.from("user_updates").insert(rows).select("id");
  if (error) throw error;
  return data || [];
}

// The user's feed, newest first (default cap 50).
async function listUpdates(userId, { limit = 50 } = {}) {
  const { data, error } = await supabase
    .from("user_updates")
    .select("id, type, title, body, document_id, metadata, read_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data || [];
}

async function countUnread(userId) {
  const { count, error } = await supabase
    .from("user_updates")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) throw error;
  return count || 0;
}

// Mark a specific set of the user's updates read. The user_id filter makes it
// impossible to touch someone else's rows with a crafted id.
async function markRead(userId, ids) {
  const list = (ids || []).filter(Boolean);
  if (list.length === 0) return;
  const { error } = await supabase
    .from("user_updates")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .in("id", list)
    .is("read_at", null);
  if (error) throw error;
}

async function markAllRead(userId) {
  const { error } = await supabase
    .from("user_updates")
    .update({ read_at: new Date().toISOString() })
    .eq("user_id", userId)
    .is("read_at", null);
  if (error) throw error;
}

// ── Recipient resolution ──────────────────────────────────────────────────────
// Turn a sharing target into the set of ACTIVE user ids to notify, always scoped
// to the org and excluding the actor (you don't get notified about your own
// action). Mirrors the tiers in documentModel.grantAccess.
async function activeUserIds(query) {
  const { data, error } = await query.neq("status", "INACTIVE");
  if (error) throw error;
  return (data || []).map((u) => u.id);
}

async function recipientsForShareTarget(
  organizationId,
  { accessType, userId, departmentId, roleId },
  { excludeUserId } = {}
) {
  let ids = [];
  const base = () => supabase.from("users").select("id").eq("organization_id", organizationId);

  if (accessType === "USER" && userId) {
    ids = [userId];
  } else if (accessType === "DEPARTMENT" && departmentId) {
    // A department share reaches the department AND its sub-departments (the
    // same subtree that can actually see the document — see documentModel).
    let deptIds = [departmentId];
    try {
      const subtree = await departmentSubtreeIds(organizationId, departmentId);
      if (subtree.length > 0) deptIds = subtree;
    } catch {
      /* fall back to the exact department */
    }
    ids = await activeUserIds(base().in("department_id", deptIds));
  } else if (accessType === "ROLE" && roleId) {
    ids = await activeUserIds(base().eq("role_id", roleId));
  } else if (accessType === "ORGANIZATION") {
    ids = await activeUserIds(base());
  }

  return ids.filter((id) => id && id !== excludeUserId);
}

// Everyone who can see a department board = the department subtree's members.
async function recipientsForDepartment(organizationId, departmentId, { excludeUserId } = {}) {
  return recipientsForShareTarget(
    organizationId,
    { accessType: "DEPARTMENT", departmentId },
    { excludeUserId }
  );
}

// Everyone in the org (org board is visible org-wide for our purposes).
async function recipientsForOrganization(organizationId, { excludeUserId } = {}) {
  return recipientsForShareTarget(organizationId, { accessType: "ORGANIZATION" }, { excludeUserId });
}

module.exports = {
  createUpdatesForUsers,
  listUpdates,
  countUnread,
  markRead,
  markAllRead,
  recipientsForShareTarget,
  recipientsForDepartment,
  recipientsForOrganization,
};
