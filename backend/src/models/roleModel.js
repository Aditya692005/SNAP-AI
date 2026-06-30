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

module.exports = { findRoleByName, getPermissionsForRole };
