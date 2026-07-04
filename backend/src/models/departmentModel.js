// src/models/departmentModel.js
// CRUD for organisational departments. v2 departments are per-organization
// (uuid id, organization_id, name, description) - the old global `key` column
// is gone, so every query is scoped to an organization.

const supabase = require("../../supabase/supabase");

async function listDepartments(organizationId) {
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, description")
    .eq("organization_id", organizationId)
    .order("name");
  if (error) throw error;
  return data || [];
}

async function findDepartmentById(id) {
  const { data, error } = await supabase
    .from("departments")
    .select("id, name, description, organization_id")
    .eq("id", id)
    .single();
  if (error) return null;
  return data;
}

async function createDepartment(organizationId, name, description = null) {
  const { data, error } = await supabase
    .from("departments")
    .insert({ organization_id: organizationId, name, description })
    .select("id, name, description")
    .single();
  if (error) throw error;
  return data;
}

// Edit a department's name/description, scoped to the org so one tenant can't
// edit another's. Only provided keys change.
async function updateDepartment(id, organizationId, fields) {
  const patch = {};
  if ("name" in fields) patch.name = fields.name;
  if ("description" in fields) patch.description = fields.description;
  if (Object.keys(patch).length === 0) return null;
  const { data, error } = await supabase
    .from("departments")
    .update(patch)
    .eq("id", id)
    .eq("organization_id", organizationId)
    .select("id, name, description")
    .single();
  if (error) throw error;
  return data;
}

// Number of still-active users in a department - used to block deletion of a
// non-empty department.
async function countUsersInDepartment(id) {
  const { count, error } = await supabase
    .from("users")
    .select("id", { count: "exact", head: true })
    .eq("department_id", id)
    .neq("status", "INACTIVE");
  if (error) throw error;
  return count || 0;
}

// Move every user from one department to another (used when deleting a dept).
async function reassignDepartmentUsers(fromDeptId, toDeptId) {
  const { error } = await supabase
    .from("users")
    .update({ department_id: toDeptId })
    .eq("department_id", fromDeptId);
  if (error) throw error;
}

// Deactivate the (still-active) users in a department (the alternative to
// reassigning them when deleting a dept).
async function deactivateDepartmentUsers(deptId) {
  const { error } = await supabase
    .from("users")
    .update({ status: "INACTIVE" })
    .eq("department_id", deptId)
    .neq("status", "INACTIVE");
  if (error) throw error;
}

async function deleteDepartment(id) {
  const { error } = await supabase.from("departments").delete().eq("id", id);
  if (error) throw error;
}

// A department plus all of its descendants (departments.parent_id tree),
// scoped to one org. Drives manager-level sharing/visibility: a manager
// governs the subtree rooted at their own department. Fetches the org's
// departments once and walks the tree in JS (orgs are small). Returns [] when
// rootDeptId is null/absent from the org.
async function departmentSubtreeIds(organizationId, rootDeptId) {
  if (!rootDeptId) return [];
  const { data, error } = await supabase
    .from("departments")
    .select("id, parent_id")
    .eq("organization_id", organizationId);
  if (error) throw error;

  const childrenOf = new Map();
  let rootExists = false;
  for (const d of data || []) {
    if (d.id === rootDeptId) rootExists = true;
    if (d.parent_id) {
      if (!childrenOf.has(d.parent_id)) childrenOf.set(d.parent_id, []);
      childrenOf.get(d.parent_id).push(d.id);
    }
  }
  if (!rootExists) return [];

  const ids = [];
  const queue = [rootDeptId];
  const seen = new Set(); // guard against parent_id cycles from bad data
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    queue.push(...(childrenOf.get(id) || []));
  }
  return ids;
}

module.exports = {
  listDepartments,
  findDepartmentById,
  createDepartment,
  updateDepartment,
  countUsersInDepartment,
  reassignDepartmentUsers,
  deactivateDepartmentUsers,
  deleteDepartment,
  departmentSubtreeIds,
};
