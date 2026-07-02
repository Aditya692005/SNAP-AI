// src/models/roleModel.js
// Roles and their permissions. The baseline roles (org_admin / manager /
// employee) are GLOBAL (organization_id IS NULL) and seeded by seed-roles.sql.

const supabase = require("../../supabase/supabase");

// Look up a global role by name. Used by signup (employee / org_admin) and by
// the admin console when an org_admin changes a user's role.
async function findRoleByName(name) {
  const { data, error } = await supabase
    .from("roles")
    .select("id, name")
    .eq("name", name)
    .is("organization_id", null)
    .single();
  if (error) return null;
  return data;
}

// The permission action strings granted to a role, e.g. ['UPLOAD_DOCUMENTS', ...].
// Drives both the JWT `permissions` claim and the requirePermission middleware.
async function getPermissionsForRole(roleId) {
  if (!roleId) return [];
  const { data, error } = await supabase
    .from("role_permissions")
    .select("permissions(action)")
    .eq("role_id", roleId);
  if (error) throw error;
  return (data || []).map((r) => r.permissions?.action).filter(Boolean);
}

// All permissions in the system (for the role-builder UI).
async function listPermissions() {
  const { data, error } = await supabase
    .from("permissions")
    .select("id, action, description")
    .order("action");
  if (error) throw error;
  return data || [];
}

// Roles assignable within an org: global (organization_id IS NULL) + the org's
// own custom roles, each with its permission action list.
async function listRolesForOrg(organizationId) {
  const { data, error } = await supabase
    .from("roles")
    .select("id, name, description, organization_id, role_permissions(permissions(action))")
    .or(`organization_id.is.null,organization_id.eq.${organizationId}`)
    .order("name");
  if (error) throw error;
  return (data || []).map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    is_global: r.organization_id === null,
    permissions: (r.role_permissions || [])
      .map((rp) => rp.permissions?.action)
      .filter(Boolean),
  }));
}

// A role the org is allowed to assign: either global or belonging to this org.
async function findAssignableRole(organizationId, roleId) {
  const { data, error } = await supabase
    .from("roles")
    .select("id, name, organization_id")
    .eq("id", roleId)
    .single();
  if (error || !data) return null;
  if (data.organization_id !== null && data.organization_id !== organizationId) return null;
  return data;
}

async function findRoleById(roleId) {
  const { data, error } = await supabase
    .from("roles")
    .select("id, name, organization_id")
    .eq("id", roleId)
    .single();
  if (error) return null;
  return data;
}

async function countUsersWithRole(roleId) {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("role_id", roleId);
  if (error) throw error;
  return count || 0;
}

async function deleteRole(roleId) {
  // role_permissions cascade on delete; users.role_id has no cascade, so the
  // caller must ensure no users still reference this role.
  const { error } = await supabase.from("roles").delete().eq("id", roleId);
  if (error) throw error;
}

async function createRole(organizationId, name, description, createdBy) {
  const { data, error } = await supabase
    .from("roles")
    .insert({
      organization_id: organizationId,
      name,
      description: description || null,
      created_by: createdBy,
    })
    .select("id, name, description, organization_id")
    .single();
  if (error) throw error;
  return data;
}

// Grant a role the given permission actions (idempotent).
async function addRolePermissions(roleId, actions) {
  if (!Array.isArray(actions) || actions.length === 0) return;
  const { data: perms, error: pErr } = await supabase
    .from("permissions")
    .select("id, action")
    .in("action", actions);
  if (pErr) throw pErr;
  const rows = (perms || []).map((p) => ({ role_id: roleId, permission_id: p.id }));
  if (rows.length === 0) return;
  const { error } = await supabase.from("role_permissions").insert(rows);
  if (error) throw error;
}

module.exports = {
  findRoleByName,
  getPermissionsForRole,
  listPermissions,
  listRolesForOrg,
  findAssignableRole,
  findRoleById,
  countUsersWithRole,
  deleteRole,
  createRole,
  addRolePermissions,
};
